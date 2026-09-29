// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemOne, jevConfigured, costUsd, JEV_MODEL_DEFAULT } from '../client.mjs';
import { dispatch, decideRoute, codeRiskFlags, availableWorkers, writeHandoff } from '../dispatch.mjs';
import { codeChecks, verdictFrom, PR_SECTIONS } from '../verify.mjs';
import { checkCommand } from '../guardRules.mjs';
import { combineSheetGood } from '../bench-sheetgoods.mjs';
import { summarizeTranscript } from '../hooks/done.mjs';

const KEY_ENV = { TYPESAFE_API_KEY: 'test-key' };
const GUARD = path.resolve(__dirname, '../hooks/guard.mjs');

function stubFetch(responses, calls = []) {
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    };
  };
  return { fn, calls };
}

const ok = (answers, input_tokens = 400) => ({
  status: 200,
  json: { model: 'jev-1.13.0', answers, usage: { input_tokens } },
});

describe('jev client', () => {
  it('is a no-op without a key or with the kill switch', async () => {
    expect(jevConfigured({})).toBe(false);
    expect(jevConfigured({ ...KEY_ENV, JEV_ENABLED: '0' })).toBe(false);
    const { fn, calls } = stubFetch([ok({})]);
    expect(await systemOne({ state: 'x', questions: {}, env: {}, fetchImpl: fn, logPath: null })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('sends one batched request to /v1/systemone with the pinned model and bearer key', async () => {
    const { fn, calls } = stubFetch([ok({ a: { noul: 0.9 } }, 1_000_000)]);
    const out = await systemOne({
      state: { job: 'x' },
      questions: { a: { type: 'noul', instructions: 'q' }, b: { type: 'noul', instructions: 'r' } },
      env: KEY_ENV,
      fetchImpl: fn,
      logPath: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    expect(calls[0].body.model).toBe(JEV_MODEL_DEFAULT);
    expect(Object.keys(calls[0].body.questions)).toEqual(['a', 'b']);
    expect(out.answers.a.noul).toBe(0.9);
    expect(out.costUsd).toBeCloseTo(0.042, 6);
  });

  it('retries once on 429 then returns null on persistent failure', async () => {
    const retry = stubFetch([{ status: 429, json: {} }, ok({ a: { noul: 0.1 } })]);
    expect((await systemOne({ state: 's', questions: {}, env: KEY_ENV, fetchImpl: retry.fn, logPath: null })).answers.a.noul).toBe(0.1);
    const fail = stubFetch([{ status: 503, json: {} }]);
    expect(await systemOne({ state: 's', questions: {}, env: KEY_ENV, fetchImpl: fail.fn, logPath: null })).toBeNull();
    expect(fail.calls).toHaveLength(2);
    const bad = stubFetch([{ status: 422, json: {} }]);
    expect(await systemOne({ state: 's', questions: {}, env: KEY_ENV, fetchImpl: bad.fn, logPath: null })).toBeNull();
    expect(bad.calls).toHaveLength(1);
  });

  it('prices input tokens only', () => {
    expect(costUsd(392)).toBeCloseTo(0.000016464, 9);
  });
});

describe('dispatch routing', () => {
  const answers = (over = {}) => ({
    worker: { choice: 'sonnet-routine', confidence: 0.92 },
    effort: { score: 1.2, confidence: 0.8 },
    enough_context: { noul: 0.9 },
    touches_deploy: { noul: 0.02 },
    touches_firestore_rules_or_indexes: { noul: 0.01 },
    adds_dependency: { noul: 0.03 },
    bulk_delete: { noul: 0.01 },
    external_send: { noul: 0.02 },
    ...over,
  });

  it('routes a confident, safe job to the chosen worker with its effort', () => {
    expect(decideRoute(answers())).toMatchObject({ route: 'sonnet-routine', effort: 'medium' });
  });

  it('sends low confidence and unclear jobs to kevan-review', () => {
    expect(decideRoute(answers({ worker: { choice: 'opus-deep', confidence: 0.6 } })).route).toBe('kevan-review');
    expect(decideRoute(answers({ enough_context: { noul: 0.2 } })).route).toBe('kevan-review');
  });

  it('sends deploy / rules / dependency risk to jon and external sends to kevan', () => {
    expect(decideRoute(answers({ touches_deploy: { noul: 0.7 } })).route).toBe('jon');
    expect(decideRoute(answers({ adds_dependency: { noul: 0.4 } })).route).toBe('jon');
    expect(decideRoute(answers({ external_send: { noul: 0.8 } })).route).toBe('kevan-review');
  });

  it('code rules override Jev and cover the no-key fallback', () => {
    expect(codeRiskFlags('please firebase deploy --only hosting')).toContain('mentions_deploy');
    expect(codeRiskFlags('Deploy parametricApi to production')).toContain('mentions_deploy');
    expect(codeRiskFlags('edit firestore.rules for vendors')).toContain('mentions_rules_or_indexes');
    expect(codeRiskFlags('npm install lodash')).toContain('mentions_new_dependency');
    expect(codeRiskFlags('commit the .env file')).toContain('mentions_secret');
    expect(codeRiskFlags('Rename the Preview button')).toEqual([]);
    expect(decideRoute(answers(), ['mentions_deploy']).route).toBe('jon');
    expect(decideRoute(null, []).route).toBe('kevan-review');
    expect(decideRoute(null, ['mentions_deploy']).route).toBe('jon');
  });

  it('always keeps a human option in the worker menu', () => {
    expect(availableWorkers(['opus-deep', 'nope'])).toEqual(['opus-deep', 'kevan-review']);
  });

  it('batches worker, effort, context and risk questions into one call and writes a handoff', async () => {
    const { fn, calls } = stubFetch([ok(answers({ worker: { choice: 'haiku-mechanical', confidence: 0.95 }, effort: { score: 0 } }))]);
    const h = await dispatch('Rename the Preview Estimate button', { env: KEY_ENV, fetchImpl: fn, logPath: null });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].body.questions)).toEqual(
      expect.arrayContaining(['worker', 'effort', 'enough_context', 'touches_deploy', 'external_send']),
    );
    expect(h).toMatchObject({ route: 'haiku-mechanical', handoff: { model: 'haiku', effort: 'low' } });
    expect(h.prompt).toContain('No merge, no deploy');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-q-'));
    const file = writeHandoff(h, dir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).route).toBe('haiku-mechanical');
    expect(path.basename(path.dirname(file))).toBe('haiku-mechanical');
  });
});

describe('verify', () => {
  const body = PR_SECTIONS.map((h) => `${h}\n- x`).join('\n\n');
  const good = {
    goal_met: { score: 1.9, confidence: 0.85 },
    evidence_covers_requirements: { noul: 0.8 },
    scope_creep: { noul: 0.1 },
    touches_never_list: { noul: 0.02 },
  };

  it('code checks catch missing, failing and unmarked test output and missing PR sections', () => {
    expect(codeChecks({ testOutput: '', prBody: body })[0]).toMatch(/no test output/);
    expect(codeChecks({ testOutput: 'Tests  12 passed | 1 failed', prBody: body })).toContain('test output shows failures');
    expect(codeChecks({ testOutput: 'done.', prBody: body })).toContain('test output has no pass marker');
    expect(codeChecks({ testOutput: 'Tests  12 passed', prBody: '## Summary' })).toContain('PR body missing "## Test plan"');
    expect(codeChecks({ testOutput: 'Test Files  3 passed (3)', prBody: body })).toEqual([]);
  });

  it('verdicts: ready, fix, human', () => {
    expect(verdictFrom([], good).verdict).toBe('ready');
    expect(verdictFrom(['test output shows failures'], good).verdict).toBe('fix');
    expect(verdictFrom([], null).verdict).toBe('human');
    expect(verdictFrom([], { ...good, goal_met: { score: 1.0, confidence: 0.8 } }).verdict).toBe('fix');
    expect(verdictFrom([], { ...good, scope_creep: { noul: 0.7 } }).verdict).toBe('fix');
    expect(verdictFrom([], { ...good, goal_met: { score: 2, confidence: 0.3 } }).verdict).toBe('human');
    expect(verdictFrom([], { ...good, touches_never_list: { noul: 0.6 } }).verdict).toBe('human');
  });
});

describe('guard rules (AGENTS.md never / ask)', () => {
  it.each([
    ['firebase deploy', 'deny'],
    ['firebase deploy --project jolted-io', 'deny'],
    ['firebase deploy --only functions --project jolted-io', 'deny'],
    ['firebase deploy --only hosting,functions', 'deny'],
    ['firebase deploy --only firestore', 'ask'],
    ['firebase deploy --only firestore:indexes', 'ask'],
    ['firebase deploy --only functions:parametricApi --project jolted-io', 'ask'],
    ['npm run build:all && firebase deploy --only hosting', 'ask'],
    ['git push origin main', 'deny'],
    ['git push origin HEAD:main', 'deny'],
    ['git push -f origin master', 'deny'],
    ['gh pr merge 155 --squash', 'deny'],
    ['git add .env', 'deny'],
    ['git add functions/.env.local', 'deny'],
    ['cd functions && npx firebase deploy', 'deny'],
    ['FOO=1 git push origin main', 'deny'],
    ["cat > x.txt <<'EOF'\nhello\nEOF\ngit push origin main", 'deny'],
  ])('%s → %s', (cmd, decision) => {
    expect(checkCommand(cmd)?.decision).toBe(decision);
  });

  it.each([
    'git push -u origin claude/funny-planck-ef9nmn',
    'git push origin kevan/maintenance-fix',
    'git add .env.example',
    'npm run test:run',
    'git checkout main && git pull origin main',
    'echo "firebase deploy --only functions" > notes.txt',
    'grep -rn "git push origin main" docs',
    "python3 - <<'EOF'\nprint('firebase deploy')\nEOF",
  ])('leaves %s to the normal flow', (cmd) => {
    expect(checkCommand(cmd)).toBeNull();
  });

  const runGuard = (payload) =>
    spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: '', JEV_HOOKS: '' },
    });

  it('hook emits a PreToolUse deny for a bare deploy', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: 'firebase deploy' } });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });

  it('hook is silent for safe commands and non-Bash tools', () => {
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'npm run test:run' } }).stdout).toBe('');
    expect(runGuard({ tool_name: 'Read', tool_input: { file_path: 'x' } }).stdout).toBe('');
  });
});

describe('sheet goods benchmark combine', () => {
  it('keeps the indirect rule in code and combines narrow answers', () => {
    expect(combineSheetGood({ materialClassification: 'indirect' }, null)).toBe(false);
    expect(combineSheetGood({}, null)).toBeNull();
    const a = (s, h, p) => ({ is_sheet_stock: { noul: s }, is_hardware_or_consumable: { noul: h }, is_placeholder: { noul: p } });
    expect(combineSheetGood({}, a(0.9, 0.1, 0.05))).toBe(true);
    expect(combineSheetGood({}, a(0.9, 0.7, 0.05))).toBe(false);
    expect(combineSheetGood({}, a(0.9, 0.1, 0.8))).toBe(false);
  });
});

describe('done hook transcript summary', () => {
  it('pulls the goal, last assistant text and test output', () => {
    const lines = [
      { message: { role: 'user', content: 'Add fixtures for Nassau handrail detect' } },
      { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', content: 'Test Files  1 passed (1)' }] } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Added 4 fixtures; selftest passes.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const s = summarizeTranscript(lines);
    expect(s.goal).toBe('Add fixtures for Nassau handrail detect');
    expect(s.lastAssistant).toBe('Added 4 fixtures; selftest passes.');
    expect(s.testSummary).toContain('1 passed');
  });
});
