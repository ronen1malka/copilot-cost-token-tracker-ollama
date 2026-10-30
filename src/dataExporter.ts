/**
 * Data export — per-session × model grain, CSV or JSON.
 */

import * as vscode from "vscode";
import { findAllSessions } from "./sessionDiscovery";
import { parseSession, computeCost } from "./sessionParser";
import { vendorFor } from "./pricing";

interface ExportRow {
  date: string;           // YYYY-MM-DD HH:MM (session start, local time)
  session_id: string;
  workspace: string;
  session_title: string;
  model: string;
  vendor: string;
  calls: number;
  user_turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  estimated_cost_usd: number;
}

function buildRows(fromTs: number, toTs: number, hours: number | undefined): ExportRow[] {
  const sessions = findAllSessions(fromTs ? 9999 : (hours || 12));
  const filtered = fromTs && toTs
    ? sessions.filter(s => s.ts >= fromTs && s.ts <= toTs)
    : sessions;

  const rows: ExportRow[] = [];

  for (const session of filtered) {
    const stats = parseSession(session.path);
    const sessionDateTime = fmtDateTime(session.ts);
    for (const [model, st] of stats) {
      const costed = computeCost(model, { ...st, _user_turn_ids: new Set() });
      rows.push({
        date: sessionDateTime,
        session_id: session.id,
        workspace: session.workspace_name,
        session_title: session.session_title,
        model,
        vendor: vendorFor(model),
        calls: st.calls,
        user_turns: st.user_turns,
        input_tokens: st.input_tokens,
        output_tokens: st.output_tokens,
        cache_creation_tokens: st.cache_write_tokens,
        cache_read_tokens: st.cached_tokens,
        estimated_cost_usd: Math.round(costed.cost * 10000) / 10000,
      });
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.session_id.localeCompare(b.session_id) || a.model.localeCompare(b.model));
  return rows;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}`;
}

const CSV_HEADER = "date,session_id,workspace,session_title,model,vendor,calls,user_turns,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,estimated_cost_usd";

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function formatCsv(rows: ExportRow[]): string {
  const lines = rows.map(r =>
    [
      escapeCsvField(r.date),
      r.session_id,
      escapeCsvField(r.workspace),
      escapeCsvField(r.session_title),
      r.model,
      r.vendor,
      String(r.calls),
      String(r.user_turns),
      String(r.input_tokens),
      String(r.output_tokens),
      String(r.cache_creation_tokens),
      String(r.cache_read_tokens),
      r.estimated_cost_usd.toFixed(4),
    ].join(",")
  );
  return CSV_HEADER + "\n" + lines.join("\n") + "\n";
}

function formatJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2) + "\n";
}

function dateLabel(ts: number | undefined, hours: number | undefined): string {
  const d = ts ? new Date(ts) : new Date(Date.now() - (hours || 12) * 3600_000);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D}-${h}_${m}`;
}

export interface ExportDataOptions {
  userId: string;
  format: "csv" | "json";
  fromTs?: number;
  toTs?: number;
  hours?: number;
}

export async function exportData(opts: ExportDataOptions): Promise<void> {
  const rows = buildRows(opts.fromTs || 0, opts.toTs || 0, opts.hours);
  if (rows.length === 0) {
    vscode.window.showWarningMessage("No data to export for the selected range.");
    return;
  }

  const isCsv = opts.format === "csv";
  const content = isCsv ? formatCsv(rows) : formatJson(rows);
  const ext = isCsv ? "csv" : "json";
  const fromLabel = dateLabel(opts.fromTs, opts.hours);
  const toLabel = dateLabel(opts.toTs, undefined);
  const defaultName = `${opts.userId}-from-${fromLabel}-to-${toLabel}-tokens.${ext}`;

  const filters: { [name: string]: string[] } = isCsv
    ? { "CSV Files": ["csv"], "All Files": ["*"] }
    : { "JSON Files": ["json"], "All Files": ["*"] };

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultName),
    filters,
    saveLabel: `Export ${ext.toUpperCase()}`,
  });

  if (!uri) { return; }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
  vscode.window.showInformationMessage(`Exported ${rows.length} rows to ${uri.fsPath}`);
}
