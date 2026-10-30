/**
 * Session discovery — finds Copilot and Ollama agent sessions across all VS Code
 * workspace storage directories (debug-logs & chatSessions) as well as Copilot CLI /
 * VS Code Agent Host session-state directories (~/.copilot/session-state).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Types ──────────────────────────────────────────────────────────────

export type SessionSource = "vscode" | "insiders" | "cli" | "remote";

export interface SessionRecord {
  id: string;
  ts: number;
  date: string;
  last_ts: number;
  last_date: string;
  path: string;
  workspace_name: string;
  workspace_id: string;
  session_title: string;
  source?: SessionSource;
  chat_session_path?: string;
  debug_main_path?: string;
}

// ── Workspace storage directories ──────────────────────────────────────

function allWorkspaceStorageDirs(): string[] {
  const dirs: string[] = [];
  const home = os.homedir();
  let roots: string[];

  switch (process.platform) {
    case "win32":
      roots = [process.env.APPDATA || path.join(home, "AppData", "Roaming")];
      break;
    case "darwin":
      roots = [path.join(home, "Library", "Application Support")];
      break;
    default: // Linux
      roots = [process.env.XDG_CONFIG_HOME || path.join(home, ".config")];
      break;
  }

  for (const base of roots) {
    for (const variant of ["Code - Insiders", "Code"]) {
      const wsRoot = path.join(base, variant, "User", "workspaceStorage");
      if (fs.existsSync(wsRoot)) {
        try {
          for (const entry of fs.readdirSync(wsRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              dirs.push(path.join(wsRoot, entry.name));
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Also check .vscode-server paths used by Remote SSH / WSL extensions
  if (process.platform !== "win32") {
    for (const serverDir of [".vscode-server", ".vscode-server-insiders"]) {
      const wsRoot = path.join(home, serverDir, "data", "User", "workspaceStorage");
      if (fs.existsSync(wsRoot)) {
        try {
          for (const entry of fs.readdirSync(wsRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const fullPath = path.join(wsRoot, entry.name);
              if (!dirs.includes(fullPath)) {
                dirs.push(fullPath);
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return dirs;
}

export function allCliSessionDirs(): string[] {
  const dirs: string[] = [];
  const home = os.homedir();
  const copilotHome = process.env.COPILOT_HOME || path.join(home, ".copilot");
  const sessionStateRoot = path.join(copilotHome, "session-state");
  if (!fs.existsSync(sessionStateRoot)) {
    return dirs;
  }
  try {
    for (const entry of fs.readdirSync(sessionStateRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(path.join(sessionStateRoot, entry.name));
      }
    }
  } catch { /* ignore */ }
  return dirs;
}

function classifyWorkspaceStorageDir(wsDir: string): SessionSource {
  const normalized = wsDir.replace(/\\/g, "/");
  if (
    normalized.includes("/.vscode-server/") ||
    normalized.includes("/.vscode-server-insiders/")
  ) {
    return "remote";
  }
  if (normalized.includes("/Code - Insiders/")) {
    return "insiders";
  }
  return "vscode";
}

// ── Workspace naming ───────────────────────────────────────────────────

function urlDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function workspaceNameFromPath(raw: string): string | null {
  let decoded = urlDecode(raw);
  for (const prefix of ["file:///", "file://"]) {
    if (decoded.startsWith(prefix)) {
      decoded = decoded.slice(prefix.length);
    }
  }
  decoded = decoded.replace(/\\/g, "/");

  if (decoded.endsWith(".code-workspace")) {
    const stem = decoded.split("/").pop()!;
    return stem.slice(0, -".code-workspace".length);
  }

  if (decoded.includes("Workspaces") && decoded.endsWith("workspace.json")) {
    return null; // signal to read the file
  }

  const parts = decoded.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
}

function readInternalWorkspaceName(workspaceJsonPath: string): string {
  try {
    let decoded = urlDecode(workspaceJsonPath);
    for (const prefix of ["file:///", "file://"]) {
      if (decoded.startsWith(prefix)) {
        decoded = decoded.slice(prefix.length);
        if (process.platform !== "win32" && !decoded.startsWith("/")) {
          decoded = "/" + decoded;
        }
        break;
      }
    }
    if (!fs.existsSync(decoded)) { return "unknown-workspace"; }
    const data = JSON.parse(fs.readFileSync(decoded, "utf-8"));
    const folders: { uri?: string; path?: string }[] = data.folders || [];
    if (folders.length) {
      const first = folders[0].uri || folders[0].path || "";
      return workspaceNameFromPath(first) || "unknown-workspace";
    }
  } catch { /* ignore */ }
  return "unknown-workspace";
}

export function getWorkspaceName(wsDir: string): string {
  const wj = path.join(wsDir, "workspace.json");
  if (!fs.existsSync(wj)) { return path.basename(wsDir).slice(0, 8); }
  try {
    const data = JSON.parse(fs.readFileSync(wj, "utf-8"));
    const raw: string = data.workspace || data.folder || "";
    if (!raw) { return path.basename(wsDir).slice(0, 8); }
    const name = workspaceNameFromPath(raw);
    if (name === null) { return readInternalWorkspaceName(raw); }
    return name || path.basename(wsDir).slice(0, 8);
  } catch {
    return path.basename(wsDir).slice(0, 8);
  }
}

// ── Session title extraction ───────────────────────────────────────────

function cleanTitleText(text: string): string {
  const clean = text
    .replace(/\\r\\n|\\n|\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 80 ? clean.slice(0, 77) + "…" : clean;
}

function firstUserMessage(sessionDir: string): string {
  const mainPath = path.join(sessionDir, "main.jsonl");
  if (!fs.existsSync(mainPath)) { return ""; }
  try {
    const content = fs.readFileSync(mainPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) { continue; }
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "user_message") {
        const text: string = entry.attrs?.content || "";
        if (text) {
          return cleanTitleText(text);
        }
      }
    }
  } catch { /* ignore */ }
  return "";
}

export function findChatSessionFile(wsDir: string, sessionId: string): string | undefined {
  const p1 = path.join(wsDir, "chatSessions", `${sessionId}.jsonl`);
  if (fs.existsSync(p1)) { return p1; }
  const p2 = path.join(wsDir, "GitHub.copilot-chat", "chatSessions", `${sessionId}.jsonl`);
  if (fs.existsSync(p2)) { return p2; }
  return undefined;
}

export function getSessionTitle(sessionDir: string): string {
  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.startsWith("title-") && f.endsWith(".jsonl"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(sessionDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) { continue; }
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== "agent_response") { continue; }
        const respRaw = entry.attrs?.response;
        if (!respRaw) { continue; }
        try {
          const resp = typeof respRaw === "string" ? JSON.parse(respRaw) : respRaw;
          if (Array.isArray(resp)) {
            for (const part of resp) {
              if (part?.role === "assistant" && part.parts?.length) {
                const text = part.parts[0].content;
                if (text) { return cleanTitleText(text); }
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Fallback: use the first user message from main.jsonl
  const fallback = firstUserMessage(sessionDir);
  return fallback || "untitled";
}

// ── Session timestamp ──────────────────────────────────────────────────

function sessionLastTs(folder: string): number {
  const main = path.join(folder, "main.jsonl");
  if (!fs.existsSync(main)) { return 0; }
  // Entry types that don't represent real user/model activity — VS Code writes these
  // to all open sessions simultaneously (e.g. customization sweeps), causing every
  // session to share the same last timestamp.
  const NOISE_TYPES = new Set(["discovery", "turn_start", "turn_end", "session_start"]);
  try {
    let lastTs = 0;
    const content = fs.readFileSync(main, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) { continue; }
      try {
        const entry = JSON.parse(line);
        if (NOISE_TYPES.has(entry.type)) { continue; }
        const ts = entry.ts;
        if (ts) { lastTs = ts; }
      } catch { /* ignore */ }
    }
    return lastTs;
  } catch { /* ignore */ }
  return 0;
}

function sessionTs(folder: string): number {
  const main = path.join(folder, "main.jsonl");
  if (!fs.existsSync(main)) { return 0; }
  try {
    const fd = fs.openSync(main, "r");
    try {
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      if (bytesRead === 0) { return 0; }
      const chunk = buf.toString("utf-8", 0, bytesRead);
      const nlIdx = chunk.indexOf("\n");
      const firstLine = nlIdx >= 0 ? chunk.slice(0, nlIdx) : chunk;
      if (!firstLine.trim()) { return 0; }
      const entry = JSON.parse(firstLine);
      return entry.ts || 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* ignore */ }
  return 0;
}

// ── Chat-Only Session Quick Metadata ───────────────────────────────────

interface QuickChatMeta {
  createdAt: number;
  lastRequestAt: number;
  title: string;
  requestCount: number;
}

const _chatMetaCache = new Map<string, { mtimeMs: number; size: number; meta: QuickChatMeta | null }>();

function getQuickChatSessionMeta(chatSessionPath: string): QuickChatMeta | null {
  try {
    const stat = fs.statSync(chatSessionPath);
    if (stat.size < 128) { return null; }
    const cached = _chatMetaCache.get(chatSessionPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.meta;
    }

    const content = fs.readFileSync(chatSessionPath, "utf-8");
    let createdAt = 0;
    let firstTs = 0;
    let lastTs = 0;
    let title = "";
    let requestCount = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) { continue; }
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.kind === 0 && entry.v) {
        if (entry.v.creationDate) { createdAt = Number(entry.v.creationDate) || createdAt; }
        const reqs = Array.isArray(entry.v.requests) ? entry.v.requests : [];
        for (const r of reqs) {
          if (r && (r.requestId || r.modelId)) {
            requestCount++;
            const rts = Number(r.timestamp) || 0;
            if (rts > 0) {
              if (!firstTs || rts < firstTs) { firstTs = rts; }
              if (rts > lastTs) { lastTs = rts; }
            }
            if (!title && typeof r.message?.text === "string" && r.message.text.trim()) {
              title = cleanTitleText(r.message.text);
            }
          }
        }
      } else if (entry.kind === 2 && Array.isArray(entry.k) && entry.k.length === 1 && entry.k[0] === "requests") {
        const reqs = Array.isArray(entry.v) ? entry.v : [];
        for (const r of reqs) {
          if (r && (r.requestId || r.modelId)) {
            requestCount++;
            const rts = Number(r.timestamp) || 0;
            if (rts > 0) {
              if (!firstTs || rts < firstTs) { firstTs = rts; }
              if (rts > lastTs) { lastTs = rts; }
            }
            if (!title && typeof r.message?.text === "string" && r.message.text.trim()) {
              title = cleanTitleText(r.message.text);
            }
          }
        }
      }
    }

    const meta: QuickChatMeta | null = requestCount > 0
      ? {
          createdAt: createdAt || firstTs || lastTs || Math.floor(stat.mtimeMs),
          lastRequestAt: lastTs || createdAt || Math.floor(stat.mtimeMs),
          title: title || "untitled",
          requestCount,
        }
      : null;

    _chatMetaCache.set(chatSessionPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
  } catch {
    return null;
  }
}

// ── CLI / Agent Host Session Discovery (~/.copilot/session-state) ──────

function parseWorkspaceYaml(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) { return result; }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[m[1]] = val;
      }
    }
  } catch { /* ignore */ }
  return result;
}

function parseEntryTs(entry: any): number {
  const raw = entry?.ts ?? entry?.timestamp ?? entry?.data?.startTime;
  if (typeof raw === "number") { return raw; }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

function cliSessionFirstInfo(eventsPath: string): { firstTs: number; firstUserMsg: string; cwd: string } {
  let firstTs = 0;
  let firstUserMsg = "";
  let cwd = "";
  try {
    const fd = fs.openSync(eventsPath, "r");
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
      if (bytesRead > 0) {
        const chunk = buf.toString("utf-8", 0, bytesRead);
        for (const line of chunk.split("\n")) {
          if (!line.trim()) { continue; }
          try {
            const entry = JSON.parse(line);
            if (!firstTs) {
              const ts = parseEntryTs(entry);
              if (ts > 0) { firstTs = ts; }
            }
            const etype = entry.type || entry.event || "";
            if (etype === "session.start" && !cwd) {
              cwd = entry.data?.context?.cwd || entry.data?.context?.gitRoot || "";
            }
            if (etype === "user.message" && !firstUserMsg) {
              const text = entry.data?.content || entry.data?.prompt || entry.data?.text || entry.data?.message || "";
              if (typeof text === "string" && text.trim()) {
                firstUserMsg = cleanTitleText(text);
              }
            }
            if (firstTs && firstUserMsg) { break; }
          } catch { /* partial line at end of 64KB chunk */ }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* ignore */ }
  return { firstTs, firstUserMsg, cwd };
}

function cliSessionLastTs(eventsPath: string, fileSize: number): number {
  try {
    const fd = fs.openSync(eventsPath, "r");
    try {
      const readSize = Math.min(fileSize, 65536);
      const offset = Math.max(0, fileSize - readSize);
      const buf = Buffer.alloc(readSize);
      const bytesRead = fs.readSync(fd, buf, 0, readSize, offset);
      if (bytesRead === 0) { return 0; }
      const chunk = buf.toString("utf-8", 0, bytesRead);
      const lines = chunk.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) { continue; }
        try {
          const entry = JSON.parse(line);
          const ts = parseEntryTs(entry);
          if (ts > 0) { return ts; }
        } catch { /* ignore partial first line of tail chunk */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* ignore */ }
  return 0;
}

const _cliRecordCache = new Map<string, { mtimeMs: number; size: number; record: SessionRecord | null }>();

function buildCliSessionRecord(sessionDir: string): SessionRecord | null {
  const eventsPath = path.join(sessionDir, "events.jsonl");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(eventsPath);
    if (stat.size < 256) { return null; }
  } catch {
    return null;
  }

  const cached = _cliRecordCache.get(sessionDir);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.record;
  }

  const sid = path.basename(sessionDir);
  const meta = parseWorkspaceYaml(path.join(sessionDir, "workspace.yaml"));
  const firstInfo = cliSessionFirstInfo(eventsPath);

  let ts = 0;
  if (meta.created_at) {
    const ms = Date.parse(meta.created_at);
    if (!Number.isNaN(ms)) { ts = ms; }
  }
  if (!ts) {
    ts = firstInfo.firstTs;
  }
  if (!ts) {
    _cliRecordCache.set(sessionDir, { mtimeMs: stat.mtimeMs, size: stat.size, record: null });
    return null;
  }

  let lastTs = cliSessionLastTs(eventsPath, stat.size);
  if (!lastTs && meta.updated_at) {
    const ms = Date.parse(meta.updated_at);
    if (!Number.isNaN(ms)) { lastTs = ms; }
  }
  if (!lastTs) { lastTs = ts; }

  const cwdPath = meta.git_root || meta.cwd || firstInfo.cwd || "";
  let wsName = "cli";
  if (cwdPath) {
    wsName = path.basename(cwdPath.replace(/\\/g, "/")) || "cli";
  } else if (meta.repository) {
    wsName = meta.repository.split("/").pop() || "cli";
  }

  let title = "untitled";
  if (meta.name || meta.summary) {
    title = cleanTitleText(meta.name || meta.summary);
  } else if (firstInfo.firstUserMsg) {
    title = firstInfo.firstUserMsg;
  }

  const dt = new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lastDate = new Date(lastTs).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const record: SessionRecord = {
    id: sid,
    ts,
    date: dt,
    last_ts: lastTs,
    last_date: lastDate,
    path: sessionDir,
    workspace_name: wsName,
    workspace_id: `cli:${wsName}`,
    session_title: title,
    source: "cli",
  };

  _cliRecordCache.set(sessionDir, { mtimeMs: stat.mtimeMs, size: stat.size, record });
  return record;
}

// ── Pick best duplicate ────────────────────────────────────────────────

function pickBest(candidates: SessionRecord[]): SessionRecord {
  return candidates.reduce((best, c) => {
    const mainPath = path.join(c.path, "main.jsonl");
    const cSize = fs.existsSync(mainPath) ? fs.statSync(mainPath).size : 0;
    const bestMainPath = path.join(best.path, "main.jsonl");
    const bestSize = fs.existsSync(bestMainPath) ? fs.statSync(bestMainPath).size : 0;
    if (cSize > bestSize) { return c; }
    if (cSize === bestSize) {
      const cMeta = (c.session_title !== "untitled" ? 2 : 0) + (c.workspace_name !== "unknown-workspace" ? 1 : 0);
      const bMeta = (best.session_title !== "untitled" ? 2 : 0) + (best.workspace_name !== "unknown-workspace" ? 1 : 0);
      if (cMeta > bMeta) { return c; }
    }
    return best;
  });
}

// ── Session cache ──────────────────────────────────────────────────────

let _allSessionsCache: { ts: number; sessions: SessionRecord[] } | null = null;
const SESSION_CACHE_TTL = 10_000; // 10 seconds

export function invalidateSessionCache() { _allSessionsCache = null; }

const _debugRecordCache = new Map<string, { mtimeMs: number; size: number; record: SessionRecord | null }>();

// ── Public API ─────────────────────────────────────────────────────────

function discoverAllSessionsUnfiltered(): SessionRecord[] {
  const now = Date.now();
  if (_allSessionsCache && (now - _allSessionsCache.ts) < SESSION_CACHE_TTL) {
    return _allSessionsCache.sessions;
  }

  const byId = new Map<string, SessionRecord[]>();

  // 1. VS Code / Insiders / Remote workspaceStorage sessions
  for (const wsDir of allWorkspaceStorageDirs()) {
    const source = classifyWorkspaceStorageDir(wsDir);
    const logsRoot = path.join(wsDir, "GitHub.copilot-chat", "debug-logs");
    const wsName = getWorkspaceName(wsDir);
    const seenInWs = new Set<string>();

    if (fs.existsSync(logsRoot)) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(logsRoot, { withFileTypes: true });
      } catch { /* ignore */ }

      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const sid = entry.name;
        const sessionPath = path.join(logsRoot, sid);
        const chatFile = findChatSessionFile(wsDir, sid);

        // Keep only real user chat sessions and skip internal helper runs.
        if (!chatFile) { continue; }
        seenInWs.add(sid);

        const mainFile = path.join(sessionPath, "main.jsonl");
        let mainStat: fs.Stats | null = null;
        try {
          const st = fs.statSync(mainFile);
          if (st.size >= 512) { mainStat = st; }
        } catch { /* ignore */ }

        if (mainStat) {
          const cached = _debugRecordCache.get(sessionPath);
          if (cached && cached.mtimeMs === mainStat.mtimeMs && cached.size === mainStat.size) {
            if (cached.record) {
              if (!byId.has(sid)) { byId.set(sid, []); }
              byId.get(sid)!.push(cached.record);
            }
            continue;
          }

          const ts = sessionTs(sessionPath);
          if (ts === 0) {
            _debugRecordCache.set(sessionPath, { mtimeMs: mainStat.mtimeMs, size: mainStat.size, record: null });
            continue;
          }
          const lastTs = sessionLastTs(sessionPath) || ts;
          const dt = new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
          const lastDate = new Date(lastTs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
          const title = getSessionTitle(sessionPath);

          const record: SessionRecord = {
            id: sid,
            ts,
            date: dt,
            last_ts: lastTs,
            last_date: lastDate,
            path: sessionPath,
            workspace_name: wsName,
            workspace_id: path.basename(wsDir),
            session_title: title,
            source,
            chat_session_path: chatFile,
            debug_main_path: mainFile,
          };
          _debugRecordCache.set(sessionPath, { mtimeMs: mainStat.mtimeMs, size: mainStat.size, record });
          if (!byId.has(sid)) { byId.set(sid, []); }
          byId.get(sid)!.push(record);
        } else {
          // Debug log is empty/missing, fall back to chatSessions/{sid}.jsonl metadata
          const chatMeta = getQuickChatSessionMeta(chatFile);
          if (!chatMeta) { continue; }
          const ts = chatMeta.createdAt;
          const lastTs = chatMeta.lastRequestAt || ts;
          const dt = new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
          const lastDate = new Date(lastTs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
          const record: SessionRecord = {
            id: sid,
            ts,
            date: dt,
            last_ts: lastTs,
            last_date: lastDate,
            path: fs.existsSync(sessionPath) ? sessionPath : chatFile,
            workspace_name: wsName,
            workspace_id: path.basename(wsDir),
            session_title: chatMeta.title,
            source,
            chat_session_path: chatFile,
          };
          if (!byId.has(sid)) { byId.set(sid, []); }
          byId.get(sid)!.push(record);
        }
      }
    }

    // Also scan chatSessions directories for chat-only sessions without a debug-logs directory
    for (const chatDir of [
      path.join(wsDir, "chatSessions"),
      path.join(wsDir, "GitHub.copilot-chat", "chatSessions"),
    ]) {
      if (!fs.existsSync(chatDir)) { continue; }
      let chatFiles: fs.Dirent[] = [];
      try {
        chatFiles = fs.readdirSync(chatDir, { withFileTypes: true });
      } catch { continue; }
      for (const cf of chatFiles) {
        if (!cf.isFile() || !cf.name.endsWith(".jsonl")) { continue; }
        const sid = path.basename(cf.name, ".jsonl");
        if (seenInWs.has(sid)) { continue; }
        seenInWs.add(sid);
        const chatFile = path.join(chatDir, cf.name);
        const chatMeta = getQuickChatSessionMeta(chatFile);
        if (!chatMeta) { continue; }
        const ts = chatMeta.createdAt;
        const lastTs = chatMeta.lastRequestAt || ts;
        const dt = new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
        const lastDate = new Date(lastTs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
        const record: SessionRecord = {
          id: sid,
          ts,
          date: dt,
          last_ts: lastTs,
          last_date: lastDate,
          path: chatFile,
          workspace_name: wsName,
          workspace_id: path.basename(wsDir),
          session_title: chatMeta.title,
          source,
          chat_session_path: chatFile,
        };
        if (!byId.has(sid)) { byId.set(sid, []); }
        byId.get(sid)!.push(record);
      }
    }
  }

  // 2. Copilot CLI / VS Code Agent Host sessions (~/.copilot/session-state)
  for (const cliDir of allCliSessionDirs()) {
    const record = buildCliSessionRecord(cliDir);
    if (!record) { continue; }
    if (!byId.has(record.id)) { byId.set(record.id, []); }
    byId.get(record.id)!.push(record);
  }

  const sessions = Array.from(byId.values())
    .map(pickBest)
    .sort((a, b) => (b.last_ts || b.ts) - (a.last_ts || a.ts));

  _allSessionsCache = { ts: Date.now(), sessions };
  return sessions;
}

export function findAllSessions(hours: number = 12): SessionRecord[] {
  const cutoffMs = Date.now() - hours * 3600 * 1000;
  const all = discoverAllSessionsUnfiltered();
  return all.filter(s => (s.last_ts || s.ts) >= cutoffMs);
}

export function getLatestSession(hours: number = 12): SessionRecord | undefined {
  const sessions = findAllSessions(hours);
  return sessions[0];
}

export function findSessionById(sessionId: string): SessionRecord | { _ambiguous: SessionRecord[] } | undefined {
  const all = discoverAllSessionsUnfiltered();
  const matches = all.filter(s => s.id === sessionId || s.id.startsWith(sessionId));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    const exact = matches.filter(s => s.id === sessionId);
    if (exact.length === 1) { return exact[0]; }
    return { _ambiguous: matches };
  }
  return undefined;
}
