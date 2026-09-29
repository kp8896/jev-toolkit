#!/usr/bin/env node
/**
 * Live eval of the dispatcher against labeled Jolted jobs (examples/jobs.json).
 * Run after any change to questions.mjs or THRESHOLDS, and before moving
 * dispatch from shadow to --active. Needs TYPESAFE_API_KEY.
 *
 *   node eval.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevConfigured } from './client.mjs';
import { dispatch } from './dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!jevConfigured()) {
    console.error('TYPESAFE_API_KEY is not set (or JEV_ENABLED=0).');
    process.exit(2);
  }
  const examples = JSON.parse(fs.readFileSync(path.join(HERE, 'examples', 'jobs.json'), 'utf8'));
  const results = await Promise.all(examples.map(async (ex) => ({ ex, h: await dispatch(ex.job) })));

  let ok = 0;
  let cost = 0;
  const lat = [];
  for (const { ex, h } of results) {
    const hit = ex.expect.includes(h.route);
    if (hit) ok++;
    if (h.jev) {
      cost += h.jev.costUsd;
      lat.push(h.jev.latencyMs);
    }
    console.log(`${hit ? 'ok  ' : 'MISS'} ${h.route.padEnd(17)} want ${ex.expect.join('|').padEnd(32)} ${h.reason}`);
    if (!hit) console.log(`       ${ex.job}`);
  }
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0;
  console.log('');
  console.log(`routed correctly: ${ok}/${examples.length}`);
  console.log(`latency: p50 ${p(0.5)}ms p95 ${p(0.95)}ms · cost $${cost.toFixed(6)} total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
