/**
 * Stable anonymous user ID — persisted in globalState + OS fallback file.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const STATE_KEY = "copilotCost.anonymousUserId";

function fallbackDir(): string {
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming"), "copilot-cost-tracker");
    case "darwin":
      return path.join(require("os").homedir(), "Library", "Application Support", "copilot-cost-tracker");
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(require("os").homedir(), ".config"), "copilot-cost-tracker");
  }
}

function fallbackPath(): string {
  return path.join(fallbackDir(), "user-id.json");
}

function readFallback(): string | undefined {
  try {
    const raw = fs.readFileSync(fallbackPath(), "utf-8");
    const data = JSON.parse(raw);
    if (typeof data.userId === "string" && data.userId.length > 0) {
      return data.userId;
    }
  } catch { /* missing or corrupt */ }
  return undefined;
}

function writeFallback(userId: string): void {
  try {
    const dir = fallbackDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fallbackPath(), JSON.stringify({ userId }), "utf-8");
  } catch { /* best effort */ }
}

/**
 * Resolve (or mint) the stable anonymous user ID.
 * Call once at activation; the result is cached in globalState.
 */
export function resolveUserId(context: vscode.ExtensionContext): string {
  // 1. Check globalState
  let id = context.globalState.get<string>(STATE_KEY);
  if (id) { return id; }

  // 2. Check OS fallback
  id = readFallback();
  if (id) {
    context.globalState.update(STATE_KEY, id);
    return id;
  }

  // 3. Mint new UUID
  id = crypto.randomUUID();
  context.globalState.update(STATE_KEY, id);
  writeFallback(id);
  return id;
}

/**
 * Reset the user ID — mints a new one and overwrites both stores.
 */
export function resetUserId(context: vscode.ExtensionContext): string {
  const id = crypto.randomUUID();
  context.globalState.update(STATE_KEY, id);
  writeFallback(id);
  return id;
}
