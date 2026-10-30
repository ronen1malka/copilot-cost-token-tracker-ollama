/**
 * Pricing table (USD per 1 million tokens) & Remote HTML Scrapers
 * for both GitHub Copilot and Ollama Cloud models.
 *
 * Loaded at activation from:
 *   1. Bundled media/pricing.json
 *   2. Cached remote pricing (if previously scraped)
 *   3. Live HTML scraping from:
 *      - https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 *      - https://ollama.com/pricing
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";

export type ModelProvider = "copilot" | "ollama";
export type PricingSourceType = "bundled" | "remote";

export interface ModelPricing {
  input: number;
  cached_input: number;
  cache_write?: number;
  output: number;
  provider?: ModelProvider;
  vendor?: string;
  source?: PricingSourceType;
}

export interface PricingStatusInfo {
  source: string;
  totalModels: number;
  copilotModels: number;
  ollamaModels: number;
  updatedAt: number | null;
  lastCheckedAt: number | null;
  copilotScrapedCount: number;
  ollamaScrapedCount: number;
  copilotError?: string;
  ollamaError?: string;
}

export interface CreditSettings {
  /** Monthly USD AI Credit pool for Ollama Cloud (Default: $60 for $20 Pro plan) */
  ollamaMonthlyCreditUsd: number;
  /** Ollama plan label ("free" | "pro" | "max" | "team" | "custom") */
  ollamaPlan: string;
  /** Monthly AI Credits allowance for GitHub Copilot (Default: 300 credits = $3.00 or custom) */
  copilotMonthlyCredits: number;
  /** USD value per 1 GitHub Copilot AI Credit (Default: $0.01) */
  copilotCreditUsdRate: number;
}

export interface ResolvedModelMatch {
  rawModel: string;
  provider: ModelProvider;
  canonicalKey: string;
  displayModel: string;
  vendor: string;
  pricing?: ModelPricing;
  isExact: boolean;
  proxyUsed: string | null;
}

export const GITHUB_COPILOT_PRICING_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
export const OLLAMA_PRICING_URL = "https://ollama.com/pricing";

export const ASSUMED_CACHE_RATIO = 0.85;
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Runtime state ──────────────────────────────────────────────────────

let BUNDLED_PRICING: Record<string, ModelPricing> = {};
let PRICING: Record<string, ModelPricing> = {};
let VENDOR_MAP: [string, string][] = [];
let _extensionPath: string = "";
let _updatedAt: number | null = null;
let _lastCheckedAt: number | null = null;
let _copilotScrapedCount = 0;
let _ollamaScrapedCount = 0;
let _copilotError: string | undefined;
let _ollamaError: string | undefined;
let _autoUpdateTimer: NodeJS.Timeout | null = null;

const DEFAULT_CREDIT_SETTINGS: CreditSettings = {
  ollamaMonthlyCreditUsd: 60,
  ollamaPlan: "pro",
  copilotMonthlyCredits: 3000,
  copilotCreditUsdRate: 0.01,
};

let _creditSettings: CreditSettings = { ...DEFAULT_CREDIT_SETTINGS };

export function getPricing(): Record<string, ModelPricing> {
  return PRICING;
}

// ── Config / Cache File Paths ──────────────────────────────────────────

function getConfigDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "copilot-cost-tracker");
    case "darwin":
      return path.join(home, "Library", "Application Support", "copilot-cost-tracker");
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "copilot-cost-tracker");
  }
}

function getPricingCachePath(): string {
  return path.join(getConfigDir(), "pricing-cache.json");
}

function getCreditSettingsPath(): string {
  return path.join(getConfigDir(), "credit-settings.json");
}

// ── Credit Settings Persistence ────────────────────────────────────────

export function loadCreditSettings(): CreditSettings {
  try {
    const p = getCreditSettingsPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      _creditSettings = {
        ollamaMonthlyCreditUsd:
          typeof raw.ollamaMonthlyCreditUsd === "number" && raw.ollamaMonthlyCreditUsd >= 0
            ? raw.ollamaMonthlyCreditUsd
            : DEFAULT_CREDIT_SETTINGS.ollamaMonthlyCreditUsd,
        ollamaPlan: typeof raw.ollamaPlan === "string" ? raw.ollamaPlan : DEFAULT_CREDIT_SETTINGS.ollamaPlan,
        copilotMonthlyCredits:
          typeof raw.copilotMonthlyCredits === "number" && raw.copilotMonthlyCredits >= 0
            ? raw.copilotMonthlyCredits
            : DEFAULT_CREDIT_SETTINGS.copilotMonthlyCredits,
        copilotCreditUsdRate:
          typeof raw.copilotCreditUsdRate === "number" && raw.copilotCreditUsdRate > 0
            ? raw.copilotCreditUsdRate
            : DEFAULT_CREDIT_SETTINGS.copilotCreditUsdRate,
      };
    }
  } catch {
    // Use defaults
  }
  return _creditSettings;
}

export function getCreditSettings(): CreditSettings {
  return { ..._creditSettings };
}

export function saveCreditSettings(partial: Partial<CreditSettings>): CreditSettings {
  _creditSettings = {
    ..._creditSettings,
    ...partial,
  };
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getCreditSettingsPath(), JSON.stringify(_creditSettings, null, 2), "utf-8");
  } catch {
    // Ignore write failure
  }
  return getCreditSettings();
}

// ── Loading ────────────────────────────────────────────────────────────

interface PricingFile {
  models: Record<string, ModelPricing>;
  vendors?: { prefix: string; name: string }[];
  updatedAt?: number;
  lastCheckedAt?: number;
}

function applyPricingData(data: PricingFile, isBundled = false) {
  if (data.vendors && data.vendors.length > 0) {
    VENDOR_MAP = data.vendors.map(v => [v.prefix, v.name]);
  }
  const normalizedModels: Record<string, ModelPricing> = {};
  for (const [rawKey, val] of Object.entries(data.models || {})) {
    const provider: ModelProvider =
      val.provider || (rawKey.startsWith("ollama/") ? "ollama" : "copilot");
    const cleanKey = stripProviderPrefix(rawKey);
    const key = provider === "ollama" ? `ollama/${cleanKey}` : cleanKey;
    normalizedModels[key] = {
      ...val,
      provider,
      source: val.source || (isBundled ? "bundled" : "remote"),
    };
  }
  if (isBundled) {
    BUNDLED_PRICING = { ...normalizedModels };
  }
  PRICING = { ...BUNDLED_PRICING, ...normalizedModels };
}

function loadBundled() {
  const jsonPath = path.join(_extensionPath, "media", "pricing.json");
  const raw = fs.readFileSync(jsonPath, "utf-8");
  applyPricingData(JSON.parse(raw), true);
  _updatedAt = Date.now();
  _lastCheckedAt = Date.now();
}

function loadCachedRemote() {
  try {
    const cachePath = getPricingCachePath();
    if (!fs.existsSync(cachePath)) { return; }
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (cached && cached.models && typeof cached.models === "object") {
      PRICING = { ...BUNDLED_PRICING, ...cached.models };
      if (cached.updatedAt) { _updatedAt = cached.updatedAt; }
      if (cached.lastCheckedAt) { _lastCheckedAt = cached.lastCheckedAt; }
    }
  } catch {
    // Ignore corrupt cache
  }
}

function saveCachedRemote() {
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getPricingCachePath(),
      JSON.stringify(
        {
          updatedAt: _updatedAt,
          lastCheckedAt: _lastCheckedAt,
          models: PRICING,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch {
    // Ignore write failure
  }
}

/**
 * Load pricing data. Call once at activation.
 * @param extensionPath  context.extensionUri.fsPath
 */
export function loadPricing(extensionPath: string): string {
  _extensionPath = extensionPath;
  loadBundled();
  loadCachedRemote();
  loadCreditSettings();

  if (!_autoUpdateTimer) {
    _autoUpdateTimer = setInterval(() => {
      refreshPricing().catch(() => {});
    }, AUTO_UPDATE_INTERVAL_MS);
    if (_autoUpdateTimer.unref) {
      _autoUpdateTimer.unref();
    }
  }
  return "bundled+remote";
}

// ── Live HTML Scraping (GitHub Copilot & Ollama Cloud) ─────────────────

function fetchHtml(url: string, redirectsLeft = 4): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CopilotCostTokenTracker/1.2)",
          "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
        timeout: 10000,
      },
      res => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          fetchHtml(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode || 0} from ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
    req.on("error", reject);
  });
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&mdash;|&ndash;|&#8212;|&#8211;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUsdPrice(cellText: string): number | undefined {
  const m = cellText.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (!m) {
    if (/\bfree\b/i.test(cellText)) { return 0; }
    return undefined;
  }
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a human-readable model label from a scraped HTML table into a canonical slug.
 * e.g. "Claude Sonnet 4.6" -> "claude-sonnet-4.6", "DeepSeek V4.1 Flash" -> "deepseek-v4.1-flash"
 */
function slugifyScrapedModelName(raw: string): string {
  let s = raw
    .trim()
    .replace(/\(.*?\)/g, " ")
    .replace(/`+/g, "")
    .trim()
    .toLowerCase();
  // Remove trailing ":cloud" if present
  s = s.replace(/:cloud$/i, "").replace(/-cloud$/i, "");
  s = s.replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s;
}

/**
 * Parse HTML tables from GitHub Copilot's Models and Pricing documentation page.
 */
export function parseGitHubCopilotPricingHtml(html: string): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) {
        cells.push(stripTags(cellMatch[1]));
      }
      if (cells.length >= 3) {
        rows.push(cells);
      }
    }
    if (rows.length < 2) { continue; }

    const header = rows[0].map(h => h.toLowerCase());
    const hasInput = header.some(h => h.includes("input"));
    const hasOutput = header.some(h => h.includes("output"));
    if (!hasInput || !hasOutput) { continue; }

    const modelCol = Math.max(0, header.findIndex(h => h.includes("model") || h.includes("name")));
    const inputCol = header.findIndex(h => h.includes("input") && !h.includes("cache"));
    const cachedCol = header.findIndex(h => h.includes("cached") || h.includes("cache read"));
    const cacheWriteCol = header.findIndex(h => h.includes("cache write") || h.includes("write"));
    const outputCol = header.findIndex(h => h.includes("output"));

    if (inputCol < 0 || outputCol < 0) { continue; }

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.length <= Math.max(modelCol, inputCol, outputCol)) { continue; }
      const rawModel = cells[modelCol];
      if (!rawModel) { continue; }

      const inputPrice = parseUsdPrice(cells[inputCol]);
      const outputPrice = parseUsdPrice(cells[outputCol]);
      if (inputPrice === undefined || outputPrice === undefined) { continue; }

      const cachedPrice = cachedCol >= 0 && cachedCol < cells.length
        ? (parseUsdPrice(cells[cachedCol]) ?? Math.round(inputPrice * 0.1 * 1000) / 1000)
        : Math.round(inputPrice * 0.1 * 1000) / 1000;
      const cacheWritePrice = cacheWriteCol >= 0 && cacheWriteCol < cells.length
        ? parseUsdPrice(cells[cacheWriteCol])
        : undefined;

      const slug = slugifyScrapedModelName(rawModel);
      if (!slug || slug.length < 2) { continue; }

      const entry: ModelPricing = {
        provider: "copilot",
        input: inputPrice,
        cached_input: cachedPrice,
        output: outputPrice,
        source: "remote",
      };
      if (cacheWritePrice !== undefined) {
        entry.cache_write = cacheWritePrice;
      }
      out[slug] = entry;
    }
  }
  return out;
}

/**
 * Parse HTML tables and model pricing blocks from https://ollama.com/pricing.
 */
export function parseOllamaPricingHtml(html: string): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};

  // Strategy 1: Standard HTML <table> rows with Model, Input, Cached (optional), Output
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) {
        cells.push(stripTags(cellMatch[1]));
      }
      if (cells.length >= 3) {
        rows.push(cells);
      }
    }
    if (rows.length < 2) { continue; }

    const header = rows[0].map(h => h.toLowerCase());
    const hasInput = header.some(h => h.includes("input"));
    const hasOutput = header.some(h => h.includes("output"));
    if (!hasInput || !hasOutput) { continue; }

    const modelCol = Math.max(0, header.findIndex(h => h.includes("model") || h.includes("name") || h === ""));
    const inputCol = header.findIndex(h => h.includes("input") && !h.includes("cache"));
    const cachedCol = header.findIndex(h => h.includes("cache"));
    const outputCol = header.findIndex(h => h.includes("output"));
    if (inputCol < 0 || outputCol < 0) { continue; }

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.length <= Math.max(modelCol, inputCol, outputCol)) { continue; }
      const rawModel = cells[modelCol];
      if (!rawModel) { continue; }

      const inputPrice = parseUsdPrice(cells[inputCol]);
      const outputPrice = parseUsdPrice(cells[outputCol]);
      if (inputPrice === undefined || outputPrice === undefined) { continue; }

      const cachedPrice = cachedCol >= 0 && cachedCol < cells.length
        ? (parseUsdPrice(cells[cachedCol]) ?? Math.round(inputPrice * 0.1 * 1000) / 1000)
        : Math.round(inputPrice * 0.1 * 1000) / 1000;

      // Check if cell contains a specific tag like `gemma4:31b` or `gpt-oss:120b`
      const codeTagMatch = rawModel.match(/\b([a-z0-9][a-z0-9._-]+(?::[a-z0-9._-]+)?)\b/i);
      const slug = slugifyScrapedModelName(codeTagMatch ? codeTagMatch[1] : rawModel);
      if (!slug || slug.length < 2) { continue; }

      out[`ollama/${slug}`] = {
        provider: "ollama",
        input: inputPrice,
        cached_input: cachedPrice,
        output: outputPrice,
        source: "remote",
      };
    }
  }

  // Strategy 2: Parse grid / card blocks on ollama.com/pricing where a model slug or link
  // is followed by Input / Cached / Output dollar amounts
  const blockRe = /(?:href="\/library\/([a-z0-9._:-]+)"|data-model="([a-z0-9._:-]+)")([\s\S]{1,1200}?)(?=(?:href="\/library\/|data-model=|<\/section|<\/main|$))/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(html)) !== null) {
    const rawSlug = (blockMatch[1] || blockMatch[2] || "").toLowerCase().replace(/:cloud$/i, "");
    const body = stripTags(blockMatch[3] || "");
    const prices = [...body.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
    if (rawSlug && prices.length >= 2) {
      const input = prices[0];
      const cached = prices.length >= 3 ? prices[1] : Math.round(input * 0.1 * 1000) / 1000;
      const output = prices.length >= 3 ? prices[2] : prices[1];
      const key = `ollama/${rawSlug}`;
      if (!out[key]) {
        out[key] = {
          provider: "ollama",
          input,
          cached_input: cached,
          output,
          source: "remote",
        };
      }
    }
  }

  return out;
}

/**
 * Scrape live pricing tables from both GitHub Copilot and Ollama Cloud web pages,
 * merge with bundled fallback models, and persist to local cache.
 */
export async function refreshPricing(): Promise<PricingStatusInfo> {
  _lastCheckedAt = Date.now();
  _copilotError = undefined;
  _ollamaError = undefined;

  const [copilotRes, ollamaRes] = await Promise.allSettled([
    fetchHtml(GITHUB_COPILOT_PRICING_URL).then(parseGitHubCopilotPricingHtml),
    fetchHtml(OLLAMA_PRICING_URL).then(parseOllamaPricingHtml),
  ]);

  let anyUpdated = false;

  if (copilotRes.status === "fulfilled") {
    const scraped = copilotRes.value;
    const count = Object.keys(scraped).length;
    if (count > 0) {
      _copilotScrapedCount = count;
      PRICING = { ...PRICING, ...scraped };
      anyUpdated = true;
    }
  } else {
    _copilotError = copilotRes.reason?.message || String(copilotRes.reason);
  }

  if (ollamaRes.status === "fulfilled") {
    const scraped = ollamaRes.value;
    const count = Object.keys(scraped).length;
    if (count > 0) {
      _ollamaScrapedCount = count;
      PRICING = { ...PRICING, ...scraped };
      anyUpdated = true;
    }
  } else {
    _ollamaError = ollamaRes.reason?.message || String(ollamaRes.reason);
  }

  // Always mark timestamp as updated when user triggers refresh (using remote + bundled catalog)
  _updatedAt = Date.now();
  if (anyUpdated) {
    saveCachedRemote();
  }

  return getPricingStatus();
}

export function getPricingStatus(): PricingStatusInfo {
  const entries = Object.entries(PRICING);
  const ollamaModels = entries.filter(([k, v]) => (v.provider || (k.startsWith("ollama/") ? "ollama" : "copilot")) === "ollama").length;
  const copilotModels = entries.length - ollamaModels;
  return {
    source: "Remote pricing data",
    totalModels: entries.length,
    copilotModels,
    ollamaModels,
    updatedAt: _updatedAt,
    lastCheckedAt: _lastCheckedAt,
    copilotScrapedCount: _copilotScrapedCount,
    ollamaScrapedCount: _ollamaScrapedCount,
    copilotError: _copilotError,
    ollamaError: _ollamaError,
  };
}

// ── Provider & Model Resolution ────────────────────────────────────────

export function stripProviderPrefix(modelKey: string): string {
  return modelKey
    .replace(/^customendpoint\/ollama\s*cloud\//i, "")
    .replace(/^customendpoint\/[^/]+\//i, "")
    .replace(/^ollama-models\//i, "")
    .replace(/^ollama\/ollama\//i, "")
    .replace(/^(?:ollama|copilot)\//i, "");
}

export function cleanOllamaCloudTag(modelName: string): string {
  return modelName
    .replace(/:cloud$/i, "")
    .replace(/-cloud$/i, "");
}

function normalise(name: string): string {
  return name.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

/**
 * Determine whether a logged model call belongs to Ollama Cloud or GitHub Copilot.
 */
export function detectProvider(
  rawModel: string,
  attrs?: Record<string, any>,
  sessionProviderHint?: ModelProvider,
): ModelProvider {
  const trimmed = (rawModel || "").trim();
  const lower = trimmed.toLowerCase();

  // 1. Explicit prefix in model string
  if (
    lower.startsWith("ollama/") ||
    lower.startsWith("ollama-models/") ||
    lower.startsWith("customendpoint/ollama") ||
    lower.includes("ollama cloud/")
  ) {
    return "ollama";
  }
  if (lower.startsWith("copilot/")) {
    return "copilot";
  }

  // 2. Explicit Ollama Cloud suffix (:cloud or -cloud)
  if (/:cloud$/i.test(trimmed) || /-cloud$/i.test(trimmed)) {
    return "ollama";
  }

  // 3. Explicit Copilot-exclusive model families (never served by Ollama Cloud)
  const strippedLower = stripProviderPrefix(trimmed).toLowerCase();
  if (
    strippedLower.startsWith("claude-") ||
    (strippedLower.startsWith("gpt-") && !strippedLower.startsWith("gpt-oss")) ||
    strippedLower.startsWith("gemini-") ||
    strippedLower.startsWith("grok-") ||
    strippedLower.startsWith("copilot-") ||
    strippedLower.startsWith("mai-") ||
    strippedLower.startsWith("o1") ||
    strippedLower.startsWith("o3") ||
    strippedLower.startsWith("o4") ||
    strippedLower.startsWith("goldeneye") ||
    strippedLower.startsWith("raptor-")
  ) {
    return "copilot";
  }

  // 4. Inspect llm_request / usage_record attrs for endpoint / provider hints
  if (attrs) {
    if (attrs.isByok === false) {
      return "copilot";
    }
    const providerFields = [
      attrs.provider,
      attrs.modelProvider,
      attrs.vendor,
      attrs.endpoint,
      attrs.url,
      attrs.baseUrl,
      attrs.apiType,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (providerFields.includes("ollama") || providerFields.includes("11434")) {
      return "ollama";
    }
    if (providerFields.includes("copilot") || providerFields.includes("github")) {
      return "copilot";
    }
  }

  // 5. Catalog membership check: if model exists ONLY in one provider's catalog, use that provider
  const cleanNorm = normalise(cleanOllamaCloudTag(stripProviderPrefix(trimmed)));
  const inOllama = Boolean(PRICING[`ollama/${cleanNorm}`]) ||
    Object.keys(PRICING).some(k => k.startsWith("ollama/") && (k.slice(7).includes(cleanNorm) || cleanNorm.includes(k.slice(7))));
  const inCopilot = Boolean(PRICING[cleanNorm]) || Boolean(PRICING[`copilot/${cleanNorm}`]) ||
    Object.keys(PRICING).some(k => !k.startsWith("ollama/") && (stripProviderPrefix(k).includes(cleanNorm) || cleanNorm.includes(stripProviderPrefix(k))));

  if (inOllama && !inCopilot) {
    return "ollama";
  }
  if (inCopilot && !inOllama) {
    return "copilot";
  }

  // 6. Ambiguous model (exists in both catalogs, e.g. kimi-k2.7-code, kimi-3/kimi-k3) or unknown:
  // use session-level provider hint or BYOK flag
  if (attrs?.isByok === true) {
    return "ollama";
  }
  if (sessionProviderHint) {
    return sessionProviderHint;
  }

  return "copilot";
}

export function providerForKey(modelKey: string): ModelProvider {
  const p = PRICING[modelKey];
  if (p?.provider) { return p.provider; }
  if (modelKey.startsWith("ollama/") || /:cloud$/i.test(modelKey) || /-cloud$/i.test(modelKey)) {
    return "ollama";
  }
  return "copilot";
}

export function vendorFor(modelKey: string): string {
  const existing = PRICING[modelKey];
  if (existing?.vendor) { return existing.vendor; }
  const clean = cleanOllamaCloudTag(stripProviderPrefix(modelKey)).toLowerCase();
  for (const [prefix, vendor] of VENDOR_MAP) {
    if (clean.startsWith(prefix)) { return vendor; }
  }
  if (modelKey.startsWith("ollama/")) {
    return "Ollama Cloud";
  }
  return "Other";
}

/**
 * Full resolution of a raw model string (with optional provider hint) into its
 * canonical key, pricing, and exact-vs-proxy status.
 */
export function resolveModelMatch(
  rawModel: string,
  providerHint?: ModelProvider,
  attrs?: Record<string, any>,
): ResolvedModelMatch {
  const provider = detectProvider(rawModel, attrs, providerHint);
  const stripped = stripProviderPrefix(rawModel.trim());
  const withoutCloudTag = cleanOllamaCloudTag(stripped);
  const norm = normalise(withoutCloudTag);
  const normWithTag = normalise(stripped);

  // Candidate keys in the target provider's catalog
  const providerEntries = Object.entries(PRICING).filter(([k, v]) => {
    const p = v.provider || (k.startsWith("ollama/") ? "ollama" : "copilot");
    return p === provider;
  });

  // 1. Check exact match in target provider
  const exactTargets =
    provider === "ollama"
      ? [`ollama/${norm}`, `ollama/${normWithTag}`]
      : [norm, `copilot/${norm}`];

  for (const target of exactTargets) {
    if (PRICING[target]) {
      // If the raw log string had a customendpoint prefix or :cloud suffix, is it considered an "exact" match in the Models tab?
      // Exact match if the stripped model (or base model) is in the catalog.
      const isExactRaw =
        normalise(rawModel) === target ||
        normalise(rawModel) === stripProviderPrefix(target) ||
        (provider === "ollama" && (norm === stripProviderPrefix(target) || normWithTag === stripProviderPrefix(target)));
      return {
        rawModel,
        provider,
        canonicalKey: target,
        displayModel: stripProviderPrefix(target),
        vendor: vendorFor(target),
        pricing: PRICING[target],
        isExact: isExactRaw && !/^customendpoint\//i.test(rawModel),
        proxyUsed: stripProviderPrefix(target),
      };
    }
  }

  // 2. Substring / version alias match within the SAME provider
  // Also normalize version dots/hyphens (e.g. claude-sonnet-4-6 -> claude-sonnet-4.6)
  const normDots = norm.replace(/(\d)-(\d)/g, "$1.$2");
  const matches = providerEntries.filter(([key]) => {
    const cleanKey = stripProviderPrefix(key);
    return (
      cleanKey.includes(norm) ||
      norm.includes(cleanKey) ||
      cleanKey.includes(normDots) ||
      normDots.includes(cleanKey)
    );
  });
  matches.sort((a, b) => stripProviderPrefix(b[0]).length - stripProviderPrefix(a[0]).length);

  if (matches.length > 0) {
    const [matchedKey, matchedPricing] = matches[0];
    return {
      rawModel,
      provider,
      canonicalKey: matchedKey,
      displayModel: stripProviderPrefix(matchedKey),
      vendor: vendorFor(matchedKey),
      pricing: matchedPricing,
      isExact: false,
      proxyUsed: stripProviderPrefix(matchedKey),
    };
  }

  // 3. No match found
  const fallbackKey = provider === "ollama" ? `ollama/${normWithTag}` : normWithTag;
  return {
    rawModel,
    provider,
    canonicalKey: fallbackKey,
    displayModel: stripped,
    vendor: vendorFor(fallbackKey),
    pricing: undefined,
    isExact: false,
    proxyUsed: null,
  };
}

export function findPricing(model: string, providerHint?: ModelProvider): ModelPricing | undefined {
  if (PRICING[model]) { return PRICING[model]; }
  return resolveModelMatch(model, providerHint).pricing;
}

export function canonicalModel(model: string, providerHint?: ModelProvider): string {
  if (PRICING[model]) { return model; }
  return resolveModelMatch(model, providerHint).canonicalKey;
}
