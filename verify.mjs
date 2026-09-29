#!/usr/bin/env node
/**
 * "Check every result against the goal" before a PR goes to Jon.
 * Code checks the exact things first (tests ran and passed, PR sections present),
 * then one batched Jev call judges goal coverage and scope.
 *
 *   node verify.mjs --goal "Add fixtures for Nassau handrail detect" \
 *     --tests test-output.txt [--pr-body pr.md] [--base origin/main]
 *
 * Verdict: ready | fix | human. Exit code 0 only for "ready".
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { systemOne, pYes, confidenceOf } from './client.mjs';
import { THRESHOLDS, verifyQuestions } from './questions.mjs';

export const PR_SECTIONS = ['## Summary', '## For Jon', '## Test plan', '## Stack'];

const FAIL_RE = /\b[1-9]\d*\s+(?:failed|failing)\b|\bFAIL\b|AssertionError|npm ERR!|✗|Tests?:\s+\d+ failed/;
const PASS_RE = /\b\d+\s+passed\b|\bpassed\b|\bPASS\b|✓|\ball\b.*\bok\b|selftest ok/i;

/** Exact checks. Returns a list of problems (empty = passed). */
export function codeChecks({ testOutput, prBody }) {
  const problems = [];
  if (!testOutput || !testOutput.trim()) {
    problems.push('no test output supplied — run the tests the PR lists and pass --tests');
  } else if (FAIL_RE.test(testOutput)) {
    problems.push('test output shows failures');
  } else if (!PASS_RE.test(testOutput)) {
    problems.push('test output has no pass marker');
  }
  if (prBody !== undefined) {
    for (const h of PR_SECTIONS) {
      if (!prBody.includes(h)) problems.push(`PR body missing "${h}"`);
    }
  }
  return problems;
}

/** Pure verdict from code problems + Jev answers (null = Jev unavailable). */
export function verdictFrom(problems, answers, t = THRESHOLDS) {
  if (problems.length) return { verdict: 'fix', reasons: problems };
  if (!answers) return { verdict: 'human', reasons: ['jev unavailable — review by hand'] };

  const reasons = [];
  const never = pYes(answers, 'touches_never_list');
  if (never !== null && never >= t.risk) {
    return { verdict: 'human', reasons: [`touches AGENTS.md never-list (${never.toFixed(2)})`] };
  }
  const goal = answers.goal_met?.score;
  const goalConf = confidenceOf(answers, 'goal_met');
  if (typeof goal !== 'number' || goalConf < t.verifyConfidence) {
    return { verdict: 'human', reasons: [`goal_met uncertain (confidence ${goalConf.toFixed(2)})`] };
  }
  if (goal < t.goalMet) reasons.push(`goal not fully met (score ${goal.toFixed(2)} of 2)`);
  const evidence = pYes(answers, 'evidence_covers_requirements');
  if (evidence !== null && evidence < 0.5) reasons.push(`evidence does not cover requirements (${evidence.toFixed(2)})`);
  const creep = pYes(answers, 'scope_creep');
  if (creep !== null && creep >= t.scopeCreep) reasons.push(`possible scope creep (${creep.toFixed(2)})`);

  return reasons.length ? { verdict: 'fix', reasons } : { verdict: 'ready', reasons: ['goal met with evidence'] };
}

function lastLines(text, n) {
  return String(text || '').split('\n').slice(-n).join('\n');
}

export function changedFiles(base = 'origin/main') {
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function verify({ goal, testOutput, prBody, files, env, fetchImpl, logPath }) {
  const problems = codeChecks({ testOutput, prBody });
  let jev = null;
  if (!problems.length) {
    jev = await systemOne({
      tag: 'verify',
      state: {
        goal,
        changed_files: files.slice(0, 80),
        pr_summary: prBody ? prBody.split('## For Jon')[0].slice(0, 3000) : '',
        test_summary: lastLines(testOutput, 40),
      },
      questions: verifyQuestions(),
      ...(env ? { env } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
    });
  }
  return { ...verdictFrom(problems, jev?.answers ?? null), jev };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const goal = arg(argv, '--goal') || (arg(argv, '--goal-file') && fs.readFileSync(arg(argv, '--goal-file'), 'utf8'));
  if (!goal) {
    console.error('Usage: node verify.mjs --goal "..." --tests out.txt [--pr-body pr.md] [--base origin/main]');
    process.exit(2);
  }
  const testsPath = arg(argv, '--tests');
  const prPath = arg(argv, '--pr-body');
  const result = await verify({
    goal,
    testOutput: testsPath ? fs.readFileSync(testsPath, 'utf8') : '',
    prBody: prPath ? fs.readFileSync(prPath, 'utf8') : undefined,
    files: changedFiles(arg(argv, '--base') || 'origin/main'),
  });
  console.log(`verdict: ${result.verdict}`);
  for (const r of result.reasons) console.log(`  - ${r}`);
  if (result.jev) console.log(`jev: ${result.jev.model} ${result.jev.latencyMs}ms $${result.jev.costUsd.toFixed(6)}`);
  process.exit(result.verdict === 'ready' ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
