/**
 * Minimal TypeSafe Jev client (System One: typed decisions, no text generation).
 *
 * Native fetch only — no npm dependency. Returns null on any failure so every
 * caller keeps a deterministic fallback. Nothing runs without TYPESAFE_API_KEY.
 *
 *   JEV_ENABLED=0     kill switch (always returns null)
 *   JEV_MODEL         override the pinned model (thresholds are tuned per version)
 *   TYPESAFE_BASE_URL override the API host
 *
 * API: POST /v1/systemone { model, state, questions } →
 *   { model, answers: { [name]: { noul } | { choice, confidence, probabilities } |
 *     { score, confidence, legend, probabilities } }, usage: { input_tokens } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const JEV_MODEL_DEFAULT = 'jev-1.13.0';
/** USD per 1M input tokens; output is not billed. */
export const JEV_PRICE_PER_M_INPUT = 0.042;
export const DEFAULT_LOG_PATH = path.join(HERE, 'log.jsonl');

/** Question builders — the question key is never sent as meaning, so put it all in `instructions`. */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const score = (instructions, levels) => ({ type: 'score', instructions, criteria: levels });
export const noul = (instructions, criteria) =>
  criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };

export function jevConfigured(env = process.env) {
  return env.JEV_ENABLED !== '0' && Boolean(env.TYPESAFE_API_KEY);
}

export function costUsd(inputTokens) {
  return ((Number(inputTokens) || 0) * JEV_PRICE_PER_M_INPUT) / 1e6;
}

function appendLog(logPath, row) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  } catch {
    /* logging must never break a decision */
  }
}

/**
 * One batched Jev call. Put every question about the same state in one request
 * (TypeSafe cookbook: 12.2x cheaper, 10x faster than one call per question).
 *
 * @returns {Promise<null | { answers, model, inputTokens, latencyMs, costUsd }>}
 */
export async function systemOne({
  state,
  questions,
  tag = 'unnamed',
  timeoutMs = 2500,
  retries = 1,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logPath = DEFAULT_LOG_PATH,
}) {
  if (!jevConfigured(env)) return null;

  const model = env.JEV_MODEL || JEV_MODEL_DEFAULT;
  const base = (env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
  const body = JSON.stringify({ model, state, questions });
  const started = Date.now();
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `http ${res.status}`;
        continue;
      }
      if (!res.ok) {
        lastError = `http ${res.status}`;
        break;
      }
      const json = await res.json();
      const inputTokens = json?.usage?.input_tokens ?? 0;
      const out = {
        answers: json?.answers ?? {},
        model: json?.model ?? model,
        inputTokens,
        latencyMs: Date.now() - started,
        costUsd: costUsd(inputTokens),
      };
      // Log decisions + cost, never the state (it can hold customer data).
      appendLog(logPath, {
        at: new Date().toISOString(),
        tag,
        model: out.model,
        inputTokens,
        latencyMs: out.latencyMs,
        costUsd: out.costUsd,
        answers: out.answers,
      });
      return out;
    } catch (err) {
      lastError = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err);
    } finally {
      clearTimeout(timer);
    }
  }

  appendLog(logPath, { at: new Date().toISOString(), tag, model, error: lastError });
  return null;
}

/** Probability helpers that tolerate a missing answer (treated as "no signal"). */
export const pYes = (answers, key) => {
  const v = answers?.[key]?.noul;
  return typeof v === 'number' ? v : null;
};
export const picked = (answers, key) => answers?.[key]?.choice ?? null;
export const confidenceOf = (answers, key) => {
  const v = answers?.[key]?.confidence;
  return typeof v === 'number' ? v : 0;
};
