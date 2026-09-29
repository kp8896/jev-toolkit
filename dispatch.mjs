#!/usr/bin/env node
/**
 * Jev dispatcher (the "Jevopus" router): job text in → worker, effort and risk
 * flags from ONE batched Jev call → code decides the route → handoff file.
 *
 *   node dispatch.mjs "Add fixtures for Nassau handrail detect"
 *   pbpaste | node dispatch.mjs            # job text on stdin
 *   node dispatch.mjs --active "..."       # also write queue/<route>/<id>.json
 *   node dispatch.mjs --workers opus-deep,sonnet-routine,kevan-review "..."
 *   node dispatch.mjs --json "..."         # machine-readable output
 *
 * Shadow mode is the default: it prints the decision and logs it, and writes nothing.
 * Without TYPESAFE_API_KEY (or with JEV_ENABLED=0) every job routes to kevan-review.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemOne, pYes, picked, confidenceOf } from './client.mjs';
import { THRESHOLDS, WORKERS, EFFORT_LEVELS, RISK_NOULS, dispatchQuestions } from './questions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const QUEUE_DIR = path.join(HERE, 'queue');
const HUMAN_ROUTES = new Set(['jon', 'kevan-review']);

/**
 * Exact policy checks run in code before Jev (AGENTS.md "Ask first" / "Never").
 * A hit forces the job to a human regardless of what Jev says.
 */
const CODE_RISK_RULES = [
  { flag: 'mentions_deploy', re: /\b(?:re)?deploy/i },
  { flag: 'mentions_rules_or_indexes', re: /firestore\.rules|storage\.rules|firestore\.indexes|\bfirestore\s+(?:rules|indexes)\b/i },
  { flag: 'mentions_new_dependency', re: /\bnpm\s+(?:i|install|add)\s+\S|\byarn\s+add\b|\bpnpm\s+add\b/i },
  { flag: 'mentions_merge_main', re: /\bmerge\b[^.\n]*\b(?:to|into)\s+main\b/i },
  { flag: 'mentions_secret', re: /\b(?:api[_ ]?key|secrets?|service\s*account)\b|\.env\b/i },
];

export function codeRiskFlags(jobText) {
  return CODE_RISK_RULES.filter((r) => r.re.test(jobText)).map((r) => r.flag);
}

export function availableWorkers(list) {
  const ids = (list?.length ? list : Object.keys(WORKERS)).filter((id) => WORKERS[id]);
  // Always keep a human escape hatch in the menu.
  if (!ids.includes('kevan-review')) ids.push('kevan-review');
  return ids;
}

/**
 * Pure routing decision from Jev answers (or null when Jev is unavailable).
 * @returns {{ route: string, reason: string, effort: string, risks: string[] }}
 */
export function decideRoute(answers, codeFlags = [], t = THRESHOLDS) {
  const risks = [...codeFlags];
  if (!answers) {
    return {
      route: codeFlags.length ? 'jon' : 'kevan-review',
      reason: codeFlags.length ? `code rule: ${codeFlags.join(', ')}` : 'jev unavailable',
      effort: 'medium',
      risks,
    };
  }

  for (const key of Object.keys(RISK_NOULS)) {
    const p = pYes(answers, key);
    if (p !== null && p >= t.risk) risks.push(`${key} (${p.toFixed(2)})`);
  }

  const effortScore = answers.effort?.score;
  const effort =
    typeof effortScore === 'number'
      ? EFFORT_LEVELS[Math.max(0, Math.min(EFFORT_LEVELS.length - 1, Math.round(effortScore)))]
      : 'medium';

  const worker = picked(answers, 'worker');
  const conf = confidenceOf(answers, 'worker');

  if (risks.length) {
    // Deploys, rules, indexes and deps are Jon's; other risks come back to Kevan.
    const jonRisk = risks.some((r) =>
      /deploy|rules|indexes|dependency|merge_main|secret/.test(r),
    );
    return { route: jonRisk ? 'jon' : 'kevan-review', reason: `risk: ${risks.join(', ')}`, effort, risks };
  }

  const ctx = pYes(answers, 'enough_context');
  if (ctx !== null && ctx < t.enoughContext) {
    return { route: 'kevan-review', reason: `needs clarification (enough_context ${ctx.toFixed(2)})`, effort, risks };
  }

  if (worker && WORKERS[worker] && conf >= t.workerConfidence) {
    return { route: worker, reason: `worker ${worker} @ ${conf.toFixed(2)}`, effort, risks };
  }

  return {
    route: 'kevan-review',
    reason: worker ? `low confidence: ${worker} @ ${conf.toFixed(2)}` : 'no worker chosen',
    effort,
    risks,
  };
}

export function buildHandoff(jobText, decision, jev) {
  const w = WORKERS[decision.route];
  const effort = HUMAN_ROUTES.has(decision.route) ? w.handoff.effort : decision.effort;
  const prompt = HUMAN_ROUTES.has(decision.route)
    ? `For ${w.handoff.tool}: ${decision.reason}\n\n${jobText}`
    : [
        `${w.handoff.tool} — model: ${w.handoff.model}, effort: ${effort}`,
        '',
        jobText,
        '',
        'Follow AGENTS.md: branch off current main, run the tests the change owns, fill the four PR sections. No merge, no deploy.',
      ].join('\n');
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'queued',
    job: jobText,
    route: decision.route,
    reason: decision.reason,
    risks: decision.risks,
    handoff: { ...w.handoff, effort },
    prompt,
    jev: jev ? { model: jev.model, latencyMs: jev.latencyMs, costUsd: jev.costUsd, answers: jev.answers } : null,
  };
}

export async function dispatch(jobText, { workers, env, fetchImpl, logPath } = {}) {
  const ids = availableWorkers(workers);
  const flags = codeRiskFlags(jobText);
  const jev = await systemOne({
    tag: 'dispatch',
    state: { job: jobText },
    questions: dispatchQuestions(ids),
    ...(env ? { env } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
  });
  const decision = decideRoute(jev?.answers ?? null, flags);
  return buildHandoff(jobText, decision, jev);
}

export function writeHandoff(handoff, queueDir = QUEUE_DIR) {
  const dir = path.join(queueDir, handoff.route);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${handoff.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(handoff, null, 2)}\n`);
  return file;
}

function parseArgs(argv) {
  const out = { active: false, json: false, workers: null, text: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--active') out.active = true;
    else if (a === '--json') out.json = true;
    else if (a === '--workers') out.workers = String(argv[++i] || '').split(',').filter(Boolean);
    else out.text.push(a);
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobText = (args.text.join(' ') || (await readStdin())).trim();
  if (!jobText) {
    console.error('Usage: node dispatch.mjs [--active] [--json] [--workers a,b] "job text"');
    process.exit(2);
  }
  const handoff = await dispatch(jobText, { workers: args.workers });
  const file = args.active ? writeHandoff(handoff) : null;

  if (args.json) {
    console.log(JSON.stringify({ ...handoff, file }, null, 2));
    return;
  }
  console.log(`route:  ${handoff.route}`);
  console.log(`reason: ${handoff.reason}`);
  console.log(`tool:   ${handoff.handoff.tool} (model ${handoff.handoff.model}, effort ${handoff.handoff.effort})`);
  if (handoff.jev) {
    console.log(`jev:    ${handoff.jev.model} ${handoff.jev.latencyMs}ms $${handoff.jev.costUsd.toFixed(6)}`);
  }
  console.log(file ? `queued: ${file}` : 'shadow: nothing written (use --active to queue)');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
