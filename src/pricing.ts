/**
 * Pricing table (USD per 1 million tokens).
 *
 * Loaded at activation from:
 *   1. Remote URL (setting copilotCost.pricingUrl) — if configured
 *   2. Bundled media/pricing.json — fallback
 *
 * Call `loadPricing()` once at activation; call `refreshPricing()` to
 * re-fetch from the remote URL on demand.
 */

import * as fs from "fs";
import * as path from "path";

export interface ModelPricing {
  input: number;
  cached_input: number;
  cache_write?: number;
  output: number;
}

// ── Runtime state (mutable, loaded at activation) ──────────────────────

let PRICING: Record<string, ModelPricing> = {};
let VENDOR_MAP: [string, string][] = [];
let _extensionPath: string = "";

export const ASSUMED_CACHE_RATIO = 0.85;

export function getPricing(): Record<string, ModelPricing> { return PRICING; }

// ── Loading ────────────────────────────────────────────────────────────

interface PricingFile {
  models: Record<string, ModelPricing>;
  vendors?: { prefix: string; name: string }[];
}

function applyPricingData(data: PricingFile) {
  PRICING = data.models || {};
  if (data.vendors) {
    VENDOR_MAP = data.vendors.map(v => [v.prefix, v.name]);
  }
}

function loadBundled() {
  const jsonPath = path.join(_extensionPath, "media", "pricing.json");
  const raw = fs.readFileSync(jsonPath, "utf-8");
  applyPricingData(JSON.parse(raw));
}

/**
 * Load pricing data. Call once at activation.
 * @param extensionPath  context.extensionUri.fsPath
 */
export function loadPricing(extensionPath: string): void {
  _extensionPath = extensionPath;
  loadBundled();
}

// ── Lookups (same interface as before) ─────────────────────────────────

export function vendorFor(modelKey: string): string {
  for (const [prefix, vendor] of VENDOR_MAP) {
    if (modelKey.startsWith(prefix)) { return vendor; }
  }
  return "Other";
}

function normalise(name: string): string {
  return name.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

export function findPricing(model: string): ModelPricing | undefined {
  const norm = normalise(model);
  if (PRICING[norm]) { return PRICING[norm]; }
  // Prefer longer (more specific) key matches to avoid "claude-sonnet-4" beating "claude-sonnet-4.6"
  const matches = Object.entries(PRICING).filter(([key]) => key.includes(norm) || norm.includes(key));
  matches.sort((a, b) => b[0].length - a[0].length);
  return matches[0]?.[1];
}

export function canonicalModel(model: string): string {
  const norm = normalise(model);
  if (PRICING[norm]) { return norm; }
  const keys = Object.keys(PRICING).filter(key => key.includes(norm) || norm.includes(key));
  keys.sort((a, b) => b.length - a.length);
  return keys[0] ?? model;
}
