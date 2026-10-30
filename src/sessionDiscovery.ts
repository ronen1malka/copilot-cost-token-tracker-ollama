/**
 * Session discovery — finds Copilot debug-log sessions across all VS Code
 * workspace storage directories.  Ported from session-cost.py.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Types ──────────────────────────────────────────────────────────────

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
          const clean = text.replace(/\s+/g, " ").trim();
          return clean.length > 80 ? clean.slice(0, 77) + "…" : clean;
        }
      }
    }
  } catch { /* ignore */ }
  return "";
}

function hasChatSessionRecord(wsDir: string, sessionId: string): boolean {
  const chatSessionPath = path.join(wsDir, "chatSessions", `${sessionId}.jsonl`);
  return fs.existsSync(chatSessionPath);
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
                if (text) { return text.trim(); }
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

let _sessionCache: { ts: number; hours: number; sessions: SessionRecord[] } | null = null;
const SESSION_CACHE_TTL = 10_000; // 10 seconds

export function invalidateSessionCache() { _sessionCache = null; }

// ── Public API ─────────────────────────────────────────────────────────

export function findAllSessions(hours: number = 12): SessionRecord[] {
  const now = Date.now();
  if (_sessionCache && _sessionCache.hours === hours && (now - _sessionCache.ts) < SESSION_CACHE_TTL) {
    return _sessionCache.sessions;
  }
  const cutoffMs = (Date.now() - hours * 3600 * 1000);
  const byId = new Map<string, SessionRecord[]>();

  for (const wsDir of allWorkspaceStorageDirs()) {
    const logsRoot = path.join(wsDir, "GitHub.copilot-chat", "debug-logs");
    if (!fs.existsSync(logsRoot)) { continue; }

    const wsName = getWorkspaceName(wsDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(logsRoot, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const sid = entry.name;
      const sessionPath = path.join(logsRoot, sid);

      // Keep only real user chat sessions and skip internal helper runs.
      if (!hasChatSessionRecord(wsDir, sid)) { continue; }

      // Skip empty sessions (only session_start, no actual LLM data)
      const mainFile = path.join(sessionPath, "main.jsonl");
      try {
        const size = fs.statSync(mainFile).size;
        if (size < 1024) { continue; }
      } catch { continue; }

      const ts = sessionTs(sessionPath);
      if (ts === 0) { continue; }

      const lastTs = sessionLastTs(sessionPath);
      // Include the session if it was *active* within the window
      const activeTs = lastTs || ts;
      if (activeTs < cutoffMs) { continue; }

      const dt = new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const lastDate = lastTs
        ? new Date(lastTs).toISOString().replace("T", " ").slice(0, 16) + " UTC"
        : dt;      const title = getSessionTitle(sessionPath);

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
      };

      if (!byId.has(sid)) { byId.set(sid, []); }
      byId.get(sid)!.push(record);
    }
  }

  const sessions = Array.from(byId.values()).map(pickBest).sort((a, b) => (b.last_ts || b.ts) - (a.last_ts || a.ts));
  _sessionCache = { ts: Date.now(), hours, sessions };
  return sessions;
}

export function getLatestSession(hours: number = 12): SessionRecord | undefined {
  const sessions = findAllSessions(hours);
  return sessions[0];
}

export function findSessionById(sessionId: string): SessionRecord | { _ambiguous: SessionRecord[] } | undefined {
  const byId = new Map<string, SessionRecord[]>();

  for (const wsDir of allWorkspaceStorageDirs()) {
    const logsRoot = path.join(wsDir, "GitHub.copilot-chat", "debug-logs");
    if (!fs.existsSync(logsRoot)) { continue; }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(logsRoot, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      if (entry.name !== sessionId && !entry.name.startsWith(sessionId)) { continue; }
      if (!hasChatSessionRecord(wsDir, entry.name)) { continue; }

      const sessionPath = path.join(logsRoot, entry.name);
      const ts = sessionTs(sessionPath);
      const dt = ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "unknown";
      const lastTs = sessionLastTs(sessionPath);
      const lastDate = lastTs ? new Date(lastTs).toISOString().replace("T", " ").slice(0, 16) + " UTC" : dt;
      const wsName = getWorkspaceName(wsDir);
      const title = getSessionTitle(sessionPath);

      const record: SessionRecord = {
        id: entry.name,
        ts,
        date: dt,
        last_ts: lastTs,
        last_date: lastDate,
        path: sessionPath,
        workspace_name: wsName,
        workspace_id: path.basename(wsDir),
        session_title: title,
      };

      if (!byId.has(entry.name)) { byId.set(entry.name, []); }
      byId.get(entry.name)!.push(record);
    }
  }

  if (byId.size === 0) { return undefined; }
  if (byId.size > 1) {
    return { _ambiguous: Array.from(byId.values()).map(pickBest) };
  }
  return pickBest(Array.from(byId.values())[0]);
}
