#!/usr/bin/env node
/**
 * Benchmark: Jev vs labeled sheet-goods items (e.g. the fixtures Jolted's isSheetGood
 * in functions/src/erp-read/sheetGoodsFilter.ts is tested against).
 *
 *   node bench-sheetgoods.mjs --file path/to/items.json
 *
 * Items need { name, sku?, category?, subCategory?, tags?, materialClassification?, expect? }.
 * Exact rules stay in code (materialClassification === 'indirect' → excluded);
 * Jev answers narrow questions per item, combined in code. One request per item,
 * all items in parallel. Prints agreement with `expect`, latency and cost.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { systemOne, pYes, picked, jevConfigured } from './client.mjs';
import { THRESHOLDS, sheetGoodsQuestions } from './questions.mjs';


export function combineSheetGood(item, answers, t = THRESHOLDS) {
  if (item.materialClassification === 'indirect') return false;
  if (!answers) return null;
  const sheet = pYes(answers, 'is_sheet_stock') ?? 0;
  const hardware = pYes(answers, 'is_hardware_or_consumable') ?? 0;
  const placeholder = pYes(answers, 'is_placeholder') ?? 0;
  return sheet >= t.sheetStock && hardware < t.notSheetStock && placeholder < t.notSheetStock;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
  const i = process.argv.indexOf('--file');
  const file = i >= 0 ? process.argv[i + 1] : null;
  if (!file) {
    console.error('Usage: node bench-sheetgoods.mjs --file <items.json>  (e.g. Jolted functions/src/erp-read/fixtures/sheet-goods-samples.json)');
    process.exit(2);
  }
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!jevConfigured()) {
    console.error('TYPESAFE_API_KEY is not set (or JEV_ENABLED=0). Nothing to benchmark.');
    process.exit(2);
  }

  const questions = sheetGoodsQuestions();
  const started = Date.now();
  const rows = await Promise.all(
    items.map(async (item) => {
      const state = {
        name: item.name,
        sku: item.sku,
        category: item.category,
        subcategory: item.subCategory,
        tags: item.tags ?? [],
      };
      const jev = await systemOne({ tag: 'bench:sheetgoods', state, questions, timeoutMs: 5000 });
      return { item, jev, got: combineSheetGood(item, jev?.answers ?? null) };
    }),
  );
  const wall = Date.now() - started;

  let labeled = 0;
  let agree = 0;
  let cost = 0;
  const lat = [];
  console.log('id | expect | jev | material | sheet / hw / placeholder');
  for (const { item, jev, got } of rows) {
    if (jev) {
      cost += jev.costUsd;
      lat.push(jev.latencyMs);
    }
    const a = jev?.answers;
    const probs = a
      ? [pYes(a, 'is_sheet_stock'), pYes(a, 'is_hardware_or_consumable'), pYes(a, 'is_placeholder')]
          .map((p) => (p ?? 0).toFixed(2))
          .join(' / ')
      : 'no answer';
    if (typeof item.expect === 'boolean' && got !== null) {
      labeled++;
      if (got === item.expect) agree++;
    }
    const mark = typeof item.expect === 'boolean' && got !== null && got !== item.expect ? '  <-- differs' : '';
    console.log(`${item.id ?? item.sku} | ${item.expect ?? '-'} | ${got ?? 'n/a'} | ${picked(a, 'material') ?? '-'} | ${probs}${mark}`);
  }
  lat.sort((x, y) => x - y);
  console.log('');
  console.log(`agreement: ${agree}/${labeled} labeled items`);
  console.log(`latency per call: p50 ${pct(lat, 0.5)}ms, p95 ${pct(lat, 0.95)}ms; wall ${wall}ms for ${items.length} items`);
  console.log(`cost: $${cost.toFixed(6)} total, $${(cost / Math.max(1, lat.length)).toFixed(8)} per item`);
  if (items.length < 50) {
    console.log(`note: ${items.length} items is a smoke test, not a benchmark — pass --file with a redacted live inventory dump.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
