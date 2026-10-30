# Copilot Cost & Token Tracker - With Ollama Cloud Support

> **Fork Notice:** This extension is a fork from [https://github.com/assaelaz/copilot-cost-token-tracker](https://github.com/assaelaz/copilot-cost-token-tracker), extended with **Ollama Cloud** model and pricing support, live pricing scraping from both GitHub Copilot and Ollama Cloud, configurable monthly AI Credit plans, and workspace-level filtering.

Visualise **GitHub Copilot** and **Ollama Cloud** agent session token costs directly inside VS Code. The extension runs locally, reads agent debug logs and chat sessions from your workspace storage and `~/.copilot/session-state`, and shows the latest session, a full session table with workspace filters, an aggregate summary, and a dedicated **Models** pricing catalog.

## Features

### Dashboard views

- **Latest Session** — live per-model and per-provider breakdown of your most recent Copilot / Ollama Cloud agent session; auto-refreshes while the session is active
- **All Sessions** — sortable table of every session in the selected window with interactive Workspace toggle filters (`All` / `None` / individual workspaces), Cost, Credits, and Cache Hit % columns; click any row to expand per-model detail inline
- **Aggregate** — rolled-up totals across all sessions in the selected time window, broken down by model and provider (`GitHub Copilot` vs. `Ollama Cloud`)
- **Models** — unified catalog of known models across **GitHub Copilot** and **Ollama Cloud**, live remote pricing scraping (`Update now`), configurable AI Credit plan allowances (e.g., Ollama Cloud Pro `$60` monthly credits for the `$20/mo` plan), and observed unmatched model tracking

### Cost & token details

- USD cost and AI Credits (1 credit = $0.01) totals for every session and aggregate view
- Automatic provider disambiguation (`GitHub Copilot` vs. `Ollama Cloud`) even for overlapping model families (e.g., `kimi-k3` / `kimi-k2.7-code`)
- Per-model token breakdown: fresh input, cached input, cache writes, and output tokens
- Cache hit rate per model with colour-coded health indicators
- Sub-agent call detection — badges distinguish main-agent vs. sub-agent LLM calls within a session

### Time filtering

- Preset time windows: 1 h, 6 h, 12 h, 24 h, 48 h, 72 h, 7 days, 30 days, 90 days, and 365 days
- Custom date-range picker to query any arbitrary period

### Pricing & model coverage

- Bundled `media/pricing.json` pricing table covering **GitHub Copilot** and **Ollama Cloud** model families
- Live pricing refresh from [docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) and [ollama.com/pricing](https://ollama.com/pricing)
- Intelligent model-key matching (provider prefix, `:cloud` tag, and substring) so minor version variants resolve to the exact provider and pricing rate
- Unknown models flagged with a warning and excluded from totals rather than silently misreported

### Privacy & portability

- Reads only local Copilot / Ollama Cloud agent logs from VS Code / VS Code Insiders workspace storage and `~/.copilot/session-state`
- Cross-platform support: macOS, Windows, and Linux storage paths resolved automatically
- No user session data leaves your machine

## Requirements

- VS Code 1.85 or later, or VS Code Insiders
- Existing Copilot / Ollama Cloud agent session logs in your local workspace storage or `~/.copilot/session-state`

## Installation

### From a VSIX

1. Download or build the `.vsix` file (`npm run package`)
2. Open the Extensions view in VS Code
3. Select `...` and choose `Install from VSIX...`
4. Pick the `.vsix` file
5. Reload when prompted

## Usage

Open the dashboard with any of these entry points:

- Status bar: `Token Cost`
- Activity bar: `Token Cost Tracker (Ollama Cloud)`
- Command Palette: `Copilot Cost & Token Tracker - With Ollama Cloud Support: Open Dashboard`

## Commands

| Command | Description |
| --- | --- |
| `Copilot Cost & Token Tracker - With Ollama Cloud Support: Open Dashboard` | Open the dashboard webview |
| `Copilot Cost & Token Tracker - With Ollama Cloud Support: Reset Export User ID` | Reset the anonymous UUID used for CSV/JSON exports |

## Privacy

- Reads only local Copilot and Ollama Cloud agent session logs.
- Does not send session data or prompts to any external service (network requests are only made to GitHub Docs and Ollama pricing pages when refreshing model pricing).
- Unknown models are excluded from totals and flagged in the dashboard.

## How It Works

The extension scans local VS Code workspace storage directories (`debug-logs` and `chatSessions`) as well as `~/.copilot/session-state`, parses the JSONL session data, resolves each model's provider (`GitHub Copilot` or `Ollama Cloud`), and computes token usage and cost totals locally.

## Model Coverage

The bundled pricing table (`media/pricing.json`) covers both GitHub Copilot and Ollama Cloud model families and can be updated on demand from the **Models** tab. If a model is not present in the pricing catalog, it is shown with a warning and excluded from totals.

## Troubleshooting

- If the dashboard is empty, make sure you have an existing Copilot / Ollama Cloud agent session within the selected time window.
- If a model is missing pricing data, click **Update now** in the **Models** tab or check the **Observed models without an exact price** table.

## Development

### Prerequisites

- **Node.js** (v20+ recommended) and **npm**
- **VS Code** (`^1.85.0`) or **VS Code Insiders**

### 1. Install Dependencies & Build

Clone the repository, install dependencies, and compile the TypeScript sources (`src/*.ts` -> `out/*.js`):

```bash
npm install
npm run compile
```

To continuously recompile TypeScript files on save during development:

```bash
npm run watch
```

### 2. Verify Core Runtime Logic (CLI Test)

After compiling, you can verify pricing resolution, session discovery, and token/cost parsing directly from the terminal without launching an Extension Host:

```bash
npm run compile
node test-runtime.js
```

### 3. Run & Debug the Extension in VS Code

1. Open this repository folder in VS Code (`code .`).
2. Ensure the project is compiled (`npm run compile` or keep `npm run watch` running in a terminal).
3. Launch the **Extension Development Host**:
   - Press **`F5`** (or go to **Run and Debug** `Ctrl+Shift+D` / `Cmd+Shift+D` -> select **Run Extension**).
   - `.vscode/launch.json` is pre-configured to launch this extension and automatically disable the original `netcomlabs-ai.copilot-cost-token-tracker` extension in the debug window so they do not conflict.
4. In the newly opened `[Extension Development Host]` window, open the dashboard using any entry point:
   - Click **`$(zap) Token Cost`** in the bottom Status Bar
   - Click the **Token Cost Tracker** icon in the Activity Bar
   - Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`Copilot Cost & Token Tracker - With Ollama Cloud Support: Open Dashboard`**

#### Debugging Tips

- **Extension Host (Backend TypeScript)**: Set breakpoints directly in `src/*.ts` files (e.g., `src/extension.ts`, `src/dashboardPanel.ts`, `src/sessionParser.ts`, `src/sessionDiscovery.ts`). Output and console logs appear in the **Debug Console** of your main VS Code window.
- **Dashboard Webview (Frontend HTML/JS)**: In the `[Extension Development Host]` window, open the Command Palette and run **`Developer: Open Webview Developer Tools`** to inspect the DOM, styles, and console logs for `media/dashboard.html`.
- **Reloading Changes**:
  - For changes in `media/dashboard.html` or `media/pricing.json`: close and reopen the dashboard panel (or run `Developer: Reload Window` in the Extension Development Host).
  - For changes in `src/*.ts`: ensure `npm run compile` (or `npm run watch`) has completed, then press `Ctrl+R` / `Cmd+R` (or click the **Restart** button in the debug toolbar) to reload the Extension Development Host.

### 4. Package & Install Locally (`.vsix`)

To build a standalone `.vsix` package and install it in your local VS Code instance:

```bash
npm run package
```

This compiles the TypeScript code and outputs `copilot-cost-token-tracker-ollama-<version>.vsix` in the project root. You can install it via the UI (**Extensions** -> `...` -> **Install from VSIX...**) or from the CLI:

```bash
code --install-extension copilot-cost-token-tracker-ollama-1.1.5.vsix
```

## Supported Ollama Cloud Models & Tags

Built for developers using **Ollama Cloud** (`ollama.com/pricing`, Ollama Pro `$20/mo` with `$60` AI Credits, Ollama Max `$100/mo` with `$300` AI Credits) alongside **GitHub Copilot Chat** (including BYOK / Custom Endpoint / Ollama provider integrations in VS Code):

- **Moonshot AI (Kimi)**: `kimi-k2.5:cloud`, `kimi-k2-thinking:cloud`, `kimi-k3:cloud`, `kimi-k2.7-code`
- **Zhipu AI (GLM)**: `glm-5.1:cloud`, `glm-5:cloud`, `glm-4.7:cloud`, `glm-4.6:cloud`
- **DeepSeek**: `deepseek-v3.2:cloud`, `deepseek-v3.1:671b:cloud`
- **Alibaba (Qwen)**: `qwen3.5:397b:cloud`, `qwen3.5:cloud`, `qwen3-coder-next:cloud`, `qwen3-coder:480b:cloud`, `qwen3-next:80b:cloud`, `qwen3-vl:235b:cloud`
- **MiniMax**: `minimax-m2.7:cloud`, `minimax-m2.5:cloud`, `minimax-m2.1:cloud`, `minimax-m2:cloud`
- **Google / Mistral / NVIDIA / OpenAI OSS**: `gemma4:31b:cloud`, `devstral-2:123b:cloud`, `devstral-small-2:24b:cloud`, `ministral-3:14b:cloud`, `nemotron-3-super:cloud`, `nemotron-3-nano:30b:cloud`, `gpt-oss:120b:cloud`, `gpt-oss:20b:cloud`

**Tags:** `ollama`, `ollama-cloud`, `ollama cloud`, `ollama pricing`, `ollama cost`, `ollama tokens`, `ollama credits`, `ollama usage`, `ollama pro`, `ollama max`, `github-copilot`, `copilot-chat`, `byok`, `token-tracker`, `cost-tracker`, `ai-credits`, `llm-cost`

## Credits & Attribution

Forked from [https://github.com/assaelaz/copilot-cost-token-tracker](https://github.com/assaelaz/copilot-cost-token-tracker).

## License

MIT
