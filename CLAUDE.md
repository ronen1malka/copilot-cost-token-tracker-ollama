# CLAUDE.md

This file provides guidance to Claude Code (`claude.ai/code`) when working with code in this repository.

## Project Summary
**Copilot Cost & Token Tracker** (`copilot-cost-token-tracker`) is a local-first VS Code extension that parses agent debug logs from VS Code workspace storage and visualizes token consumption, cache hit rates, and USD / AI Credit costs across sessions, models, user turns, and individual LLM calls.

## Common Commands
- **Install dependencies**: `npm install`
- **Build / Compile TypeScript**: `npm run compile` (runs `tsc -p ./`, emitting CommonJS JS to `out/`)
- **Watch build**: `npm run watch`
- **Run runtime test suite**: `node test-runtime.js` (requires `npm run compile` first; tests pricing lookup, model alias resolution, vendor detection, session discovery, and JSONL parsing)
- **Package VS Code extension (`.vsix`)**: `npm run package` (`npx @vscode/vsce package --no-dependencies --allow-missing-repository`)

## Architecture & Data Flow

1. **Extension Host (`src/`)**
   - `src/extension.ts`: Activates the extension, loads `media/pricing.json` via `loadPricing()`, initializes the anonymous user ID (`src/userId.ts`), auto-enables `github.copilot.chat.agentDebugLog.fileLogging.enabled` globally, and registers the status bar item (`$(zap) Token Cost`) and commands (`copilotCost.openDashboard`, `copilotCost.resetUserId`).
   - `src/sessionDiscovery.ts`: Locates session directories across OS-specific VS Code storage roots (`Code`, `Code - Insiders`, and `.vscode-server` on Linux/macOS) under `User/workspaceStorage/<id>/GitHub.copilot-chat/debug-logs/<sessionId>/`.
     - Validates that a corresponding `chatSessions/<sessionId>.jsonl` exists (`hasChatSessionRecord`) and `main.jsonl >= 1024` bytes.
     - Extracts workspace names from `workspace.json` and session titles from `title-*.jsonl` (`agent_response` -> `attrs.response`) or falls back to the first `user_message` in `main.jsonl`.
     - Deduplicates identical session IDs across workspaces via `pickBest()` and caches discovered sessions for 10s (`SESSION_CACHE_TTL`).
   - `src/pricing.ts`: Reads `media/pricing.json`. `findPricing()` and `canonicalModel()` normalize model names and match exact keys or longest substring matches (e.g., mapping versioned strings like `claude-sonnet-4-6-20250501` to `claude-sonnet-4.6`, while ensuring `claude-sonnet-4.6` beats `claude-sonnet-4`).
   - `src/sessionParser.ts`:
     - `parseSession()`: Reads `main.jsonl` and `runSubagent-*.jsonl`, aggregating `llm_request` (`status === "ok"`) token counts, call counts (main vs. sub-agent), and user turns per canonical model.
     - `computeCallCost()` & `computeCost()`: Computes USD cost from fresh input ($\max(0, \text{input} - \text{cached} - \text{cacheWrite})$), cached input, cache writes, and output tokens. Applies `ASSUMED_CACHE_RATIO` ($0.85$) in aggregate model calculations when a model supports `cache_write` but `cachedTokens` was not reported in the log.
     - `analyzeSession()` & `analyzeSessionCost()`: `analyzeSession()` computes full model breakdown + `SessionContext`; `analyzeSessionCost()` computes only `{ id, totals: { cost, cache_ratio } }` without context parsing for fast table loading.
     - `parseSessionContext()`: Parses `discovery`, `Resolve Customizations` (`[applying] ... —`), `tool_call` (`read_file` on skill paths), and `child_session_ref` entries to identify discovered and invoked skills, instructions, custom agents, and slash commands per turn.
     - `parseSessionDeepDive()`: Builds a hierarchical `TurnRecord[] -> CallRecord[]` breakdown (Turn `0` = pre-user-message Setup, Turn $1..N$ = user turns) with per-call cost, cache hit %, TTFT, tool call chips, sub-agent badges, and context summarization warnings (`debugName` containing `"summarize"`).
   - `src/dashboardPanel.ts`: Hosts the Webview (`media/dashboard.html`), substitutes `{{cspSource}}`, `{{nonce}}`, and `{{iconUri}}`, and routes asynchronous RPC messages (`getLatest`, `getSessions`, `getSession`, `getSessionCost`, `getSessionContext`, `getSessionDeepDive`, `getAggregate`, `getPricingSource`, `exportData`). For custom date ranges or Month-to-Date (`from_ts` / `to_ts`), queries `findAllSessions(9999)` and filters by `s.ts`.
   - `src/dataExporter.ts`: Generates CSV or JSON exports at the `session × model` grain (`<userId>-from-<fromLabel>-to-<toLabel>-tokens.<ext>`).

2. **Webview Frontend (`media/dashboard.html`)**
   - Self-contained HTML, CSS, and vanilla JavaScript communicating with the extension host via `vscode.postMessage` RPC (`rpc(type, params)`).
   - Views: **Latest Session** (auto-refreshes every 15s while a session is untitled or $< 5$ minutes old), **All Sessions** (sortable table with async per-row cost loading, inline row expansion, and CSV/JSON export), and **Aggregate** (rolled-up totals across the selected time window), plus inline **Analysis (Deep Dive)** and **Discovery** panels.

## Important Constraints & Guidelines

- **Zero Runtime Dependencies**: The `.vsix` is packaged with `--no-dependencies`. Use only Node.js standard library modules (`fs`, `path`, `os`, `crypto`) and `vscode` APIs in `src/`.
- **Webview Content Security Policy (CSP)**: `media/dashboard.html` uses `script-src 'nonce-{{nonce}}'`. Inline event handlers (`onclick=...`) are blocked by CSP. Always use `addEventListener` or event delegation with `data-*` attributes.
- **HTML & Selector Escaping**: Always escape user/log strings with `escapeHtml()` before inserting into `innerHTML`, and escape dynamic IDs in selectors with `cssEscape()` / `CSS.escape()`.
- **Avoid Duplicate ID Collisions in Webview**: A session can be rendered in both `Latest Session` and `All Sessions` simultaneously. Scope DOM lookups (such as `[id="deep-dive-${sessionId}"]`) to the closest `.detail-panel` rather than `document.getElementById`.
- **Keep Bulk Session Loading Fast**: `loadSessions()` uses `getSessionCost` (`analyzeSessionCost`) to avoid running `parseSessionContext()` across every session on table open. Keep context and deep-dive parsing lazy.
- **Unknown Models**: Models missing from `media/pricing.json` must set `warning` on `ModelResult` and be excluded from cost sums rather than silently treated as free.
