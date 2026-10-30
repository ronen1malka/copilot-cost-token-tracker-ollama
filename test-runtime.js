const path = require('path');
const {
  loadPricing, findPricing, canonicalModel, vendorFor,
  detectProvider, resolveModelMatch, getCreditSettings,
  parseOllamaPricingHtml, parseGitHubCopilotPricingHtml,
} = require('./out/pricing');
const { parseSession, analyzeSession, analyzeAggregate, getModelsOverview } = require('./out/sessionParser');
const { findAllSessions } = require('./out/sessionDiscovery');

async function run() {
  // ── Test 1: Pricing loads ────────────────────────────────────────────
  const source = await loadPricing(__dirname);
  console.log('✓ Pricing source:', source);

  // ── Test 2: Known model lookup (Copilot + Ollama Cloud) ──────────────
  const models = [
    'claude-sonnet-4.6',
    'gpt-4.1',
    'gpt-4o-mini-2024-07-18',
    'gemini-2.5-pro',
    'gpt-5',
    'glm-5.3-flash:cloud',
    'minimax-m3.1-flash:cloud',
    'deepseek-v4.1-flash:cloud',
    'gemma4:31b-cloud',
    'mistral-large-4:cloud',
    'customendpoint/Ollama Cloud/glm-5.3-flash:cloud',
    'kimi-k2.7-code',
  ];
  for (const m of models) {
    const p = findPricing(m);
    const r = resolveModelMatch(m);
    console.log(p
      ? `  ✓ Pricing found: ${m} -> [${r.provider}] ${r.canonicalKey} ($${p.input}/$${p.output})`
      : `  ✗ MISSING: ${m}`);
  }

  // ── Test 3: Provider disambiguation for dual-provider models ─────────
  const kimiCopilot = resolveModelMatch('kimi-k3', 'copilot');
  const kimiOllama  = resolveModelMatch('kimi-k3', 'ollama');
  const kimiCloud   = resolveModelMatch('kimi-3:cloud');
  console.log('  ✓ Dual-provider Kimi:',
    `copilot=${kimiCopilot.provider}(${kimiCopilot.canonicalKey})`,
    `ollama=${kimiOllama.provider}(${kimiOllama.canonicalKey})`,
    `cloudTag=${kimiCloud.provider}(${kimiCloud.canonicalKey})`
  );

  // ── Test 4: Alias matching (log emits versioned names) ───────────────
  const aliases = [
    'claude-sonnet-4-6-20250501',
    'claude-sonnet-4.6-20250501',
    'gpt-4o',
  ];
  for (const a of aliases) {
    const canon = canonicalModel(a);
    const p = findPricing(a);
    console.log(p ? '  ✓ Alias ok: ' + a + ' -> ' + canon : '  ✗ Alias fail: ' + a);
  }

  // ── Test 5: Vendor detection ─────────────────────────────────────────
  const vendorTests = [
    ['claude-sonnet-4.6', 'Anthropic (Claude)'],
    ['gpt-5', 'OpenAI (GPT)'],
    ['gemini-2.5-pro', 'Google (Gemini)'],
    ['ollama/glm-5.3-flash', 'Zhipu AI (GLM)'],
    ['unknown-model', 'Other'],
  ];
  for (const [model, expected] of vendorTests) {
    const v = vendorFor(model);
    console.log(v === expected ? '  ✓ Vendor: ' + model + ' = ' + v : '  ✗ Vendor mismatch: ' + model + ' got ' + v + ' expected ' + expected);
  }

  // ── Test 6: Credit settings default ($60 Ollama Pro plan) ────────────
  const credits = getCreditSettings();
  console.log('✓ Default credit settings:', JSON.stringify(credits));

  // ── Test 7: HTML scraper unit tests ──────────────────────────────────
  const sampleOllamaHtml = `
    <table>
      <tr><th>Model</th><th>Input</th><th>Cached Input</th><th>Output</th></tr>
      <tr><td>glm-5.3-flash</td><td>$0.15</td><td>$0.03</td><td>$0.50</td></tr>
      <tr><td>kimi-k3</td><td>$3.00</td><td>$0.30</td><td>$15.00</td></tr>
    </table>
  `;
  const scrapedOllama = parseOllamaPricingHtml(sampleOllamaHtml);
  console.log('✓ Scraped Ollama HTML models:', Object.keys(scrapedOllama).length);

  const sampleGhHtml = `
    <table>
      <tr><th>Model</th><th>Input</th><th>Cached</th><th>Cache Write</th><th>Output</th></tr>
      <tr><td>claude-sonnet-4.6</td><td>$3.00</td><td>$0.30</td><td>$3.75</td><td>$15.00</td></tr>
    </table>
  `;
  const scrapedGh = parseGitHubCopilotPricingHtml(sampleGhHtml);
  console.log('✓ Scraped GitHub HTML models:', Object.keys(scrapedGh).length);

  // ── Test 8: Session discovery & Models Overview ──────────────────────
  const sessions = findAllSessions(720);
  console.log('✓ Sessions found (30 days):', sessions.length);
  const overview = getModelsOverview(720, sessions);
  console.log(
    `✓ Models Overview: total=${overview.status.totalModels} ` +
    `(copilot=${overview.status.copilotModels}, ollama=${overview.status.ollamaModels}), ` +
    `unmatchedObserved=${overview.unmatchedObserved.length}`
  );

  if (sessions.length > 0) {
    const s = sessions[0];
    console.log('  Latest:', s.date, '|', s.workspace_name, '|', s.session_title.slice(0, 40));
    const analysis = analyzeSession(s);
    console.log(
      `  ✓ Cost: $${analysis.totals.cost.toFixed(6)} ` +
      `(Copilot: $${analysis.totals.copilot_cost.toFixed(6)}, Ollama: $${analysis.totals.ollama_cost.toFixed(6)}) ` +
      `Calls: ${analysis.totals.calls}`
    );
  }

  // ── Test 9: Aggregate ────────────────────────────────────────────────
  const agg = analyzeAggregate(720, sessions);
  if (agg) {
    console.log(
      `✓ Aggregate: sessions=${agg.sessions_count} cost=$${agg.totals.cost.toFixed(4)} ` +
      `(Copilot=$${agg.totals.copilot_cost.toFixed(4)}, Ollama=$${agg.totals.ollama_cost.toFixed(4)})`
    );
  }
}

run().catch(e => {
  console.error('✗ Test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
