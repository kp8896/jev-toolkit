# jev-toolkit

Kevan's personal decision layer built on [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's "System One" model. You send Jev a situation and typed questions. It answers every question in one parallel pass in about 70–500 ms, for $0.042 per 1M input tokens (output is free).

Question types:

- **Choice** picks one option and returns probabilities.
- **Score** places the input on an ordered rubric.
- **Noul** returns P(yes).

Jev never writes text or code. The split used throughout this toolkit:

- An **LLM** (Claude or Codex) does the writing and the code.
- **Jev** routes, scores, gates and checks "done".
- **Code** handles anything exact: deploy rules, counts, dates and thresholds.

This is separate from Jolted on purpose: nothing here ships in the product.

## Setup

```bash
git clone https://github.com/kp8896/jev-toolkit ~/jev-toolkit
cd ~/jev-toolkit && npm install
export TYPESAFE_API_KEY=...   # in your shell profile, never in a file in this repo
```

Nothing calls Jev without `TYPESAFE_API_KEY`. `JEV_ENABLED=0` is the kill switch, and `JEV_MODEL` pins the model (default `jev-1.13.0`). When Jev is unavailable, every tool falls back to a human route.

## Tools

| Command | What it does |
|---|---|
| `node dispatch.mjs "job text"` | **Jevopus router.** Picks the worker (`opus-deep`, `sonnet-routine`, `haiku-mechanical`, `codex-ui`, `jolted-parametric`, `jon`, `kevan-review`), the effort level and the risk flags in one call. Code then decides the route. Shadow mode by default; `--active` writes `queue/<route>/<id>.json` with a paste-ready prompt. Job text can also be piped in on stdin. |
| `node verify.mjs --goal "..." --tests out.txt --pr-body pr.md` | **"Is it done?"** Code first checks that tests ran and passed and that the four Jolted PR sections are present. Then Jev judges goal coverage, scope creep and never-list hits. Prints `ready`, `fix` or `human`. |
| `npm run eval` | Runs the router on `examples/jobs.json` (25 labeled jobs) and prints routing accuracy, latency and cost. |
| `node bench-sheetgoods.mjs --file items.json` | Compares Jev with labeled sheet-goods items. Jolted's fixtures are at `functions/src/erp-read/fixtures/sheet-goods-samples.json`. |
| `npm test` | Offline tests: no key, fetch is stubbed. |

Every question and threshold lives in `questions.mjs`. Decisions are logged to `log.jsonl` (gitignored): model, tokens, latency, cost and answers. State is never logged.

## Optional Claude Code hooks

To use the hooks, copy the entries from `hooks/settings.example.json` into your **user** settings (`~/.claude/settings.json`), not a shared project's settings.

- **`hooks/guard.mjs` (PreToolUse, Bash)** enforces the Jolted AGENTS.md never-list:
  - It denies bare `firebase deploy`, `--only functions` with no function name, pushes to `main`, `gh pr merge`, and `git add` of `.env` or service-account files.
  - It asks before other deploys.
  - It only matches the command actually being run. Text inside `echo` or `grep`, and heredoc bodies, is ignored.
  - With `JEV_HOOKS=shadow`, it also logs Jev's risk read. With `JEV_HOOKS=active`, that risk read can escalate a command to "ask".
  - It never auto-allows anything.
- **`hooks/done.mjs` (Stop)** runs only with `JEV_HOOKS` set. It logs a Jev done-verdict for the session and never blocks.

## Rollout

1. Run `npm run eval`. Correct `examples/jobs.json` wherever it routes wrong.
2. Use `dispatch.mjs` in shadow mode on real ClickUp tasks and Outlook requests for a week.
3. Only then switch to `--active` and `JEV_HOOKS=active`.
4. Re-run the eval after any change to `questions.mjs` or a model upgrade.
