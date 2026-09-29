#!/usr/bin/env node
/**
 * PreToolUse hook (Bash). Two layers:
 *  1. Exact AGENTS.md rules in code (guardRules.mjs): deny or ask. Always on.
 *  2. Optional Jev risk check, only when JEV_HOOKS=shadow|active and TYPESAFE_API_KEY is set.
 *     shadow: log what Jev would say. active: may escalate to "ask". Never auto-allows —
 *     a confident label is not a permission.
 * No output = the normal Claude Code permission flow continues unchanged.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCommand } from '../guardRules.mjs';
import { systemOne, pYes } from '../client.mjs';
import { THRESHOLDS, guardQuestions } from '../questions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = process.env.JEV_HOOK_LOG || path.join(HERE, '..', 'hook-log.jsonl');

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (input?.tool_name !== 'Bash') return;
  const command = String(input?.tool_input?.command || '');

  const rule = checkCommand(command);
  if (rule) {
    emit(rule.decision, rule.reason);
    return;
  }

  const mode = process.env.JEV_HOOKS;
  if (mode !== 'shadow' && mode !== 'active') return;

  const jev = await systemOne({
    tag: `guard:${mode}`,
    state: { command, cwd: input?.cwd || '' },
    questions: guardQuestions(),
    timeoutMs: 2000,
    retries: 0,
    logPath: LOG,
  });
  if (!jev || mode !== 'active') return;

  const flagged = Object.keys(guardQuestions()).filter(
    (k) => (pYes(jev.answers, k) ?? 0) >= THRESHOLDS.guardEscalate,
  );
  if (flagged.length) emit('ask', `Jev flagged: ${flagged.join(', ')}`);
}

main().catch(() => {
  /* A broken hook must not block work; the exact rules above already ran. */
});
