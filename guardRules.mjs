/**
 * Exact AGENTS.md "Never" / "Ask first" rules for shell commands.
 * Code, not a model: these must be right every time. Used by hooks/guard.mjs.
 *
 * Returns { decision: 'deny' | 'ask', reason } for the first matching rule, or null.
 * Nothing here ever returns 'allow' — no match means "leave the normal permission flow alone".
 */

/**
 * Split on shell separators so one rule sees one command at a time.
 * Heredoc bodies are dropped first: they are data (file contents, scripts), and
 * matching them blocks legitimate edits that merely mention a deploy command.
 */
export function commandSegments(command) {
  return String(command || '')
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '')
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when `cmd` is the program actually being run (not text inside echo/grep). */
function runs(segment, cmd) {
  return new RegExp(`^(?:\\w+=\\S*\\s+)*(?:sudo\\s+)?(?:npx\\s+(?:-y\\s+)?)?${cmd}\\b`).test(segment);
}

function onlyTargets(segment) {
  const m = segment.match(/--only(?:=|\s+)(["']?)([^\s"']+)\1/);
  return m ? m[2].split(',').map((t) => t.trim()).filter(Boolean) : null;
}

function firebaseDeployRule(segment) {
  if (!runs(segment, 'firebase\\s+deploy')) return null;
  const targets = onlyTargets(segment);
  if (!targets) {
    return { decision: 'deny', reason: 'AGENTS.md: never `firebase deploy` without `--only`.' };
  }
  if (targets.includes('functions')) {
    return {
      decision: 'deny',
      reason: 'AGENTS.md: never `--only functions` without a function name (use functions:<name>).',
    };
  }
  if (targets.some((t) => t === 'firestore' || t === 'firestore:indexes')) {
    return {
      decision: 'ask',
      reason: 'AGENTS.md: `--only firestore` / `firestore:indexes` only when Jon explicitly wants it.',
    };
  }
  return { decision: 'ask', reason: 'Deploys are Jon\'s, after merge to main. Confirm this is Jon\'s deploy.' };
}

function gitPushMainRule(segment) {
  if (!runs(segment, 'git\\s+push')) return null;
  const args = segment.replace(/^.*?\bgit\s+push\b/, '').trim().split(/\s+/);
  const pushesMain = args.some((a) => /^(?:\+?(?:HEAD|[\w./-]+):)?(?:refs\/heads\/)?(?:main|master)$/.test(a));
  if (pushesMain) {
    return { decision: 'deny', reason: 'AGENTS.md: never push to main — feature branch + PR; Jon squash-merges.' };
  }
  return null;
}

function mergeRule(segment) {
  if (runs(segment, 'gh\\s+pr\\s+merge')) {
    return { decision: 'deny', reason: 'AGENTS.md: agents never merge to main; Jon squash-merges.' };
  }
  return null;
}

function secretsRule(segment) {
  if (runs(segment, 'git\\s+add') && /(^|\s)(?:\S*\/)?\.env(?:\.[\w.-]+)?(\s|$)/.test(segment) && !/\.env\.example\b/.test(segment)) {
    return { decision: 'deny', reason: 'AGENTS.md: never commit secrets or .env files.' };
  }
  if (runs(segment, 'git\\s+add') && /serviceAccountKey[\w.-]*\.json/.test(segment)) {
    return { decision: 'deny', reason: 'Never commit service account keys.' };
  }
  return null;
}

const RULES = [firebaseDeployRule, gitPushMainRule, mergeRule, secretsRule];

export function checkCommand(command) {
  let ask = null;
  for (const seg of commandSegments(command)) {
    for (const rule of RULES) {
      const hit = rule(seg);
      if (hit?.decision === 'deny') return hit;
      if (hit && !ask) ask = hit;
    }
  }
  return ask;
}
