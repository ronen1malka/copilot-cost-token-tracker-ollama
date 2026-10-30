# Copilot Cost & Token Tracker

Visualise Copilot agent session token costs directly inside VS Code. The extension runs locally, reads agent debug logs from your workspace storage, and shows the latest session, a full session table, and an aggregate summary.

## Features

### Dashboard views

- **Latest Session** — live per-model breakdown of your most recent Copilot agent session; auto-refreshes while the session is active
- **All Sessions** — sortable table of every session in the selected window with Cost, Credits, and Cache Hit % columns; click any row to expand per-model detail inline
- **Aggregate** — rolled-up totals across all sessions in the selected time window, broken down by model

### Cost & token details

- USD cost and AI Credits (1 credit = $0.01) totals for every session and aggregate view
- Per-model token breakdown: fresh input, cached input, cache writes, and output tokens
- Cache hit rate per model with colour-coded health indicators
- Sub-agent call detection — badges distinguish main-agent vs. sub-agent LLM calls within a session

### Time filtering

- Preset time windows: 6 h, 12 h, 24 h, 48 h, 72 h, and 7 days
- Custom date-range picker to query any arbitrary period

### Pricing & model coverage

- Bundled `media/pricing.json` pricing table covering all major Copilot model families
- Intelligent model-key matching (prefix and substring) so minor version variants resolve correctly
- Unknown models flagged with a warning and excluded from totals rather than silently misreported

### Privacy & portability

- Reads only local Copilot agent debug logs from VS Code / VS Code Insiders workspace storage
- Cross-platform support: macOS, Windows, and Linux storage paths resolved automatically
- No data leaves your machine

## Requirements

- VS Code 1.119 or later, or VS Code Insiders
- Existing Copilot agent session logs in your local workspace storage

## Installation

### From the Marketplace

1. Open the Extensions view in VS Code
2. Search for `Copilot Cost & Token Tracker`
3. Install the extension
4. Reload when prompted

### From a VSIX

1. Download the `.vsix` file
2. Open the Extensions view
3. Select `...` and choose `Install from VSIX...`
4. Pick the downloaded `.vsix` file
5. Reload when prompted

## Usage

Open the dashboard with any of these entry points:

- Status bar: `Token Cost`
- Activity bar: `Token Cost Tracker`
- Command Palette: `Copilot Cost & Token Tracker: Open Dashboard`

Use the Time window dropdown in the dashboard to switch between 6h, 12h, 24h, 48h, 72h, and 7 days.

## Commands

| Command | Description |
| --- | --- |
| `Copilot Cost & Token Tracker: Open Dashboard` | Open the dashboard webview |

## Privacy

- Reads only local Copilot agent debug logs.
- Does not send data to an external service.
- Unknown models are excluded from totals and flagged in the dashboard.

## How It Works

The extension scans local VS Code workspace storage directories, finds Copilot agent debug-log sessions, parses the JSONL data, and computes token usage and cost totals locally.

## Model Coverage

The bundled pricing table currently covers the model families used by the extension. If a model is not present in `media/pricing.json`, it is shown with a warning and excluded from totals.

## Troubleshooting

- If the dashboard is empty, make sure you have an existing Copilot agent session and that VS Code has created workspace storage debug logs.
- If a model is missing pricing data, it will be shown with a warning and its cost will be excluded.

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
   - Press **`F5`** (or go to **Run and Debug** `Ctrl+Shift+D` / `Cmd+Shift+D` -> select **VS Code Extension Development**).
   - *Optional*: If prompted or if you want a dedicated launch configuration, create `.vscode/launch.json`:
     ```json
     {
       "version": "0.2.0",
       "configurations": [
         {
           "name": "Run Extension",
           "type": "extensionHost",
           "request": "launch",
           "args": [
             "--extensionDevelopmentPath=${workspaceFolder}"
           ],
           "outFiles": [
             "${workspaceFolder}/out/**/*.js"
           ]
         }
       ]
     }
     ```
4. In the newly opened `[Extension Development Host]` window, open the dashboard using any entry point:
   - Click **`$(zap) Token Cost`** in the bottom Status Bar
   - Click the **Token Cost Tracker** icon in the Activity Bar
   - Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`Copilot Cost & Token Tracker: Open Dashboard`**

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

This compiles the TypeScript code and outputs `copilot-cost-token-tracker-<version>.vsix` in the project root. You can install it via the UI (**Extensions** -> `...` -> **Install from VSIX...**) or from the CLI:

```bash
code --install-extension copilot-cost-token-tracker-1.1.5.vsix
```

## License

MIT
