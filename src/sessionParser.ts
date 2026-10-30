/**
 * JSONL parsing and cost computation for VS Code debug-logs, chatSessions,
 * and Copilot CLI / Agent Host session-state logs.
 */

import * as fs from "fs";
import * as path from "path";
import {
  canonicalModel, findPricing, vendorFor, ASSUMED_CACHE_RATIO,
  ModelProvider, providerForKey, resolveModelMatch, stripProviderPrefix,
  getPricing, getPricingStatus, getCreditSettings,
} from "./pricing";
import { SessionRecord, findAllSessions, getLatestSession, findSessionById, findChatSessionFile } from "./sessionDiscovery";

// ── Types ──────────────────────────────────────────────────────────────

export interface CallRecord {
  /** 1-based call index within the entire session */
  seq: number;
  /** Canonical model key */
  model: string;
  /** Provider source ("copilot" | "ollama") */
  provider?: ModelProvider;
  /** debugName from attrs (e.g. "panel/editAgent", "summarizeConversationHistory") */
  debugName: string;
  /** Total input tokens sent */
  inputTokens: number;
  /** Cached input tokens from server response. -1 if field absent. */
  cachedTokens: number;
  /** Fresh (non-cached) input tokens = inputTokens - max(0, cachedTokens) */
  freshTokens: number;
  /** Cache write tokens */
  cacheWriteTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cache hit ratio 0-100, or null if cachedTokens was absent */
  cacheHitPct: number | null;
  /** Computed cost for this single call */
  cost: number;
  /** Whether this call is from a subagent file */
  isSubagent: boolean;
  /** Time to first token in ms (from attrs.ttft), or null */
  ttft: number | null;
  /** Wall-clock timestamp in ms since epoch (top-level `ts` field), or null */
  ts: number | null;
}

export interface TurnRecord {
  /** 1-based user turn number. 0 = before first user message (Setup/System). */
  turn: number;
  /** Number of LLM calls in this turn */
  calls: number;
  /** Aggregated totals */
  inputTokens: number;
  cachedTokens: number;
  freshTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Turn-level cache hit ratio 0-100 */
  cacheHitPct: number;
  cost: number;
  /** Whether a summarization call occurred in this turn */
  hasSummarization: boolean;
  /** Timestamp of first call in this turn (ms), or null */
  firstTs: number | null;
  /** Timestamp of last call in this turn (ms), or null */
  lastTs: number | null;
  /** Individual call records */
  callRecords: CallRecord[];
  /** Tool call records in this turn */
  toolCalls: ToolCallRecord[];
  /** Custom agent labels invoked in this turn (from child_session_ref) */
  agentRefs: string[];
  /** First user message text for this turn, or null */
  userMessage: string | null;
}

export interface ToolCallRecord {
  /** Tool name (e.g. "read_file", "run_in_terminal") */
  name: string;
  /** Wall-clock timestamp in ms since epoch, or null */
  ts: number | null;
  /** Duration in ms, or null */
  dur: number | null;
  /** Status string (e.g. "ok") */
  status: string;
}

export interface SessionDeepDive {
  turns: TurnRecord[];
  totals: {
    turns: number;
    calls: number;
    inputTokens: number;
    cachedTokens: number;
    freshTokens: number;
    outputTokens: number;
    cacheHitPct: number;
    cost: number;
  };
}

export interface SessionContext {
  /** Primary mode derived from debugName (e.g. "Agent", "Chat", "Edit") */
  agentMode: string;
  /** Custom agent names available in the session (from discovery) */
  agents: string[];
  /** Instruction file names loaded at session start */
  instructions: string[];
  /** Skill names available in the session (from Skill Discovery) */
  skills: string[];
  /** Slash commands available in the session (from Slash Commands Discovery) */
  slashCommands: string[];
  /** Skill names the model actually read (from read_file calls on skill files) */
  skillsInvoked: string[];
  /** Custom agents actually invoked as child sessions (label from child_session_ref) */
  customAgentsInvoked: string[];
  /** Resolved file paths for each skill (name → absolute path) */
  skillPaths: Record<string, string>;
  /** Resolved file paths for each slash command (name → absolute path) */
  slashCommandPaths: Record<string, string>;
  /** Resolved file paths for each agent (name → absolute path) */
  agentPaths: Record<string, string>;
  /** Resolved file paths for each instruction (name → absolute path) */
  instructionPaths: Record<string, string>;
  /** Turn number when each skill was first seen in discovery (1-based) */
  skillsFirstTurn: Record<string, number>;
  /** Turn number when each agent was first seen in discovery (1-based) */
  agentsFirstTurn: Record<string, number>;
  /** Turn number when each instruction was first seen in discovery (1-based) */
  instructionsFirstTurn: Record<string, number>;
  /** Skills actually used in each turn (derived from read_file calls on skill files) */
  skillsByTurn: Record<string, string[]>;
  /** Instructions applied to each turn (from Resolve Customizations) */
  instructionsByTurn: Record<string, string[]>;
}

// ── ChatSession (.jsonl) Delta Parser ──────────────────────────────────

export interface ChatSessionRequest {
  requestId: string;
  timestamp: number;
  rawModel: string;
  promptTokens: number;
  completionTokens: number;
  messageText: string;
  elapsedMs?: number;
  isComplete: boolean;
}

function locateChatSessionPath(sessionDirOrFile: string): string | undefined {
  if (!sessionDirOrFile) { return undefined; }
  if (sessionDirOrFile.endsWith(".jsonl") && fs.existsSync(sessionDirOrFile)) {
    return sessionDirOrFile;
  }
  const sid = path.basename(sessionDirOrFile);
  // sessionDir = {wsDir}/GitHub.copilot-chat/debug-logs/{sid}
  const wsDir = path.dirname(path.dirname(path.dirname(sessionDirOrFile)));
  const found = findChatSessionFile(wsDir, sid);
  if (found) { return found; }
  const localFallback = path.join(sessionDirOrFile, "chatSession.jsonl");
  if (fs.existsSync(localFallback)) { return localFallback; }
  return undefined;
}

export function parseChatSessionRequests(chatSessionPath: string): ChatSessionRequest[] {
  if (!chatSessionPath || !fs.existsSync(chatSessionPath)) {
    return [];
  }
  let content: string;
  try {
    content = fs.readFileSync(chatSessionPath, "utf-8");
  } catch {
    return [];
  }

  // Reconstruct the mutable requests array across kind=0 (init), kind=2 (append), and kind=1 (property patch)
  const rawRequests: any[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) { continue; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.kind === 0 && entry.v) {
      if (Array.isArray(entry.v.requests)) {
        rawRequests.length = 0;
        for (const r of entry.v.requests) {
          rawRequests.push(r && typeof r === "object" ? { ...r } : {});
        }
      }
    } else if (entry.kind === 2 && Array.isArray(entry.k) && entry.k.length === 1 && entry.k[0] === "requests") {
      const items = Array.isArray(entry.v) ? entry.v : [];
      for (const r of items) {
        if (r && typeof r === "object" && (r.requestId || r.modelId || r.message)) {
          rawRequests.push({ ...r });
        }
      }
    } else if (entry.kind === 1 && Array.isArray(entry.k) && entry.k[0] === "requests" && typeof entry.k[1] === "number") {
      const idx = entry.k[1];
      while (rawRequests.length <= idx) {
        rawRequests.push({});
      }
      const target = rawRequests[idx];
      if (entry.k.length === 2 && entry.v && typeof entry.v === "object") {
        Object.assign(target, entry.v);
      } else if (entry.k.length === 3 && typeof entry.k[2] === "string") {
        target[entry.k[2]] = entry.v;
      }
    }
  }

  const byId = new Map<string, ChatSessionRequest>();
  let anonCounter = 0;

  for (const r of rawRequests) {
    if (!r || typeof r !== "object") { continue; }
    const rawModelId = typeof r.modelId === "string" ? r.modelId.trim() : "";
    const resolvedModel = typeof r.result?.metadata?.resolvedModel === "string" ? r.result.metadata.resolvedModel.trim() : "";
    const rawModel = rawModelId.replace(/^copilot\//i, "") || resolvedModel;
    if (!rawModel) { continue; }

    const requestId = r.requestId || `req_${++anonCounter}`;
    const existing = byId.get(requestId);
    const promptTokens = Number(r.promptTokens ?? r.result?.metadata?.promptTokens ?? existing?.promptTokens ?? 0) || 0;
    const completionTokens = Number(r.completionTokens ?? r.result?.metadata?.outputTokens ?? existing?.completionTokens ?? 0) || 0;
    const timestamp = Number(r.timestamp ?? existing?.timestamp ?? 0) || 0;
    const messageText = typeof r.message?.text === "string"
      ? r.message.text.replace(/\s+/g, " ").trim()
      : (existing?.messageText || "");
    const elapsedMs = Number(r.elapsedMs ?? r.result?.timings?.totalElapsed ?? existing?.elapsedMs ?? 0) || undefined;
    const isComplete = Boolean(
      r.result?.metadata ||
      promptTokens > 0 ||
      completionTokens > 0 ||
      r.responseId ||
      existing?.isComplete
    );

    byId.set(requestId, {
      requestId,
      timestamp,
      rawModel,
      promptTokens,
      completionTokens,
      messageText,
      elapsedMs,
      isComplete,
    });
  }

  return Array.from(byId.values()).sort((a, b) => (a.timestamp - b.timestamp) || a.requestId.localeCompare(b.requestId));
}

// ── Session context parsing ────────────────────────────────────────────

/**
 * Parse the available agents, instructions, skills, and active mode
 * from a session's main.jsonl or events.jsonl file.
 */
export function parseSessionContext(sessionDir: string): SessionContext {
  let agents: string[] = [];
  let instructions: string[] = [];
  let skills: string[] = [];
  let slashCommands: string[] = [];
  const skillsInvoked: string[] = [];
  const debugNames = new Set<string>();
  const customAgentsInvoked: string[] = [];

  const emptyCtx = (mode = "Agent"): SessionContext => ({
    agentMode: mode, agents, instructions, skills, slashCommands, skillsInvoked, customAgentsInvoked,
    skillPaths: {}, slashCommandPaths: {}, agentPaths: {}, instructionPaths: {},
    skillsFirstTurn: {}, agentsFirstTurn: {}, instructionsFirstTurn: {},
    skillsByTurn: {}, instructionsByTurn: {},
  });

  if (!sessionDir || sessionDir.endsWith(".jsonl")) {
    return emptyCtx();
  }

  // Check if this is a Copilot CLI / Agent Host session with events.jsonl
  const eventsFile = path.join(sessionDir, "events.jsonl");
  if (fs.existsSync(eventsFile) && !fs.existsSync(path.join(sessionDir, "main.jsonl"))) {
    let cliMode = "Agent";
    try {
      const content = fs.readFileSync(eventsFile, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) { continue; }
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        const etype = entry.type || entry.event || "";
        if (etype === "subagent.selected") {
          const agentName = entry.data?.agentName || "";
          const displayName = entry.data?.agentDisplayName || "";
          if (displayName === "Ask" || agentName.includes("ask")) { cliMode = "Ask"; }
          else if (displayName === "Edit" || agentName.includes("edit")) { cliMode = "Edit"; }
          else if (displayName) { cliMode = displayName; }
          if (agentName && !agents.includes(agentName)) {
            agents.push(agentName);
          }
        } else if (etype === "instruction.update") {
          const files = entry.data?.instructionFiles || entry.data?.files || [];
          if (Array.isArray(files)) {
            for (const f of files) {
              const name = typeof f === "string" ? path.basename(f) : (f?.name || f?.path ? path.basename(f.name || f.path) : "");
              if (name && !instructions.includes(name)) {
                instructions.push(name);
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
    return emptyCtx(cliMode);
  }

  const mainFile = path.join(sessionDir, "main.jsonl");
  if (!fs.existsSync(mainFile)) { return emptyCtx(); }

  let agentFolders: string[] = [];
  let skillFolders: string[] = [];
  let slashCommandFolders: string[] = [];
  let instructionFolders: string[] = [];

  // Turn tracking (0-based; increments on user_message — aligned with parseSessionDeepDive)
  let turnIdx = 0;
  const seenAgents = new Set<string>();
  const seenSkills = new Set<string>();
  const seenInstructions = new Set<string>();
  const seenSlashCommands = new Set<string>();
  const agentsFirstTurn: Record<string, number> = {};
  const skillsFirstTurn: Record<string, number> = {};
  const instructionsFirstTurn: Record<string, number> = {};
  const skillsByTurn: Record<string, string[]> = {};
  const instructionsByTurn: Record<string, string[]> = {};
  const readFilesByTurn: Record<string, string[]> = {};

  let content = "";
  try { content = fs.readFileSync(mainFile, "utf-8"); } catch { return emptyCtx(); }

  let agentsSeen = false;
  let instructionsSeen = false;
  let skillsSeen = false;
  let slashCommandsSeen = false;

  for (const line of content.split("\n")) {
    if (!line.trim()) { continue; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const etype: string = entry.type || "";
    const attrs = entry.attrs || {};

    if (etype === "user_message") {
      turnIdx++;
    }

    if (etype === "discovery") {
      const details: string = attrs.details || "";

      const foldersMatch = details.match(/\|\s*folders:\s*\[([^\]]+)\]/);
      const folders = foldersMatch
        ? foldersMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];

      // Agents
      if (/Resolved \d+ agents/i.test(details)) {
        const m = details.match(/\|\s*loaded:\s*\[([^\]]+)\]/);
        const turnAgents = m ? m[1].split(",").map((s: string) => s.trim()).filter(Boolean) : [];
        if (!agentsSeen && turnAgents.length > 0) {
          agentsSeen = true;
          agents = turnAgents;
          agentFolders = folders;
        }
        for (const a of turnAgents) {
          if (!seenAgents.has(a)) { seenAgents.add(a); agentsFirstTurn[a] = turnIdx; }
        }
      }

      // Instructions
      if (/Resolved \d+ instructions/i.test(details)) {
        const m = details.match(/\|\s*loaded:\s*\[([^\]]+)\]/);
        const turnInstrs = m ? m[1].split(",").map((s: string) => s.trim()).filter(Boolean) : [];
        if (!instructionsSeen && turnInstrs.length > 0) {
          instructionsSeen = true;
          instructions = turnInstrs;
          instructionFolders = folders;
        }
        for (const i of turnInstrs) {
          if (!seenInstructions.has(i)) { seenInstructions.add(i); instructionsFirstTurn[i] = turnIdx; }
        }
      }

      // Slash commands
      if (/Resolved \d+ slash commands/i.test(details)) {
        const m = details.match(/\|\s*loaded:\s*\[([^\]]+)\]/);
        const turnSlashCommands = m ? m[1].split(",").map((s: string) => s.trim()).filter(Boolean) : [];
        if (!slashCommandsSeen && turnSlashCommands.length > 0) {
          slashCommandsSeen = true;
          slashCommands = turnSlashCommands;
          slashCommandFolders = folders;
        }
        for (const command of turnSlashCommands) {
          if (!seenSlashCommands.has(command)) { seenSlashCommands.add(command); }
        }
      }

      // Skills
      if (/Resolved \d+ skills/i.test(details)) {
        const m = details.match(/\|\s*loaded:\s*\[([^\]]+)\]/);
        const turnSkills = m ? m[1].split(",").map((s: string) => s.trim()).filter(Boolean) : [];
        if (!skillsSeen && turnSkills.length > 0) {
          skillsSeen = true;
          skills = turnSkills;
          skillFolders = folders;
        }
        for (const s of turnSkills) {
          if (!seenSkills.has(s)) { seenSkills.add(s); skillsFirstTurn[s] = turnIdx; }
        }
      }
    }

    if (etype === "generic" && entry.name === "Resolve Customizations" && entry.status === "ok") {
      const details: string = attrs.details || "";
      const turnKey = String(turnIdx);

      let instructionMatch: RegExpExecArray | null;
      const instructionRe = /\[applying\]\s+(.+?)\s+—/g;
      while ((instructionMatch = instructionRe.exec(details)) !== null) {
        _pushUniqueByTurn(instructionsByTurn, turnKey, instructionMatch[1].trim());
      }
    }

    if (etype === "llm_request" && entry.status === "ok") {
      const dn: string = attrs.debugName || "";
      if (dn && !dn.toLowerCase().includes("summarize") && !dn.startsWith("retry-")) {
        debugNames.add(dn);
      }
    }

    if (etype === "tool_call") {
      const turnKey = String(turnIdx);
      const readFilePath = _extractReadFilePath(entry);
      if (readFilePath) {
        _pushUniqueByTurn(readFilesByTurn, turnKey, readFilePath);
      }

      // Backward-compatible capture when a skill appears as a tool name directly.
      const toolName: string = entry.name || "";
      if (toolName && skills.includes(toolName) && !skillsInvoked.includes(toolName)) {
        skillsInvoked.push(toolName);
      }
    }

    if (etype === "child_session_ref") {
      const rawLabel: string = attrs.label || "";
      // Strip "runSubagent-" prefix so the name matches the agents discovery list
      const label = rawLabel.startsWith("runSubagent-") ? rawLabel.slice("runSubagent-".length) : rawLabel;
      if (label && label !== "title" && !customAgentsInvoked.includes(label)) {
        customAgentsInvoked.push(label);
      }
    }
  }

  // Derive human-readable mode from debugName
  const agentMode = _debugNamesToMode(debugNames);

  // Resolve file paths for each item
  const skillPaths: Record<string, string> = {};
  const slashCommandPaths: Record<string, string> = {};
  const agentPaths: Record<string, string> = {};
  const instructionPaths: Record<string, string> = {};
  for (const s of skills) {
    const p = _resolveFilePath(s, skillFolders);
    if (p) { skillPaths[s] = p; }
  }
  for (const command of slashCommands) {
    const p = _resolveFilePath(command, slashCommandFolders);
    if (p) { slashCommandPaths[command] = p; }
  }
  for (const a of agents) {
    const p = _resolveFilePath(a, agentFolders);
    if (p) { agentPaths[a] = p; }
  }
  for (const i of instructions) {
    const p = _resolveFilePath(i, instructionFolders);
    if (p) { instructionPaths[i] = p; }
  }

  const skillPathToName = new Map<string, string>();
  for (const [skillName, skillPath] of Object.entries(skillPaths)) {
    skillPathToName.set(_normalizeSourcePath(skillPath), skillName);
  }
  for (const [turnKey, filePaths] of Object.entries(readFilesByTurn)) {
    for (const filePath of filePaths) {
      const skillName = skillPathToName.get(_normalizeSourcePath(filePath));
      if (!skillName) { continue; }
      _pushUniqueByTurn(skillsByTurn, turnKey, skillName);
      if (!skillsInvoked.includes(skillName)) {
        skillsInvoked.push(skillName);
      }
    }
  }

  return {
    agentMode, agents, instructions, skills, slashCommands, skillsInvoked, customAgentsInvoked,
    skillPaths, slashCommandPaths, agentPaths, instructionPaths,
    skillsFirstTurn, agentsFirstTurn, instructionsFirstTurn,
    skillsByTurn, instructionsByTurn,
  };
}

function _extractReadFilePath(entry: any): string {
  if (entry?.name !== "read_file") { return ""; }
  const rawArgs = entry?.attrs?.args ?? entry?.attrs?.input ?? entry?.args;
  if (!rawArgs || typeof rawArgs !== "string") { return ""; }
  try {
    const parsed = JSON.parse(rawArgs);
    return typeof parsed?.filePath === "string" ? parsed.filePath : "";
  } catch {
    return "";
  }
}

function _normalizeSourcePath(filePath: string): string {
  return path.normalize(filePath).replace(/^\/([a-zA-Z]):\//i, "$1:/");
}

function _pushUniqueByTurn(map: Record<string, string[]>, turnKey: string, value: string): void {
  if (!value) { return; }
  if (!map[turnKey]) { map[turnKey] = []; }
  if (!map[turnKey].includes(value)) {
    map[turnKey].push(value);
  }
}

/**
 * Try to resolve an item name (skill/agent/instruction) to its source file path
 * by scanning the folders from the discovery log entry.
 */
function _resolveFilePath(name: string, folders: string[]): string {
  const exts = [".md", ".prompt.md", ".agent.md", ".instructions.md"];
  for (const rawFolder of folders) {
    // Normalize Unix-style Windows absolute paths: /c:/... → c:/...
    const folder = rawFolder.replace(/^\/([a-zA-Z]):\//i, "$1:/");
    for (const ext of exts) {
      const p = path.join(folder, name + ext);
      if (fs.existsSync(p)) { return p; }
    }
    // Try {name}/SKILL.md (skill packaged in a subdirectory)
    const subP = path.join(folder, name, "SKILL.md");
    if (fs.existsSync(subP)) { return subP; }
  }
  return "";
}

function _debugNamesToMode(names: Set<string>): string {
  for (const dn of names) {
    const lower = dn.toLowerCase();
    if (lower.includes("editagent")) { return "Agent"; }
    if (lower.includes("edit")) { return "Edit"; }
    if (lower.includes("chat")) { return "Chat"; }
  }
  return "Agent"; // default
}

export interface ModelStats {
  calls: number;
  main_calls: number;
  subagent_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  any_cached_field_seen: boolean;
  cache_write_estimated: boolean;
  cache_assumed: boolean;
  user_turns: number;
  _user_turn_ids: Set<number>;
}

export interface ModelResult {
  model: string;
  display_model?: string;
  provider?: ModelProvider;
  vendor: string;
  calls: number;
  main_calls: number;
  subagent_calls: number;
  user_turns: number;
  input_tokens: number;
  fresh_input: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost: number;
  has_cache_write: boolean;
  cache_assumed: boolean;
  cache_write_estimated: boolean;
  warning?: string;
  pricing?: {
    input: number;
    cached_input: number;
    cache_write: number;
    output: number;
  };
}

export interface SessionAnalysis {
  session: {
    id: string;
    ts: number;
    date: string;
    last_ts?: number;
    last_date?: string;
    workspace_name: string;
    session_title: string;
    source?: string;
  };
  models: ModelResult[];
  totals: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_ratio: number;
    cost: number;
    copilot_cost: number;
    ollama_cost: number;
  };
  context?: SessionContext;
}

// ── Session Provider Hint Detection ────────────────────────────────────

/**
 * Inspect chatSessions/<sessionId>.jsonl, main.jsonl, or events.jsonl to see if the session
 * explicitly selected an Ollama provider/custom endpoint for ambiguous models (like kimi-k2.7-code or kimi-3).
 */
function detectSessionProviderHint(sessionDir: string): ModelProvider | undefined {
  try {
    const eventsFile = sessionDir.endsWith(".jsonl") ? "" : path.join(sessionDir, "events.jsonl");
    if (eventsFile && fs.existsSync(eventsFile)) {
      const fd = fs.openSync(eventsFile, "r");
      try {
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, 8192, 0);
        const head = buf.toString("utf-8", 0, n);
        if (/ollama-models\/|customendpoint\/ollama|:cloud\b|-cloud\b/i.test(head)) {
          return "ollama";
        }
      } finally {
        fs.closeSync(fd);
      }
    }

    const chatSessionFile = locateChatSessionPath(sessionDir);
    if (chatSessionFile && fs.existsSync(chatSessionFile)) {
      const raw = fs.readFileSync(chatSessionFile, "utf-8");
      if (/ollama\s*cloud|ollama-models\/|customendpoint\/ollama|"vendor"\s*:\s*"ollama"|:cloud\b/i.test(raw)) {
        return "ollama";
      }
    }
    if (!sessionDir.endsWith(".jsonl")) {
      const mainFile = path.join(sessionDir, "main.jsonl");
      if (fs.existsSync(mainFile)) {
        const mainRaw = fs.readFileSync(mainFile, "utf-8");
        if (/customendpoint\/ollama\s*cloud\/|ollama-models\/|:cloud"/i.test(mainRaw)) {
          return "ollama";
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

// ── Parsing ────────────────────────────────────────────────────────────

function newStats(): ModelStats {
  return {
    calls: 0, main_calls: 0, subagent_calls: 0,
    input_tokens: 0, output_tokens: 0,
    cached_tokens: 0, cache_write_tokens: 0,
    any_cached_field_seen: false, cache_write_estimated: false,
    cache_assumed: false, user_turns: 0,
    _user_turn_ids: new Set(),
  };
}

function parseJsonlFile(
  filePath: string,
  stats: Map<string, ModelStats>,
  isSubagent: boolean,
  sessionProviderHint?: ModelProvider,
): void {
  if (!fs.existsSync(filePath)) { return; }
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return; }

  let currentTurnId = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) { continue; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const etype: string = entry.type || "";

    if (!isSubagent && etype === "user_message") {
      currentTurnId++;
      continue;
    }

    if (etype !== "llm_request" || entry.status !== "ok") { continue; }

    const attrs = entry.attrs || {};
    const model: string = attrs.model || "";
    if (!model) { continue; }
    // Skip synthetic Agent Instructions placeholder call with model="unknown"
    if (model === "unknown" && attrs.debugName === "Agent Instructions") { continue; }

    const resolved = resolveModelMatch(model, sessionProviderHint, attrs);
    const key = resolved.canonicalKey;
    if (!stats.has(key)) { stats.set(key, newStats()); }
    const s = stats.get(key)!;

    s.calls++;
    if (isSubagent) { s.subagent_calls++; } else { s.main_calls++; }

    const inputTok = parseInt(attrs.inputTokens || "0", 10);
    const outputTok = parseInt(attrs.outputTokens || "0", 10);
    const cwTok = parseInt(attrs.cacheWriteTokens || "0", 10);
    const hasCachedField = "cachedTokens" in attrs;
    const cachedTok = parseInt(attrs.cachedTokens || "0", 10);

    s.input_tokens += inputTok;
    s.output_tokens += outputTok;
    s.cached_tokens += cachedTok;
    s.cache_write_tokens += cwTok;

    if (hasCachedField) { s.any_cached_field_seen = true; }
    if (cwTok === 0 && hasCachedField && inputTok > 0) { s.cache_write_estimated = true; }

    if (!isSubagent && currentTurnId > 0) {
      s._user_turn_ids.add(currentTurnId);
    }
  }
}

/**
 * Parse a Copilot CLI / VS Code Agent Host `events.jsonl` file.
 * Reads per-call `session.usage_record` events first (supporting active sessions and subagent filtering),
 * and falls back to `session.shutdown` `modelMetrics` if no `session.usage_record` entries were found.
 */
function parseCliEventsFile(
  eventsPath: string,
  stats: Map<string, ModelStats>,
  includeSubagents: boolean,
  sessionProviderHint?: ModelProvider,
): void {
  if (!fs.existsSync(eventsPath)) { return; }
  let content: string;
  try { content = fs.readFileSync(eventsPath, "utf-8"); } catch { return; }

  let currentTurnId = 0;
  let usageRecordCount = 0;
  let shutdownMetrics: Record<string, any> | null = null;
  let localHint = sessionProviderHint;

  for (const line of content.split("\n")) {
    if (!line.trim()) { continue; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const etype: string = entry.type || entry.event || "";

    if (etype === "session.start") {
      const selModel: string = entry.data?.selectedModel || "";
      if (selModel && (/^ollama-models\//i.test(selModel) || /:cloud$/i.test(selModel) || /-cloud$/i.test(selModel))) {
        localHint = "ollama";
      }
      continue;
    }

    if (etype === "user.message") {
      currentTurnId++;
      continue;
    }

    if (etype === "session.usage_record") {
      const u = entry.data?.usage;
      if (!u || typeof u !== "object") { continue; }
      const rawModel: string = u.model || u.modelDisplayName || "";
      if (!rawModel) { continue; }

      const initiator: string = String(u.initiator || "").toLowerCase();
      const isSubagent = initiator === "sub-agent" || initiator === "subagent" || Boolean(entry.agentId);
      if (isSubagent && !includeSubagents) { continue; }

      usageRecordCount++;
      const resolved = resolveModelMatch(rawModel, localHint, u);
      const key = resolved.canonicalKey;
      if (!stats.has(key)) { stats.set(key, newStats()); }
      const s = stats.get(key)!;

      s.calls++;
      if (isSubagent) { s.subagent_calls++; } else { s.main_calls++; }

      const inputTok = Number(u.inputTokens) || 0;
      const outputTok = Number(u.outputTokens) || 0;
      const cachedTok = Number(u.cacheReadTokens) || 0;
      const cwTok = Number(u.cacheWriteTokens) || 0;
      const hasCachedField = "cacheReadTokens" in u;

      s.input_tokens += inputTok;
      s.output_tokens += outputTok;
      s.cached_tokens += cachedTok;
      s.cache_write_tokens += cwTok;

      if (hasCachedField) { s.any_cached_field_seen = true; }
      if (!isSubagent && currentTurnId > 0) {
        s._user_turn_ids.add(currentTurnId);
      }
      continue;
    }

    if (etype === "session.shutdown") {
      const mm = entry.data?.modelMetrics || entry.data?.accountingSnapshot?.modelMetrics;
      if (mm && typeof mm === "object") {
        shutdownMetrics = mm;
      }
    }
  }

  // Fallback for CLI logs that only have session.shutdown modelMetrics and no session.usage_record
  if (usageRecordCount === 0 && shutdownMetrics) {
    for (const [rawModel, metrics] of Object.entries(shutdownMetrics)) {
      const m = metrics as any;
      const calls = Number(m?.requests?.count) || 0;
      if (calls <= 0) { continue; }
      const resolved = resolveModelMatch(rawModel, localHint);
      const key = resolved.canonicalKey;
      if (!stats.has(key)) { stats.set(key, newStats()); }
      const s = stats.get(key)!;
      s.calls += calls;
      s.main_calls += calls;
      s.input_tokens += Number(m?.usage?.inputTokens) || 0;
      s.output_tokens += Number(m?.usage?.outputTokens) || 0;
      s.cached_tokens += Number(m?.usage?.cacheReadTokens) || 0;
      s.cache_write_tokens += Number(m?.usage?.cacheWriteTokens) || 0;
      s.user_turns = Math.max(s.user_turns, currentTurnId);
      if (s.cached_tokens > 0 || s.cache_write_tokens > 0 || "cacheReadTokens" in (m?.usage || {})) {
        s.any_cached_field_seen = true;
      }
    }
  }
}

/**
 * Supplement debug-log stats with requests from chatSessions/{sid}.jsonl when
 * main.jsonl has no llm_request calls (e.g. Ollama BYOK in VS Code Chat) or is truncated.
 */
function supplementFromChatSession(
  sessionDirOrFile: string,
  stats: Map<string, ModelStats>,
  sessionProviderHint?: ModelProvider,
): void {
  const chatPath = locateChatSessionPath(sessionDirOrFile);
  if (!chatPath) { return; }

  const chatRequests = parseChatSessionRequests(chatPath);
  if (chatRequests.length === 0) { return; }

  // Collect timestamps of turns that actually produced llm_request entries in main.jsonl
  const llmTurnTimestamps: number[] = [];
  if (!sessionDirOrFile.endsWith(".jsonl")) {
    const mainPath = path.join(sessionDirOrFile, "main.jsonl");
    if (fs.existsSync(mainPath)) {
      try {
        const content = fs.readFileSync(mainPath, "utf-8");
        let lastUserTs = 0;
        let turnHadLlm = false;
        for (const line of content.split("\n")) {
          if (!line.trim()) { continue; }
          let entry: any;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type === "user_message" && entry.ts) {
            if (lastUserTs > 0 && turnHadLlm) {
              llmTurnTimestamps.push(lastUserTs);
            }
            lastUserTs = Number(entry.ts) || 0;
            turnHadLlm = false;
          } else if (entry.type === "llm_request" && entry.status === "ok") {
            const m = entry.attrs?.model || "";
            if (m && !(m === "unknown" && entry.attrs?.debugName === "Agent Instructions")) {
              turnHadLlm = true;
            }
          }
        }
        if (lastUserTs > 0 && turnHadLlm) {
          llmTurnTimestamps.push(lastUserTs);
        }
      } catch { /* ignore */ }
    }
  }

  if (llmTurnTimestamps.length >= chatRequests.length) {
    return;
  }

  const MATCH_WINDOW_MS = 10_000;
  const sortedDebugTs = [...llmTurnTimestamps].sort((a, b) => a - b);
  const usedIndices = new Set<number>();

  let turnNum = llmTurnTimestamps.length;
  for (const req of chatRequests) {
    let matched = false;
    for (let i = 0; i < sortedDebugTs.length; i++) {
      if (usedIndices.has(i)) { continue; }
      if (Math.abs(sortedDebugTs[i] - req.timestamp) <= MATCH_WINDOW_MS) {
        usedIndices.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) {
      turnNum++;
      const resolved = resolveModelMatch(req.rawModel, sessionProviderHint);
      const key = resolved.canonicalKey;
      if (!stats.has(key)) { stats.set(key, newStats()); }
      const s = stats.get(key)!;
      s.calls += 1;
      s.main_calls += 1;
      s.input_tokens += req.promptTokens;
      s.output_tokens += req.completionTokens;
      s.user_turns += 1;
    }
  }
}

export function parseSession(sessionDir: string, includeSubagents: boolean = true): Map<string, ModelStats> {
  const stats = new Map<string, ModelStats>();
  if (!sessionDir) { return stats; }

  const sessionHint = detectSessionProviderHint(sessionDir);

  // Case 1: Chat-only session file path
  if (sessionDir.endsWith(".jsonl")) {
    supplementFromChatSession(sessionDir, stats, sessionHint);
    return stats;
  }

  // Case 2: Copilot CLI / VS Code Agent Host session directory (events.jsonl)
  const eventsPath = path.join(sessionDir, "events.jsonl");
  if (fs.existsSync(eventsPath) && !fs.existsSync(path.join(sessionDir, "main.jsonl"))) {
    parseCliEventsFile(eventsPath, stats, includeSubagents, sessionHint);
    for (const s of stats.values()) {
      if (s._user_turn_ids.size > 0) {
        s.user_turns = s._user_turn_ids.size;
      }
      s._user_turn_ids = new Set();
    }
    return stats;
  }

  // Case 3: VS Code / Insiders debug-logs directory (main.jsonl + runSubagent-*.jsonl + chatSessions supplement)
  parseJsonlFile(path.join(sessionDir, "main.jsonl"), stats, false, sessionHint);

  if (includeSubagents) {
    try {
      for (const file of fs.readdirSync(sessionDir)) {
        if (file === "main.jsonl") { continue; }
        if (!file.startsWith("runSubagent-") || !file.endsWith(".jsonl")) { continue; }
        parseJsonlFile(path.join(sessionDir, file), stats, true, sessionHint);
      }
    } catch { /* ignore */ }
  }

  for (const s of stats.values()) {
    s.user_turns = s._user_turn_ids.size;
    s._user_turn_ids = new Set();
  }

  supplementFromChatSession(sessionDir, stats, sessionHint);
  return stats;
}

// ── Cost computation ───────────────────────────────────────────────────

/**
 * Compute cost for a single LLM call.
 * Used by both computeCost() (aggregate) and parseSessionDeepDive() (per-call).
 * @param cachedTokens   Already-resolved cached token count (pass 0 when field is absent)
 * @param cacheAssumed   True when cachedTokens was estimated, not reported (informational)
 */
export function computeCallCost(
  modelKey: string,
  inputTokens: number,
  cachedTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  _cacheAssumed: boolean,
): number {
  const pricing = findPricing(modelKey);
  if (!pricing) { return 0; }
  const hasCacheWrite = pricing.cache_write !== undefined;
  const freshInput = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
  let cost = freshInput * pricing.input / 1_000_000;
  cost += cachedTokens * pricing.cached_input / 1_000_000;
  if (hasCacheWrite) {
    cost += cacheWriteTokens * (pricing.cache_write || 0) / 1_000_000;
  }
  cost += outputTokens * pricing.output / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function computeCost(modelKey: string, s: ModelStats): ModelResult {
  const pricing = findPricing(modelKey);
  const provider = providerForKey(modelKey);
  const displayModel = stripProviderPrefix(modelKey);
  if (!pricing) {
    return {
      model: modelKey,
      display_model: displayModel,
      provider,
      vendor: vendorFor(modelKey),
      calls: s.calls, main_calls: s.main_calls, subagent_calls: s.subagent_calls,
      user_turns: s.user_turns, input_tokens: s.input_tokens,
      fresh_input: s.input_tokens, cached_tokens: 0, cache_write_tokens: 0,
      output_tokens: s.output_tokens, cost: 0, has_cache_write: false,
      cache_assumed: false, cache_write_estimated: false,
      warning: `No pricing data found for model '${modelKey}' — cost excluded.`,
    };
  }

  const hasCacheWrite = pricing.cache_write !== undefined;
  let cachedTok = s.cached_tokens;
  const cachingNotTracked = !s.any_cached_field_seen;
  const cacheAssumed = (cachingNotTracked && hasCacheWrite) || s.cache_assumed;

  if (cachingNotTracked && hasCacheWrite) {
    cachedTok = Math.floor(s.input_tokens * ASSUMED_CACHE_RATIO);
  }

  const freshInput = Math.max(0, s.input_tokens - cachedTok - s.cache_write_tokens);
  const cost = computeCallCost(modelKey, s.input_tokens, cachedTok, s.cache_write_tokens, s.output_tokens, cacheAssumed);

  return {
    model: modelKey,
    display_model: displayModel,
    provider,
    vendor: vendorFor(modelKey),
    calls: s.calls,
    main_calls: s.main_calls,
    subagent_calls: s.subagent_calls,
    user_turns: s.user_turns,
    input_tokens: s.input_tokens,
    fresh_input: freshInput,
    cached_tokens: cachedTok,
    cache_write_tokens: s.cache_write_tokens,
    output_tokens: s.output_tokens,
    cost,
    has_cache_write: hasCacheWrite,
    cache_assumed: cacheAssumed,
    cache_write_estimated: s.cache_write_estimated,
    pricing: {
      input: pricing.input,
      cached_input: pricing.cached_input,
      cache_write: pricing.cache_write || 0,
      output: pricing.output,
    },
  };
}

// ── High-level API (used by webview message handler) ───────────────────

function modelStatsToJson(stats: Map<string, ModelStats>): ModelResult[] {
  const results: ModelResult[] = [];
  for (const [key, s] of stats) {
    results.push(computeCost(key, s));
  }
  return results.sort((a, b) => b.cost - a.cost || b.calls - a.calls);
}

function sessionToJson(s: SessionRecord) {
  return {
    id: s.id, ts: s.ts, date: s.date,
    last_ts: s.last_ts, last_date: s.last_date,
    workspace_name: s.workspace_name,
    session_title: s.session_title,
    source: s.source,
  };
}

export function analyzeSession(session: SessionRecord, includeSubagents: boolean = true): SessionAnalysis {
  const stats = parseSession(session.path, includeSubagents);
  const models = modelStatsToJson(stats);
  const context = parseSessionContext(session.path);
  const valid = models.filter(m => !m.warning);
  const totalCost = valid.reduce((sum, m) => sum + m.cost, 0);
  const copilotCost = valid.filter(m => m.provider !== "ollama").reduce((sum, m) => sum + m.cost, 0);
  const ollamaCost = valid.filter(m => m.provider === "ollama").reduce((sum, m) => sum + m.cost, 0);
  const totalInput = models.reduce((sum, m) => sum + m.input_tokens, 0);
  const totalOutput = models.reduce((sum, m) => sum + m.output_tokens, 0);
  const totalCached = models.reduce((sum, m) => sum + m.cached_tokens, 0);
  const totalCalls = models.reduce((sum, m) => sum + m.calls, 0);

  return {
    session: sessionToJson(session),
    models,
    context,
    totals: {
      calls: totalCalls,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cached_tokens: totalCached,
      cache_ratio: totalInput ? Math.round(1000 * totalCached / totalInput) / 10 : 0,
      cost: Math.round(totalCost * 1_000_000) / 1_000_000,
      copilot_cost: Math.round(copilotCost * 1_000_000) / 1_000_000,
      ollama_cost: Math.round(ollamaCost * 1_000_000) / 1_000_000,
    },
  };
}

/** Lightweight cost-only analysis — no context parsing. Used for bulk table loading. */
export function analyzeSessionCost(
  session: SessionRecord,
  includeSubagents: boolean = true,
): { id: string; totals: { cost: number; copilot_cost: number; ollama_cost: number; cache_ratio: number } } {
  const stats = parseSession(session.path, includeSubagents);
  const models = modelStatsToJson(stats);
  const valid = models.filter(m => !m.warning);
  const totalCost = valid.reduce((sum, m) => sum + m.cost, 0);
  const copilotCost = valid.filter(m => m.provider !== "ollama").reduce((sum, m) => sum + m.cost, 0);
  const ollamaCost = valid.filter(m => m.provider === "ollama").reduce((sum, m) => sum + m.cost, 0);
  const totalInput = models.reduce((sum, m) => sum + m.input_tokens, 0);
  const totalCached = models.reduce((sum, m) => sum + m.cached_tokens, 0);
  return {
    id: session.id,
    totals: {
      cost: Math.round(totalCost * 1_000_000) / 1_000_000,
      copilot_cost: Math.round(copilotCost * 1_000_000) / 1_000_000,
      ollama_cost: Math.round(ollamaCost * 1_000_000) / 1_000_000,
      cache_ratio: totalInput ? Math.round(1000 * totalCached / totalInput) / 10 : 0,
    },
  };
}

export function analyzeAggregate(
  hours: number,
  prefiltered?: ReturnType<typeof findAllSessions>,
  includeSubagents: boolean = true,
) {
  const sessions = prefiltered ?? findAllSessions(hours);
  if (!sessions.length) { return undefined; }

  const grand = new Map<string, ModelStats>();

  for (const s of sessions) {
    const stats = parseSession(s.path, includeSubagents);
    for (const [model, st] of stats) {
      if (!grand.has(model)) {
        grand.set(model, {
          calls: 0, main_calls: 0, subagent_calls: 0,
          input_tokens: 0, output_tokens: 0,
          cached_tokens: 0, cache_write_tokens: 0,
          any_cached_field_seen: false, cache_write_estimated: false,
          cache_assumed: false, user_turns: 0, _user_turn_ids: new Set(),
        });
      }
      const g = grand.get(model)!;
      g.calls += st.calls;
      g.main_calls += st.main_calls;
      g.subagent_calls += st.subagent_calls;
      g.input_tokens += st.input_tokens;
      g.output_tokens += st.output_tokens;
      g.cache_write_tokens += st.cache_write_tokens;
      if (st.cache_write_estimated) { g.cache_write_estimated = true; }
      if (st.any_cached_field_seen) {
        g.any_cached_field_seen = true;
        g.cached_tokens += st.cached_tokens;
      } else {
        const pricing = findPricing(model);
        if (pricing && pricing.cache_write !== undefined) {
          g.cached_tokens += Math.floor(st.input_tokens * ASSUMED_CACHE_RATIO);
          g.cache_assumed = true;
          g.any_cached_field_seen = true;
        } else {
          g.cached_tokens += st.cached_tokens;
        }
      }
      g.user_turns += st.user_turns;
    }
  }

  const models = modelStatsToJson(grand);
  const valid = models.filter(m => !m.warning);
  const totalCost = valid.reduce((sum, m) => sum + m.cost, 0);
  const copilotCost = valid.filter(m => m.provider !== "ollama").reduce((sum, m) => sum + m.cost, 0);
  const ollamaCost = valid.filter(m => m.provider === "ollama").reduce((sum, m) => sum + m.cost, 0);
  const totalInput = models.reduce((sum, m) => sum + m.input_tokens, 0);
  const totalOutput = models.reduce((sum, m) => sum + m.output_tokens, 0);
  const totalCached = models.reduce((sum, m) => sum + m.cached_tokens, 0);
  const totalCalls = models.reduce((sum, m) => sum + m.calls, 0);

  return {
    sessions_count: sessions.length,
    hours,
    models,
    totals: {
      calls: totalCalls,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cached_tokens: totalCached,
      cache_ratio: totalInput ? Math.round(1000 * totalCached / totalInput) / 10 : 0,
      cost: Math.round(totalCost * 1_000_000) / 1_000_000,
      copilot_cost: Math.round(copilotCost * 1_000_000) / 1_000_000,
      ollama_cost: Math.round(ollamaCost * 1_000_000) / 1_000_000,
    },
  };
}

// ── Models Tab Overview ────────────────────────────────────────────────

export interface ObservedModelRecord {
  rawModel: string;
  provider: ModelProvider;
  proxyUsed: string | null;
  calls: number;
}

export interface KnownModelRecord {
  key: string;
  model: string;
  provider: ModelProvider;
  vendor: string;
  input: number;
  cached_input: number;
  cache_write: number | null;
  output: number;
  source: string;
  observedCalls: number;
}

export function getModelsOverview(
  hours: number = 9999,
  prefiltered?: SessionRecord[],
  includeSubagents: boolean = true,
) {
  const sessions = prefiltered ?? findAllSessions(hours);
  const rawObservedMap = new Map<string, { rawModel: string; provider: ModelProvider; calls: number; canonicalKey: string; isExact: boolean; proxyUsed: string | null }>();
  const canonicalObservedCalls = new Map<string, number>();

  function recordObservedModel(rawModel: string, calls: number, sessionHint?: ModelProvider, attrs?: Record<string, any>) {
    if (!rawModel || calls <= 0) { return; }
    if (rawModel === "unknown" && attrs?.debugName === "Agent Instructions") { return; }
    const resolved = resolveModelMatch(rawModel, sessionHint, attrs);
    const mapKey = `${resolved.provider}::${rawModel}`;
    const existing = rawObservedMap.get(mapKey);
    if (existing) {
      existing.calls += calls;
    } else {
      rawObservedMap.set(mapKey, {
        rawModel,
        provider: resolved.provider,
        calls,
        canonicalKey: resolved.canonicalKey,
        isExact: resolved.isExact,
        proxyUsed: resolved.pricing ? resolved.proxyUsed : null,
      });
    }

    if (resolved.pricing) {
      canonicalObservedCalls.set(
        resolved.canonicalKey,
        (canonicalObservedCalls.get(resolved.canonicalKey) || 0) + calls,
      );
    }
  }

  function scanDebugFile(filePath: string, sessionHint?: ModelProvider): number {
    if (!fs.existsSync(filePath)) { return 0; }
    let content = "";
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { return 0; }
    let count = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) { continue; }
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "llm_request" || entry.status !== "ok") { continue; }
      const attrs = entry.attrs || {};
      const rawModel: string = attrs.model || "";
      if (!rawModel) { continue; }
      if (rawModel === "unknown" && attrs.debugName === "Agent Instructions") { continue; }
      count++;
      recordObservedModel(rawModel, 1, sessionHint, attrs);
    }
    return count;
  }

  function scanCliEventsFile(eventsPath: string, sessionHint?: ModelProvider) {
    if (!fs.existsSync(eventsPath)) { return; }
    let content = "";
    try { content = fs.readFileSync(eventsPath, "utf-8"); } catch { return; }
    let usageCount = 0;
    let shutdownMetrics: Record<string, any> | null = null;
    let localHint = sessionHint;

    for (const line of content.split("\n")) {
      if (!line.trim()) { continue; }
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const etype: string = entry.type || entry.event || "";
      if (etype === "session.start") {
        const selModel: string = entry.data?.selectedModel || "";
        if (selModel && (/^ollama-models\//i.test(selModel) || /:cloud$/i.test(selModel) || /-cloud$/i.test(selModel))) {
          localHint = "ollama";
        }
      } else if (etype === "session.usage_record") {
        const u = entry.data?.usage;
        if (!u || typeof u !== "object") { continue; }
        const initiator = String(u.initiator || "").toLowerCase();
        const isSubagent = initiator === "sub-agent" || initiator === "subagent" || Boolean(entry.agentId);
        if (isSubagent && !includeSubagents) { continue; }
        const rawModel: string = u.model || u.modelDisplayName || "";
        if (rawModel) {
          usageCount++;
          recordObservedModel(rawModel, 1, localHint, u);
        }
      } else if (etype === "session.shutdown") {
        const mm = entry.data?.modelMetrics || entry.data?.accountingSnapshot?.modelMetrics;
        if (mm && typeof mm === "object") {
          shutdownMetrics = mm;
        }
      }
    }

    if (usageCount === 0 && shutdownMetrics) {
      for (const [rawModel, metrics] of Object.entries(shutdownMetrics)) {
        const calls = Number((metrics as any)?.requests?.count) || 0;
        if (calls > 0) {
          recordObservedModel(rawModel, calls, localHint);
        }
      }
    }
  }

  for (const s of sessions) {
    const hint = detectSessionProviderHint(s.path);
    if (s.path.endsWith(".jsonl")) {
      const reqs = parseChatSessionRequests(s.path);
      for (const r of reqs) {
        recordObservedModel(r.rawModel, 1, hint);
      }
      continue;
    }

    const eventsPath = path.join(s.path, "events.jsonl");
    if (fs.existsSync(eventsPath) && !fs.existsSync(path.join(s.path, "main.jsonl"))) {
      scanCliEventsFile(eventsPath, hint);
      continue;
    }

    const mainCount = scanDebugFile(path.join(s.path, "main.jsonl"), hint);
    if (includeSubagents) {
      try {
        for (const file of fs.readdirSync(s.path)) {
          if (file === "main.jsonl") { continue; }
          if (!file.startsWith("runSubagent-") || !file.endsWith(".jsonl")) { continue; }
          scanDebugFile(path.join(s.path, file), hint);
        }
      } catch { /* ignore */ }
    }

    if (mainCount === 0) {
      const chatPath = locateChatSessionPath(s.path);
      if (chatPath) {
        const reqs = parseChatSessionRequests(chatPath);
        for (const r of reqs) {
          recordObservedModel(r.rawModel, 1, hint);
        }
      }
    }
  }

  // Observed models without an exact price (either unpriced OR matched via proxy/customendpoint/:cloud)
  const unmatchedObserved: ObservedModelRecord[] = [];
  for (const item of rawObservedMap.values()) {
    if (!item.isExact) {
      unmatchedObserved.push({
        rawModel: item.rawModel,
        provider: item.provider,
        proxyUsed: item.proxyUsed,
        calls: item.calls,
      });
    }
  }
  unmatchedObserved.sort((a, b) => b.calls - a.calls || a.rawModel.localeCompare(b.rawModel));

  // Known models from pricing catalog
  const pricingTable = getPricing();
  const knownModels: KnownModelRecord[] = Object.entries(pricingTable).map(([key, p]) => {
    const provider: ModelProvider = p.provider || (key.startsWith("ollama/") ? "ollama" : "copilot");
    const displayModel = stripProviderPrefix(key);
    return {
      key,
      model: displayModel,
      provider,
      vendor: vendorFor(key),
      input: p.input,
      cached_input: p.cached_input,
      cache_write: p.cache_write !== undefined ? p.cache_write : null,
      output: p.output,
      source: p.source || "bundled",
      observedCalls: canonicalObservedCalls.get(key) || 0,
    };
  });

  knownModels.sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));

  return {
    status: getPricingStatus(),
    creditSettings: getCreditSettings(),
    unmatchedObserved,
    knownModels,
  };
}

export { findAllSessions, getLatestSession, findSessionById };

// ── Deep Dive ──────────────────────────────────────────────────────────

function parseEntryTimestampMs(entry: any): number | null {
  const raw = entry?.ts ?? entry?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) { return raw; }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) { return ms; }
  }
  return null;
}

export function parseSessionDeepDive(sessionDir: string, includeSubagents: boolean = true): SessionDeepDive {
  let currentTurnId = 0;
  let seqCounter = 0;
  const turnMap = new Map<number, TurnRecord>();
  const sessionHint = detectSessionProviderHint(sessionDir);

  function ensureTurn(id: number): TurnRecord {
    if (!turnMap.has(id)) {
      turnMap.set(id, {
        turn: id,
        calls: 0,
        inputTokens: 0,
        cachedTokens: 0,
        freshTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        cacheHitPct: 0,
        cost: 0,
        hasSummarization: false,
        firstTs: null,
        lastTs: null,
        callRecords: [],
        toolCalls: [],
        agentRefs: [],
        userMessage: null,
      });
    }
    return turnMap.get(id)!;
  }

  function processDebugLine(line: string, isSubagent: boolean, turnId: number): void {
    if (!line.trim()) { return; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { return; }

    const etype: string = entry.type || "";

    if (!isSubagent && etype === "user_message") {
      currentTurnId++;
      const userText = ((entry.attrs?.content as string) || "").replace(/\s+/g, " ").trim();
      if (userText) {
        const turn = ensureTurn(currentTurnId);
        if (!turn.userMessage) {
          turn.userMessage = userText.length > 300 ? userText.slice(0, 297) + "…" : userText;
        }
      }
      return;
    }

    if (etype === "tool_call") {
      const toolName: string = entry.name || "";
      if (toolName) {
        const turn = ensureTurn(turnId);
        const toolTs: number | null = entry.ts != null ? Number(entry.ts) : null;
        const toolDur: number | null = entry.dur != null ? Number(entry.dur) : null;
        turn.toolCalls.push({ name: toolName, ts: toolTs, dur: toolDur, status: entry.status || "" });
        if (toolTs != null) {
          if (turn.firstTs === null || toolTs < turn.firstTs) { turn.firstTs = toolTs; }
          if (turn.lastTs === null || toolTs > turn.lastTs) { turn.lastTs = toolTs; }
        }
      }
      return;
    }

    if (etype === "child_session_ref" && !isSubagent) {
      const rawLabel: string = entry.attrs?.label || "";
      const label = rawLabel.startsWith("runSubagent-") ? rawLabel.slice("runSubagent-".length) : rawLabel;
      if (label && label !== "title") {
        const turn = ensureTurn(turnId);
        if (!turn.agentRefs.includes(label)) { turn.agentRefs.push(label); }
      }
      return;
    }

    if (etype !== "llm_request" || entry.status !== "ok") { return; }

    const attrs = entry.attrs || {};
    const model: string = attrs.model || "";
    if (!model) { return; }
    if (model === "unknown" && attrs.debugName === "Agent Instructions") { return; }

    const resolved = resolveModelMatch(model, sessionHint, attrs);
    const key = resolved.canonicalKey;
    const inputTokens = parseInt(attrs.inputTokens ?? "0", 10) || 0;
    const outputTokens = parseInt(attrs.outputTokens ?? "0", 10) || 0;
    const cacheWriteTokens = parseInt(attrs.cacheWriteTokens ?? "0", 10) || 0;
    const hasCachedField = "cachedTokens" in attrs;
    const rawCached = hasCachedField ? (parseInt(attrs.cachedTokens ?? "0", 10) || 0) : -1;
    const freshTokens = inputTokens - Math.max(0, rawCached);
    const debugName: string = attrs.debugName || "";
    const ttft: number | null = attrs.ttft != null ? Number(attrs.ttft) : null;
    const ts: number | null = entry.ts != null ? Number(entry.ts) : null;

    const cacheHitPct: number | null = hasCachedField
      ? (inputTokens > 0 ? Math.round(1000 * Math.max(0, rawCached) / inputTokens) / 10 : 0)
      : null;

    const cachedForCost = hasCachedField ? Math.max(0, rawCached) : 0;
    const cost = computeCallCost(key, inputTokens, cachedForCost, cacheWriteTokens, outputTokens, false);

    seqCounter++;
    const callRecord: CallRecord = {
      seq: seqCounter,
      model: key,
      provider: resolved.provider,
      debugName,
      inputTokens,
      cachedTokens: rawCached,
      freshTokens,
      cacheWriteTokens,
      outputTokens,
      cacheHitPct,
      cost,
      isSubagent,
      ttft,
      ts,
    };

    const turn = ensureTurn(turnId);
    turn.calls++;
    turn.inputTokens += inputTokens;
    turn.cachedTokens += Math.max(0, rawCached);
    turn.freshTokens += freshTokens;
    turn.cacheWriteTokens += cacheWriteTokens;
    turn.outputTokens += outputTokens;
    turn.cost += cost;
    if (debugName.toLowerCase().includes("summarize")) {
      turn.hasSummarization = true;
    }
    if (ts != null) {
      if (turn.firstTs === null || ts < turn.firstTs) { turn.firstTs = ts; }
      if (turn.lastTs === null || ts > turn.lastTs) { turn.lastTs = ts; }
    }
    turn.callRecords.push(callRecord);
  }

  // Case A: CLI / Agent Host events.jsonl
  const eventsFile = !sessionDir.endsWith(".jsonl") ? path.join(sessionDir, "events.jsonl") : "";
  if (eventsFile && fs.existsSync(eventsFile) && !fs.existsSync(path.join(sessionDir, "main.jsonl"))) {
    let content = "";
    try { content = fs.readFileSync(eventsFile, "utf-8"); } catch { /* ignore */ }
    let localHint = sessionHint;
    const toolStartMap = new Map<string, { name: string; ts: number | null; turnId: number }>();

    for (const line of content.split("\n")) {
      if (!line.trim()) { continue; }
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const etype: string = entry.type || entry.event || "";
      const ts = parseEntryTimestampMs(entry);

      if (etype === "session.start") {
        const selModel: string = entry.data?.selectedModel || "";
        if (selModel && (/^ollama-models\//i.test(selModel) || /:cloud$/i.test(selModel) || /-cloud$/i.test(selModel))) {
          localHint = "ollama";
        }
        continue;
      }

      if (etype === "user.message") {
        currentTurnId++;
        const rawText: string = entry.data?.content || entry.data?.prompt || entry.data?.text || "";
        const userText = rawText.replace(/\s+/g, " ").trim();
        const turn = ensureTurn(currentTurnId);
        if (userText && !turn.userMessage) {
          turn.userMessage = userText.length > 300 ? userText.slice(0, 297) + "…" : userText;
        }
        if (ts != null) {
          if (turn.firstTs === null || ts < turn.firstTs) { turn.firstTs = ts; }
          if (turn.lastTs === null || ts > turn.lastTs) { turn.lastTs = ts; }
        }
        continue;
      }

      if (etype === "tool.execution_start") {
        const toolName: string = entry.data?.toolName || "";
        const toolCallId: string = entry.data?.toolCallId || "";
        if (toolName) {
          if (toolCallId) {
            toolStartMap.set(toolCallId, { name: toolName, ts, turnId: currentTurnId });
          } else {
            const turn = ensureTurn(currentTurnId);
            turn.toolCalls.push({ name: toolName, ts, dur: null, status: "ok" });
          }
        }
        continue;
      }

      if (etype === "tool.execution_complete") {
        const toolCallId: string = entry.data?.toolCallId || "";
        const startInfo = toolCallId ? toolStartMap.get(toolCallId) : undefined;
        if (startInfo) {
          toolStartMap.delete(toolCallId);
          const turn = ensureTurn(startInfo.turnId);
          const dur = startInfo.ts != null && ts != null && ts >= startInfo.ts ? ts - startInfo.ts : null;
          const status = entry.data?.success === false ? "error" : "ok";
          turn.toolCalls.push({ name: startInfo.name, ts: startInfo.ts, dur, status });
        }
        continue;
      }

      if (etype === "session.usage_record") {
        const u = entry.data?.usage;
        if (!u || typeof u !== "object") { continue; }
        const rawModel: string = u.model || u.modelDisplayName || "";
        if (!rawModel) { continue; }
        const initiator = String(u.initiator || "").toLowerCase();
        const isSubagent = initiator === "sub-agent" || initiator === "subagent" || Boolean(entry.agentId);
        if (isSubagent && !includeSubagents) { continue; }

        const resolved = resolveModelMatch(rawModel, localHint, u);
        const key = resolved.canonicalKey;
        const inputTokens = Number(u.inputTokens) || 0;
        const outputTokens = Number(u.outputTokens) || 0;
        const cacheWriteTokens = Number(u.cacheWriteTokens) || 0;
        const hasCachedField = "cacheReadTokens" in u;
        const rawCached = hasCachedField ? (Number(u.cacheReadTokens) || 0) : -1;
        const freshTokens = inputTokens - Math.max(0, rawCached);
        const debugName: string = u.interactionType || u.initiator || "agent";
        const ttft: number | null = u.timeToFirstTokenMs != null ? Math.round(Number(u.timeToFirstTokenMs)) : null;

        const cacheHitPct: number | null = hasCachedField
          ? (inputTokens > 0 ? Math.round(1000 * Math.max(0, rawCached) / inputTokens) / 10 : 0)
          : null;
        const cachedForCost = hasCachedField ? Math.max(0, rawCached) : 0;
        const cost = computeCallCost(key, inputTokens, cachedForCost, cacheWriteTokens, outputTokens, false);

        const turnId = currentTurnId > 0 ? currentTurnId : 1;
        seqCounter++;
        const callRecord: CallRecord = {
          seq: seqCounter,
          model: key,
          provider: resolved.provider,
          debugName,
          inputTokens,
          cachedTokens: rawCached,
          freshTokens,
          cacheWriteTokens,
          outputTokens,
          cacheHitPct,
          cost,
          isSubagent,
          ttft,
          ts,
        };

        const turn = ensureTurn(turnId);
        turn.calls++;
        turn.inputTokens += inputTokens;
        turn.cachedTokens += Math.max(0, rawCached);
        turn.freshTokens += freshTokens;
        turn.cacheWriteTokens += cacheWriteTokens;
        turn.outputTokens += outputTokens;
        turn.cost += cost;
        if (ts != null) {
          if (turn.firstTs === null || ts < turn.firstTs) { turn.firstTs = ts; }
          if (turn.lastTs === null || ts > turn.lastTs) { turn.lastTs = ts; }
        }
        turn.callRecords.push(callRecord);
      }
    }

    // Flush any tool calls that didn't have a matching completion event
    for (const startInfo of toolStartMap.values()) {
      const turn = ensureTurn(startInfo.turnId);
      turn.toolCalls.push({ name: startInfo.name, ts: startInfo.ts, dur: null, status: "ok" });
    }
  } else if (!sessionDir.endsWith(".jsonl")) {
    // Case B: VS Code debug-logs (main.jsonl + runSubagent-*.jsonl)
    const mainFile = path.join(sessionDir, "main.jsonl");
    if (fs.existsSync(mainFile)) {
      let content = "";
      try { content = fs.readFileSync(mainFile, "utf-8"); } catch { /* ignore */ }
      for (const line of content.split("\n")) {
        processDebugLine(line, false, currentTurnId);
      }
    }

    if (includeSubagents) {
      const subagentTurnId = currentTurnId;
      try {
        for (const file of fs.readdirSync(sessionDir)) {
          if (file === "main.jsonl") { continue; }
          if (!file.startsWith("runSubagent-") || !file.endsWith(".jsonl")) { continue; }
          let content = "";
          try { content = fs.readFileSync(path.join(sessionDir, file), "utf-8"); } catch { continue; }
          for (const line of content.split("\n")) {
            processDebugLine(line, true, subagentTurnId);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Case C: If no LLM calls were recorded in main.jsonl (e.g. Ollama BYOK in VS Code Chat or chat-only session),
  // populate call records from chatSessions/{sid}.jsonl!
  if (seqCounter === 0) {
    const chatPath = locateChatSessionPath(sessionDir);
    if (chatPath) {
      const reqs = parseChatSessionRequests(chatPath);
      let tIdx = 0;
      for (const req of reqs) {
        tIdx++;
        const turn = ensureTurn(tIdx);
        if (req.messageText && !turn.userMessage) {
          turn.userMessage = req.messageText.length > 300 ? req.messageText.slice(0, 297) + "…" : req.messageText;
        }
        const resolved = resolveModelMatch(req.rawModel, sessionHint);
        const key = resolved.canonicalKey;
        const cost = computeCallCost(key, req.promptTokens, 0, 0, req.completionTokens, false);
        seqCounter++;
        const callRecord: CallRecord = {
          seq: seqCounter,
          model: key,
          provider: resolved.provider,
          debugName: "chatSession",
          inputTokens: req.promptTokens,
          cachedTokens: -1,
          freshTokens: req.promptTokens,
          cacheWriteTokens: 0,
          outputTokens: req.completionTokens,
          cacheHitPct: null,
          cost,
          isSubagent: false,
          ttft: null,
          ts: req.timestamp || null,
        };
        turn.calls++;
        turn.inputTokens += req.promptTokens;
        turn.freshTokens += req.promptTokens;
        turn.outputTokens += req.completionTokens;
        turn.cost += cost;
        if (req.timestamp) {
          if (turn.firstTs === null || req.timestamp < turn.firstTs) { turn.firstTs = req.timestamp; }
          if (turn.lastTs === null || req.timestamp > turn.lastTs) { turn.lastTs = req.timestamp; }
        }
        turn.callRecords.push(callRecord);
      }
    }
  }

  // Finalise turns: compute turn-level cacheHitPct and round costs
  const turns = [...turnMap.values()].sort((a, b) => a.turn - b.turn);
  for (const t of turns) {
    const reported = t.callRecords.filter(c => c.cacheHitPct !== null);
    if (reported.length > 0) {
      const repInput = reported.reduce((s, c) => s + c.inputTokens, 0);
      const repCached = reported.reduce((s, c) => s + Math.max(0, c.cachedTokens), 0);
      t.cacheHitPct = repInput > 0 ? Math.round(1000 * repCached / repInput) / 10 : 0;
    } else {
      t.cacheHitPct = 0;
    }
    t.cost = Math.round(t.cost * 1_000_000) / 1_000_000;
  }

  // Grand totals
  const allCalls = turns.flatMap(t => t.callRecords);
  const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalCachedTokens = turns.reduce((s, t) => s + t.cachedTokens, 0);
  const totalFreshTokens = turns.reduce((s, t) => s + t.freshTokens, 0);
  const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = Math.round(turns.reduce((s, t) => s + t.cost, 0) * 1_000_000) / 1_000_000;
  const reportedCalls = allCalls.filter(c => c.cacheHitPct !== null);
  const repTotalInput = reportedCalls.reduce((s, c) => s + c.inputTokens, 0);
  const repTotalCached = reportedCalls.reduce((s, c) => s + Math.max(0, c.cachedTokens), 0);
  const totalCacheHitPct = repTotalInput > 0 ? Math.round(1000 * repTotalCached / repTotalInput) / 10 : 0;

  return {
    turns,
    totals: {
      turns: turns.length,
      calls: allCalls.length,
      inputTokens: totalInputTokens,
      cachedTokens: totalCachedTokens,
      freshTokens: totalFreshTokens,
      outputTokens: totalOutputTokens,
      cacheHitPct: totalCacheHitPct,
      cost: totalCost,
    },
  };
}
