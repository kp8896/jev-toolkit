#!/usr/bin/env node
/**
 * Stop hook — shadow-only "is it actually done?" check.
 * Runs only when JEV_HOOKS=shadow|active and TYPESAFE_API_KEY is set. It reads the
 * session transcript, asks Jev whether the evidence supports "done", and LOGS the
 * verdict to hook-log.jsonl (or $JEV_HOOK_LOG). It never blocks a stop; forcing continuation
 * waits until the log shows the check is reliable on Jolted work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemOne } from '../client.mjs';
import { verifyQuestions } from '../questions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = process.env.JEV_HOOK_LOG || path.join(HERE, '..', 'hook-log.jsonl');
const TEST_HINT = /vitest|selftest|npm (?:run )?test|passed|failed|FAIL|PASS/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : c?.text ?? (typeof c?.content === 'string' ? c.content : textOf(c?.content))))
    .filter(Boolean)
    .join('\n');
}

export function summarizeTranscript(jsonl) {
  let goal = '';
  let lastAssistant = '';
  const testOutputs = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row?.message;
    if (!msg) continue;
    const content = msg.content;
    if (msg.role === 'user') {
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b?.type === 'tool_result');
      if (results.length) {
        for (const r of results) {
          const t = textOf(r.content);
          if (TEST_HINT.test(t)) testOutputs.push(t.split('\n').slice(-30).join('\n'));
        }
      } else if (!goal) {
        goal = textOf(content).slice(0, 4000);
      }
    } else if (msg.role === 'assistant') {
      const t = textOf(Array.isArray(content) ? content.filter((b) => b?.type === 'text') : content);
      if (t) lastAssistant = t;
    }
  }
  return { goal, lastAssistant: lastAssistant.slice(-3000), testSummary: testOutputs.slice(-2).join('\n---\n') };
}

async function main() {
  const mode = process.env.JEV_HOOKS;
  if (mode !== 'shadow' && mode !== 'active') return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { transcript_path: transcriptPath } = JSON.parse(input || '{}');
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const s = summarizeTranscript(fs.readFileSync(transcriptPath, 'utf8'));
  if (!s.goal) return;
  await systemOne({
    tag: 'done:shadow',
    state: { goal: s.goal, pr_summary: s.lastAssistant, test_summary: s.testSummary, changed_files: [] },
    questions: verifyQuestions(),
    timeoutMs: 3000,
    retries: 0,
    logPath: LOG,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(() => {});
}
