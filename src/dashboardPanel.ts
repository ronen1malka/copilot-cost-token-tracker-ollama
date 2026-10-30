/**
 * Webview panel management for the Cost Dashboard.
 */

import * as crypto from "crypto";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  findAllSessions, findSessionById,
  analyzeSession, analyzeSessionCost, analyzeAggregate, SessionAnalysis,
  parseSessionContext, parseSessionDeepDive, getModelsOverview,
} from "./sessionParser";
import { invalidateSessionCache } from "./sessionDiscovery";
import {
  refreshPricing, getPricingStatus, getCreditSettings, saveCreditSettings,
} from "./pricing";
import { resolveUserId } from "./userId";
import { exportData } from "./dataExporter";

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private static readonly viewType = "copilotCostDashboard";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionPath: string;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionPath: string, context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      "Copilot Cost & Token Tracker Dashboard",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(extensionPath)],
      },
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionPath, context);
  }

  private constructor(panel: vscode.WebviewPanel, extensionPath: string, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.extensionPath = extensionPath;
    this.context = context;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );
  }

  private dispose() {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }

  private async handleMessage(msg: any) {
    const { type, requestId } = msg;
    const includeSubagents = msg.include_subagents !== false;
    try {
      let data: any;
      switch (type) {
        case "getSessions": {
          let sessions = findAllSessions(msg.from_ts ? 9999 : (msg.hours || 12));
          if (msg.from_ts && msg.to_ts) {
            sessions = sessions.filter(s => s.ts >= msg.from_ts && s.ts <= msg.to_ts);
          }
          data = sessions.map(s => ({
            id: s.id, ts: s.ts, date: s.date,
            last_ts: s.last_ts, last_date: s.last_date,
            workspace_name: s.workspace_name,
            session_title: s.session_title,
          }));
          break;
        }
        case "getLatest": {
          let sessions = findAllSessions(msg.from_ts ? 9999 : (msg.hours || 12));
          if (msg.from_ts && msg.to_ts) {
            sessions = sessions.filter(s => s.ts >= msg.from_ts && s.ts <= msg.to_ts);
          }
          let found: SessionAnalysis | undefined;
          for (const session of sessions) {
            const analysis = analyzeSession(session, includeSubagents);
            if (analysis.totals.calls > 0) { found = analysis; break; }
          }
          if (!found) {
            this.postMessage({ type: "error", requestId, error: `No sessions in range` });
            return;
          }
          data = { ...found, creditSettings: getCreditSettings() };
          break;
        }
        case "getSession": {
          const result = findSessionById(msg.sessionId);
          if (!result) {
            this.postMessage({ type: "error", requestId, error: "Session not found" });
            return;
          }
          if ("_ambiguous" in result) {
            this.postMessage({ type: "error", requestId, error: "Ambiguous session ID" });
            return;
          }
          data = { ...analyzeSession(result as any, includeSubagents), creditSettings: getCreditSettings() };
          break;
        }
        case "getAggregate": {
          let aggSessions = findAllSessions(msg.from_ts ? 9999 : (msg.hours || 12));
          if (msg.from_ts && msg.to_ts) {
            aggSessions = aggSessions.filter(s => s.ts >= msg.from_ts && s.ts <= msg.to_ts);
          }
          const agg = analyzeAggregate(msg.hours || 12, aggSessions, includeSubagents);
          if (!agg) {
            this.postMessage({ type: "error", requestId, error: `No sessions in range` });
            return;
          }
          data = { ...agg, creditSettings: getCreditSettings() };
          break;
        }
        case "getModels": {
          const modelSessions = findAllSessions(9999);
          data = getModelsOverview(9999, modelSessions, includeSubagents);
          break;
        }
        case "refreshPricing": {
          invalidateSessionCache();
          await refreshPricing();
          const modelSessions = findAllSessions(9999);
          data = getModelsOverview(9999, modelSessions, includeSubagents);
          break;
        }
        case "getCreditSettings": {
          data = getCreditSettings();
          break;
        }
        case "updateCreditSettings": {
          data = saveCreditSettings(msg.settings || {});
          break;
        }
        case "getPricingSource": {
          data = getPricingStatus();
          break;
        }
        case "exportData": {
          const userId = resolveUserId(this.context);
          await exportData({
            userId,
            format: msg.format || "csv",
            fromTs: msg.from_ts,
            toTs: msg.to_ts,
            hours: msg.hours,
          });
          data = { ok: true };
          break;
        }
        case "getSessionCost": {
          const costResult = findSessionById(msg.sessionId);
          if (!costResult) {
            this.postMessage({ type: "error", requestId, error: "Session not found" });
            return;
          }
          if ("_ambiguous" in costResult) {
            this.postMessage({ type: "error", requestId, error: "Ambiguous session ID" });
            return;
          }
          data = analyzeSessionCost(costResult as any, includeSubagents);
          break;
        }
        case "getSessionContext": {
          const ctxResult = findSessionById(msg.sessionId);
          if (!ctxResult) {
            this.postMessage({ type: "error", requestId, error: "Session not found" });
            return;
          }
          if ("_ambiguous" in ctxResult) {
            this.postMessage({ type: "error", requestId, error: "Ambiguous session ID" });
            return;
          }
          data = parseSessionContext((ctxResult as any).path);
          break;
        }
        case "getSessionDeepDive": {
          const ddResult = findSessionById(msg.sessionId);
          if (!ddResult) {
            this.postMessage({ type: "error", requestId, error: "Session not found" });
            return;
          }
          if ("_ambiguous" in ddResult) {
            this.postMessage({ type: "error", requestId, error: "Ambiguous session ID" });
            return;
          }
          data = parseSessionDeepDive((ddResult as any).path, includeSubagents);
          break;
        }
        default:
          return;
      }
      this.postMessage({ type: "response", requestId, data });
    } catch (e: any) {
      this.postMessage({ type: "error", requestId, error: e.message || String(e) });
    }
  }

  private postMessage(msg: any) {
    this.panel.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionPath, "media", "dashboard.html");
    const nonce = DashboardPanel.getNonce();
    const iconUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, "images", "icon.png")));
    return fs.readFileSync(htmlPath, "utf-8")
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{iconUri}}/g, iconUri.toString());
  }

  private static getNonce(): string {
    return crypto.randomBytes(16).toString("base64");
  }
}
