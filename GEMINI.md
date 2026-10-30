# Copilot Cost & Token Tracker — Antigravity Workspace Rules

## Project Overview
**Copilot Cost & Token Tracker** (`copilot-cost-token-tracker`) is a VS Code extension that tracks, analyzes, and visualizes token usage and USD / AI Credit costs for AI agent sessions in VS Code. It operates entirely locally by scanning and parsing agent debug logs in VS Code workspace storage.

## Build, Test & Packaging
- **Install dependencies**: `npm install`
- **Compile TypeScript**: `npm run compile` (`tsc -p ./` -> compiles `src/*.ts` into `out/*.js`)
- **Watch mode**: `npm run watch`
- **Verify runtime logic**: `node test-runtime.js` (run `npm run compile` first so `out/` is up to date)
- **Package extension (`.vsix`)**: `npm run package` (`npx @vscode/vsce package --no-dependencies --allow-missing-repository`)

## Codebase Structure
- `src/extension.ts`: Extension entry point (`activate` / `deactivate`), loads bundled pricing, resolves anonymous user ID, registers commands (`copilotCost.openDashboard`, `copilotCost.resetUserId`), creates status bar item (`$(zap) Token Cost`), and ensures `github.copilot.chat.agentDebugLog.fileLogging.enabled` is set to `true` globally.
- `src/dashboardPanel.ts`: Manages the `vscode.WebviewPanel` (`copilotCostDashboard`), injects `{{cspSource}}`, `{{nonce}}`, and `{{iconUri}}` into `media/dashboard.html`, and handles postMessage RPC requests (`getLatest`, `getSessions`, `getSession`, `getSessionCost`, `getSessionContext`, `getSessionDeepDive`, `getAggregate`, `getPricingSource`, `exportData`).
- `src/sessionDiscovery.ts`: Cross-platform discovery of session logs across `Code`, `Code - Insiders`, and `.vscode-server` `User/workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<sessionId>/` directories. Requires a matching `chatSessions/<sessionId>.jsonl` and `main.jsonl >= 1024` bytes. Resolves workspace names from `workspace.json`, extracts session titles from `title-*.jsonl` (or first `user_message`), deduplicates via `pickBest()`, and caches discovery results (`SESSION_CACHE_TTL = 10_000`).
- `src/sessionParser.ts`: Parses `main.jsonl` and `runSubagent-*.jsonl` files for token counts (`parseSession`), per-model/per-call costs (`computeCost`, `computeCallCost`), lightweight cost-only summary (`analyzeSessionCost`), customization discovery (`parseSessionContext`), and turn-by-turn / call-by-call deep-dive analysis (`parseSessionDeepDive`).
- `src/pricing.ts`: Loads `media/pricing.json`, normalizes model names, matches versioned model aliases by exact key or longest substring (`findPricing`, `canonicalModel`), and maps model prefixes to vendors (`vendorFor`).
- `src/dataExporter.ts`: Exports `session × model` usage rows to CSV or JSON via `vscode.window.showSaveDialog` with filename format `<userId>-from-<fromLabel>-to-<toLabel>-tokens.<ext>`.
- `src/userId.ts`: Mints and persists a stable anonymous UUID in VS Code `globalState` (`copilotCost.anonymousUserId`) with an OS-specific file fallback (`copilot-cost-tracker/user-id.json`).
- `media/dashboard.html`: Single-file Webview frontend containing all styles, HTML views (`Latest Session`, `All Sessions`, `Aggregate`, inline `Analysis` deep dive, and `Discovery`), and vanilla JS RPC logic.
- `media/pricing.json`: Bundled model pricing rates (USD per 1M tokens) and vendor prefix definitions.

## JSONL Log Format & Parsed Entry Types
- `user_message`: `attrs.content` increments the 1-based user turn ID (`0` = pre-message `Setup` turn).
- `llm_request` (`status === "ok"`): `attrs.model`, `attrs.inputTokens`, `attrs.outputTokens`, `attrs.cachedTokens`, `attrs.cacheWriteTokens`, `attrs.debugName` (e.g., `panel/editAgent`, `summarizeConversationHistory`), `attrs.ttft`, and top-level `ts`.
- `tool_call`: `name`, `ts`, `dur`, `status`, and `attrs.args` / `attrs.input` (used for Deep Dive tool chips and matching `read_file` calls against discovered skill file paths).
- `child_session_ref`: `attrs.label` (strips `runSubagent-` prefix to identify custom agent invocations).
- `discovery`: `attrs.details` (`Resolved N agents|instructions|slash commands|skills | loaded: [...] | folders: [...]`).
- `generic` (`name === "Resolve Customizations"`, `status === "ok"`): `attrs.details` (`[applying] <file> —` for per-turn instructions).
- Noise events excluded from `sessionLastTs()`: `discovery`, `turn_start`, `turn_end`, `session_start`.

## Architectural & Coding Rules

1. **No Runtime NPM Dependencies**:
   - The extension is packaged with `--no-dependencies`. Only use Node.js built-ins (`fs`, `path`, `os`, `crypto`) and the `vscode` API in `src/`.
   - Maintain strict TypeScript compilation (`"strict": true`, `"target": "ES2020"`, `"module": "commonjs"`).

2. **Cost Calculation Accuracy**:
   - Always use `computeCallCost()` in `src/sessionParser.ts` as the single source of truth for token cost arithmetic:
     - $\text{freshInput} = \max(0, \text{inputTokens} - \text{cachedTokens} - \text{cacheWriteTokens})$
     - Rates in `media/pricing.json` are per $1,000,000$ tokens; AI Credits = $\text{cost} \times 100$ ($1\text{ credit} = \$0.01$).
     - Aggregate model stats (`computeCost` / `analyzeAggregate`) estimate cached tokens with `ASSUMED_CACHE_RATIO = 0.85` when a model defines `cache_write` pricing but no `cachedTokens` field was logged; per-call deep dive (`parseSessionDeepDive`) uses `0` when `cachedTokens` is absent.
   - If a model is not found in `media/pricing.json`, flag it with a `warning` on `ModelResult` and exclude it from aggregated cost totals rather than silently reporting `$0`.

3. **Webview CSP & DOM Safety (`media/dashboard.html`)**:
   - `media/dashboard.html` enforces a strict Content Security Policy (`script-src 'nonce-{{nonce}}'`). Never use inline event attributes (`onclick`, `onchange`, etc.); always bind events in script using `addEventListener` or delegated listeners with `data-*` attributes.
   - Always sanitize dynamic values rendered into HTML with `escapeHtml()`, and escape dynamic attribute selectors with `cssEscape()` / `CSS.escape()`.
   - Because the same session can be displayed in both the `Latest Session` view and an expanded row in `All Sessions`, scope DOM queries to the relevant `.detail-panel` or container element to avoid duplicate ID collisions.

4. **Performance & Lazy Loading**:
   - Bulk table loading in `All Sessions` must use `getSessionCost` (`analyzeSessionCost`) so `parseSessionContext` is not run for every row on load.
   - Keep `getSessionContext` and `getSessionDeepDive` lazy (on-demand) and cache results on the frontend (`sessionsCache`, `_ddData`, `_ddCtx`).
   - In `sessionLastTs()` (`src/sessionDiscovery.ts`), continue excluding noise event types (`discovery`, `turn_start`, `turn_end`, `session_start`) so background IDE sweeps do not corrupt last-active timestamps.

5. **Local-Only Privacy**:
   - Never introduce network calls that transmit user session data, prompts, file paths, or usage telemetry outside the machine.
