/**
 * Every Jev question and threshold for this toolkit and its hooks lives here.
 * Edit questions and thresholds together; re-run `node eval.mjs`
 * after any change (thresholds are tuned per pinned model version).
 *
 * Rules that must be exact (deploy commands, counts, dates) live in code
 * (guardRules.mjs, verify.mjs), not in these questions.
 */
import { choice, noul, score } from './client.mjs';

export const THRESHOLDS = {
  /** Route a job straight to a worker only when the worker Choice is this sure. */
  workerConfidence: 0.85,
  /** Any single risk Noul at or above this sends the job to a human. */
  risk: 0.3,
  /** Below this, the job needs clarification before anyone works on it. */
  enoughContext: 0.5,
  /** verify: goal_met expected score (0..2) needed for "ready". */
  goalMet: 1.6,
  verifyConfidence: 0.6,
  scopeCreep: 0.5,
  /** guard hook (active mode): escalate to "ask" at or above this. Never auto-allow. */
  guardEscalate: 0.5,
  /** Sheet-goods benchmark combine rule. */
  sheetStock: 0.5,
  notSheetStock: 0.5,
};

/**
 * Worker catalog for the dispatcher. Options are rebuilt per call from the
 * workers that are available (`--workers`), never a stale org chart.
 * `handoff` is what the queue file tells the person or agent picking it up.
 */
export const WORKERS = {
  'opus-deep': {
    criterion:
      'Substantial engineering in the Jolted codebase: estimator, parametric pricing logic, panel systems, work orders, cross-file refactors, unknown or risky code, or anything needing design judgment.',
    handoff: { tool: 'Claude Code', model: 'opus', effort: 'high' },
  },
  'sonnet-routine': {
    criterion:
      'A bounded, well-specified code change in a few files: a bug with a clear repro, a small feature, adding tests or fixtures, wiring an existing pattern.',
    handoff: { tool: 'Claude Code', model: 'sonnet', effort: 'medium' },
  },
  'haiku-mechanical': {
    criterion:
      'Mechanical edits with no judgment: rename, copy or label text change, config value, typo, formatting, moving a file.',
    handoff: { tool: 'Claude Code', model: 'haiku', effort: 'low' },
  },
  'codex-ui': {
    criterion:
      'Visual web design work: marketing site pages, landing page layout, styling, animation or imagery for the website.',
    handoff: { tool: 'Codex', model: 'default', effort: 'medium' },
  },
  'jolted-parametric': {
    criterion:
      'The job is to get a price, quantity or estimate number for a specific job or panel configuration, which the Jolted parametric API computes; no code change is being asked for.',
    handoff: { tool: 'Jolted parametricApi / estimator', model: 'none', effort: 'n/a' },
  },
  jon: {
    criterion:
      'Needs Jon: production deploys, merging to main, Firestore rules or indexes, storage rules, secrets, or new npm dependencies.',
    handoff: { tool: 'Jon (human)', model: 'none', effort: 'n/a' },
  },
  'kevan-review': {
    criterion:
      'The request is unclear, is a business decision rather than a task, or does not fit any other option.',
    handoff: { tool: 'Kevan (human)', model: 'none', effort: 'n/a' },
  },
};

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

/** Narrow risk questions (one judgment each), combined in code. */
export const RISK_NOULS = {
  touches_deploy: 'The job asks for deploying to production or Firebase, or releasing to live users.',
  touches_firestore_rules_or_indexes:
    'The job requires changing Firestore security rules, Firestore indexes, or storage.rules.',
  adds_dependency: 'The job requires installing or adding a new npm package or third-party library.',
  bulk_delete:
    'The job deletes or overwrites many existing records, documents or files in bulk (for example a cleanup or wipe of stored data).',
  external_send:
    'The job sends something to people outside the team: emailing customers or vendors, posting publicly, or contacting a third party.',
};

export function dispatchQuestions(workerIds) {
  const criteria = {};
  for (const id of workerIds) criteria[id] = WORKERS[id].criterion;
  const q = {
    worker: choice(
      'Which worker should take this job for a small cabinet and elevator-interior fabrication company that builds its own ERP (Jolted)?',
      criteria,
    ),
    effort: score('How much reasoning effort does the job need from the worker?', [
      'Trivial: the change is fully specified and mechanical.',
      'Routine: clear goal, a few decisions, low risk.',
      'Involved: several files or unclear edge cases to work through.',
      'Hard: design decisions, unknown code, or pricing and estimate correctness at stake.',
    ]),
    enough_context: noul(
      'The job text states what outcome is wanted clearly enough that a worker could start without asking a question.',
    ),
  };
  for (const [key, text] of Object.entries(RISK_NOULS)) q[key] = noul(text);
  return q;
}

export function verifyQuestions() {
  return {
    goal_met: score(
      'Compare `goal` with `changed_files`, `pr_summary` and `test_summary`. How completely does the delivered work accomplish the goal?',
      [
        'Not met: the goal is not addressed or the evidence contradicts it.',
        'Partly met: some requirements are addressed, others are missing or unproven.',
        'Met: every requirement in the goal is addressed and supported by the evidence.',
      ],
    ),
    evidence_covers_requirements: noul(
      'The test output and changed files provide direct evidence for each requirement stated in `goal`, not just a claim in `pr_summary`.',
    ),
    scope_creep: noul(
      '`changed_files` include changes unrelated to `goal`, such as refactors, renames or reformatting of code the goal did not ask to touch.',
    ),
    touches_never_list: noul(
      'The work merges to main, deploys to production, commits secrets or .env files, or changes Firestore rules or indexes.',
    ),
  };
}

export function guardQuestions() {
  return {
    deletes_or_overwrites_data: noul(
      'Running `command` deletes or irreversibly overwrites files, database records, or git history.',
    ),
    external_side_effect: noul(
      'Running `command` changes something outside this machine: pushes, deploys, publishes, sends a message, or writes to a production database or cloud service.',
    ),
    touches_secrets: noul(
      'Running `command` reads, prints, copies or commits credentials, API keys, service account files, or .env files.',
    ),
  };
}

/** Sheet goods split into narrow judgments (RazeDen: split vague questions). */
export function sheetGoodsQuestions() {
  return {
    is_sheet_stock: noul(
      'The inventory item is flat sheet or panel stock bought as full sheets and cut or nested on a machine: laminate sheets, sheet metal, plywood or MDF panels, cladding or resin panels.',
    ),
    is_hardware_or_consumable: noul(
      'The inventory item is hardware, a fastener, a bracket or extrusion, a tool, or a shop consumable rather than raw sheet material.',
    ),
    is_placeholder: noul(
      'The inventory record is a placeholder, test or dummy entry rather than a real purchasable item.',
    ),
    material: choice('What kind of material is this inventory item?', {
      laminate: 'Plastic laminate or HPL sheet (e.g. Wilsonart, Formica).',
      sheet_metal: 'Steel, stainless or aluminum sheet or plate, any gauge.',
      wood_panel: 'Plywood, MDF, particleboard or other wood panel.',
      other_sheet: 'Another nestable sheet or panel material (resin, acrylic, composite cladding).',
      hardware: 'Fasteners, brackets, extrusions, hinges or other hardware.',
      consumable: 'Shop supplies such as rags, tape, glue or abrasives.',
      other: 'None of the above or not enough information.',
    }),
  };
}
