import * as vscode from "vscode";
import { DashboardPanel } from "./dashboardPanel";
import { loadPricing } from "./pricing";
import { resolveUserId, resetUserId } from "./userId";
export function activate(context: vscode.ExtensionContext) {
  loadPricing(context.extensionUri.fsPath);
  console.log("[Copilot Cost & Token Tracker] Pricing loaded from bundled pricing.json");

  // Resolve (or mint) stable anonymous user ID
  resolveUserId(context);

  const config = vscode.workspace.getConfiguration("github.copilot.chat.agentDebugLog.fileLogging");
  if (config.get("enabled") !== true) {
    config.update("enabled", true, vscode.ConfigurationTarget.Global);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotCost.openDashboard", () => {
      DashboardPanel.createOrShow(context.extensionUri.fsPath, context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotCost.resetUserId", () => {
      const newId = resetUserId(context);
      vscode.window.showInformationMessage(`User ID reset to ${newId.slice(0, 8)}…`);
    }),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "copilotCost.openDashboard";
  statusBar.text = "$(zap) Token Cost";
  statusBar.tooltip = "Open Copilot Cost & Token Tracker Dashboard";
  statusBar.show();
  context.subscriptions.push(statusBar);
}

export function deactivate() {}
