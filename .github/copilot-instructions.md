# Copilot Cost & Token Tracker — Instructions for GitHub Copilot

## Project Overview
**Copilot Cost & Token Tracker** (`copilot-cost-token-tracker`) is a VS Code extension that locally tracks, analyzes, and visualizes token usage and USD / AI Credit costs for AI agent sessions inside VS Code. It reads local debug logs (`main.jsonl`, `runSubagent-*.jsonl`, `title-*.jsonl`) from VS Code workspace storage without sending any data externally.

## Build, Test & Package Commands
- **Install dependencies**: `npm install`
- **Compile TypeScript**: `npm run compile` (`tsc -p ./` -> outputs CommonJS JS to `out/`)
- **Watch mode**: `npm run watch` (`tsc -watch -p ./`)
- **Run runtime verification tests**: `node test-runtime.js` (requires `npm run compile` first)
- **Package `.vsix`**: `npm run package` (`npx @vscode/vsce package --no-dependencies --allow-missing-repository`)

## Repository Architecture

```text
├── src/
│   ├── extension.ts         # Extension entry point (activate/deactivate, commands, status bar, auto-enables debug logging)
│   ├── dashboardPanel.ts    # WebviewPanel lifecycle, HTML template token replacement, & postMessage RPC router
│   ├── sessionDiscovery.ts  # Cross-platform workspaceStorage scanner, workspace name & session title resolution, 10s cache
│   ├── sessionParser.ts     # JSONL log parser: per-model stats, cost math, SessionContext discovery, and Deep Dive turn/call analysis
│   ├── pricing.ts           # Loads media/pricing.json, normalizes model names, prefix/substring alias matching, vendor lookup
│   ├── dataExporter.ts      # Exports session × model grain data to CSV or JSON via VS Code save dialog
│   └── userId.ts            # Mints/resolves stable anonymous UUID in globalState + OS-level user-id.json fallback
├── media/
│   ├── dashboard.html       # Single-file Webview UI (HTML + CSS variables + vanilla JS RPC client)
│   └── pricing.json         # Model pricing table (USD per 1M tokens: input, cached_input, cache_write, output) & vendor prefixes
├── specs/                   # Feature and performance specifications (Deep Dive, lazy loading)
└── test-runtime.js          # Node script validating pricing lookups, alias matching, session discovery, and parsing
```

## Log Discovery & JSONL Schema

1. **Storage Locations (`src/sessionDiscovery.ts`)**
   - Scans `Code` and `Code - Insiders` under `%APPDATA%` (Windows), `~/Library/Application Support` (macOS), or `$XDG_CONFIG_HOME` / `~/.config` (Linux), plus `~/.vscode-server` and `~/.vscode-server-insiders` on non-Windows.
   - Session logs live at: `<workspaceStorage>/<workspaceHash>/GitHub.copilot-chat/debug-logs/<sessionId>/`.
   - **Filtering rules**:
     - Must have a matching `<workspaceStorage>/<workspaceHash>/chatSessions/<sessionId>.jsonl` (`hasChatSessionRecord()`) to exclude internal helper runs.
     - `main.jsonl` must be $\ge 1024$ bytes.
     - Deduplicates sessions across workspaces via `pickBest()` (prefers larger `main.jsonl`, then non-`untitled` title and known workspace name).
     - Results are cached in memory for 10 seconds (`SESSION_CACHE_TTL`).

2. **Session Directory Files & JSONL Entry Types (`src/sessionParser.ts`)**
   - `main.jsonl`: Primary session log.
   - `runSubagent-*.jsonl`: Sub-agent execution logs (`isSubagent = true`).
   - `title-*.jsonl`: Title generation log (`type === "agent_response"` -> `attrs.response`).
   - **Parsed JSONL `type` values**:
     - `user_message`: `attrs.content` — increments the 1-based user turn counter (`currentTurnId`; turn `0` is pre-message `Setup`).
     - `llm_request` (`status === "ok"`): `attrs.model`, `attrs.inputTokens`, `attrs.outputTokens`, `attrs.cachedTokens`, `attrs.cacheWriteTokens`, `attrs.debugName`, `attrs.ttft`, and top-level `ts`.
     - `tool_call`: `name`, `ts`, `dur`, `status`, and `attrs.args` / `attrs.input` (parses `read_file` paths to match invoked `SKILL.md` / skill files).
     - `child_session_ref`: `attrs.label` (strips `runSubagent-` prefix to record invoked custom agents).
     - `discovery`: `attrs.details` (parses `Resolved N agents|instructions|slash commands|skills | loaded: [...] | folders: [...]`).
     - `generic` (`name === "Resolve Customizations"`, `status === "ok"`): `attrs.details` (`[applying] <file> —` for per-turn applied instructions).
     - **Noise types** (`discovery`, `turn_start`, `turn_end`, `session_start`): Ignored in `sessionLastTs()` so background IDE sweeps do not corrupt `last_ts`.

## Key Technical Conventions & Constraints

### 1. Zero Runtime Dependencies
- The extension packages with `--no-dependencies`.
- Use **only** Node.js built-in modules (`fs`, `path`, `os`, `crypto`) and the `vscode` API in `src/`. Do not add runtime `dependencies` to `package.json`.
- TypeScript is configured with `"strict": true`, `"target": "ES2020"`, and `"module": "commonjs"`.

### 2. Cost Calculation Single Source of Truth
- `computeCallCost()` in `src/sessionParser.ts` is the canonical cost formula:
  - $\text{freshInput} = \max(0, \text{inputTokens} - \text{cachedTokens} - \text{cacheWriteTokens})$
  - Rates in `media/pricing.json` are USD per $1,000,000$ tokens.
  - AI Credits are derived at $1\text{ credit} = \$0.01\text{ USD}$ (`cost * 100`).
  - In `computeCost()` / `analyzeAggregate()`, if a model has `cache_write` pricing (`pricing.cache_write !== undefined`) and no `cachedTokens` field was seen (`!any_cached_field_seen`), cached tokens are estimated using `ASSUMED_CACHE_RATIO = 0.85` (`cache_assumed = true`). Per-call deep dive (`parseSessionDeepDive()`) uses `0` when `cachedTokens` is absent (`rawCached = -1`).
- Both model-level aggregation (`computeCost()`) and turn/call breakdown (`parseSessionDeepDive()`) **must** delegate to `computeCallCost()`.
- Unknown models (missing from `media/pricing.json`) must return a `warning` on `ModelResult` and be excluded from cost/token rollups rather than silently misreported as `$0`.

### 3. Webview (`media/dashboard.html`) & CSP Rules
- **Template Placeholders**: `DashboardPanel.getHtml()` replaces `{{cspSource}}`, `{{nonce}}`, and `{{iconUri}}` in `media/dashboard.html`.
- **Strict Content Security Policy**: `script-src 'nonce-{{nonce}}'`. Inline event handlers (e.g., `onclick="..."`) are **blocked by CSP**. Always attach listeners via `addEventListener` or delegated event handlers using `data-*` attributes.
- **XSS & Selector Safety**:
  - Wrap all dynamic text interpolated into HTML templates with `escapeHtml()`.
  - Wrap all dynamic IDs/values used in DOM query selectors with `cssEscape()` / `CSS.escape()`.
- **Duplicate DOM IDs**: The same session can be rendered simultaneously in both "Latest Session" and "All Sessions". Scope DOM lookups (e.g., `[id="deep-dive-${sessionId}"]`) to the parent `.detail-panel` or row container rather than global `document.getElementById`.
- **RPC Protocol**: Frontend calls `rpc(type, params)` which posts `{ type, requestId, ...params }` to `DashboardPanel.handleMessage()`, which replies with `{ type: "response" | "error", requestId, data | error }`.

### 4. Performance & Lazy Loading
- Keep bulk session table loading fast: `loadSessions()` uses the lightweight `getSessionCost` RPC (`analyzeSessionCost()`), which skips `parseSessionContext()` and returns only `{ id, totals: { cost, cache_ratio } }`.
- Full session analysis (`getSession` -> `analyzeSession()`), context (`getSessionContext` -> `parseSessionContext()`), and per-turn/per-call breakdown (`getSessionDeepDive` -> `parseSessionDeepDive()`) are fetched on demand and cached in the webview (`sessionsCache`, `_ddData`, `_ddCtx`).
- Custom date ranges and Month-to-Date (`mtd`) pass `{ from_ts, to_ts }` in RPC calls; the backend queries `findAllSessions(9999)` and filters by `s.ts >= from_ts && s.ts <= to_ts`.

### 5. Privacy
- All log parsing and cost computation must remain 100% local on the user's machine. Never transmit session contents, prompts, file paths, or telemetry over the network.
