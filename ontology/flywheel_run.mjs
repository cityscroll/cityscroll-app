// Multi-dimension MAPE orchestrator (pure core).
// Monitor inventories → analyze per dimension → plan ranked cards →
// reconcile against ledger (idempotent) → optional lesson extraction.
// Execute (agent dispatch) is out of scope; this module emits a queue document.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DIMENSION_IDS,
  DIMENSION_EVALUATORS,
  MULTI_FLYWHEEL_POLICY_VERSION,
} from "./dimensions/index.mjs";
import {
  reconcileQueue,
  buildQueueDocument,
  updateLedger,
  emptyLedger,
  QUEUE_SCHEMA,
} from "./card_queue.mjs";
import { extractRecurringLessons, mergeLessonsIntoMarkdown, defaultLessonsHeader } from "./engineering_lessons.mjs";
import { checkOntologyRegistrySync } from "./sync.mjs";
import { validateCrossSpineFixtures } from "./cross_spine.mjs";

export { QUEUE_SCHEMA, MULTI_FLYWHEEL_POLICY_VERSION };

/**
 * Load default fixture inventories from a repo root.
 */
export function loadDefaultInputs(root, { mode = "fixture" } = {}) {
  const readJson = (rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  };

  const features = readJson("ontology/fixtures/dimensions/data_integrity_features.json");
  const views = readJson("ontology/fixtures/dimensions/readability_views.json");
  const disagreements = readJson("ontology/fixtures/dimensions/cross_source_disagreements.json");
  const source_coverage = readJson("entity_resolution/source_coverage.json");
  const gap_taxonomy = readJson("site/data/gap_taxonomy.json");
  const source_contracts = readJson("site/data/source_contracts.json");
  const registry_sync = checkOntologyRegistrySync();

  const crossDir = join(root, "ontology/fixtures/cross_spine");
  let cross_spine_bundles = [];
  let cross_spine = { checked: 0, contradictions: 0 };
  if (existsSync(crossDir)) {
    const names = readdirSync(crossDir).filter((n) => n.endsWith(".json")).sort();
    const passBundles = [];
    for (const name of names) {
      const bundle = JSON.parse(readFileSync(join(crossDir, name), "utf8"));
      if (name.startsWith("fail_")) {
        // Fail fixtures are intentional characterization; feed them to the
        // consistency dimension so it can emit reconciliation cards.
        cross_spine_bundles.push(bundle);
      } else {
        passBundles.push(bundle);
      }
    }
    const report = validateCrossSpineFixtures(passBundles);
    cross_spine = { checked: report.checked, contradictions: report.contradictions };
  }

  return {
    mode,
    features: features?.features || features || [],
    views: views?.views || views || [],
    disagreements: disagreements?.disagreements || disagreements || [],
    source_coverage,
    gap_taxonomy,
    source_contracts,
    registry_sync,
    cross_spine,
    cross_spine_bundles,
    actionability: { sample_size: 1, actionable: 1, rate: 1 },
  };
}

/**
 * Run all (or selected) dimensions and return a reconciled queue.
 *
 * @param {object} opts
 * @param {object} opts.inputs — dimension inputs (see loadDefaultInputs)
 * @param {object} [opts.ledger]
 * @param {string[]} [opts.dimensions]
 * @param {string} [opts.generated_at]
 * @param {object} [opts.verify_results]
 * @param {boolean} [opts.refresh_open]
 * @param {number} [opts.limit]
 */
export function runMultiFlywheel(opts = {}) {
  const inputs = opts.inputs || {};
  const mode = inputs.mode || opts.mode || "fixture";
  const generatedAt = opts.generated_at || "1970-01-01T00:00:00.000Z";
  const dimensionIds = Array.isArray(opts.dimensions) && opts.dimensions.length
    ? opts.dimensions
    : [...DIMENSION_IDS];

  const dimension_metrics = {};
  const rawCards = [];

  for (const id of dimensionIds) {
    const evaluate = DIMENSION_EVALUATORS[id];
    if (!evaluate) {
      dimension_metrics[id] = { error: "no_evaluator" };
      continue;
    }
    const result = evaluate(inputs);
    dimension_metrics[id] = result.metrics || {};
    for (const card of result.cards || []) {
      rawCards.push(card);
    }
  }

  const ledger = opts.ledger && opts.ledger.cards ? opts.ledger : emptyLedger({ updated_at: generatedAt });
  const reconciled = reconcileQueue(rawCards, ledger, {
    verify_results: opts.verify_results,
    refresh_open: opts.refresh_open,
    limit: opts.limit ?? 50,
  });

  const queue = buildQueueDocument({
    cards: reconciled.cards,
    dimension_metrics,
    skipped: reconciled.skipped,
    regressions: reconciled.regressions,
    generated_at: generatedAt,
    mode,
    ledger_path: opts.ledger_path || null,
  });

  const nextLedger = updateLedger(ledger, reconciled.cards, { seen_at: generatedAt });
  const lessons = extractRecurringLessons(reconciled.cards);

  return {
    queue,
    ledger: nextLedger,
    lessons,
    raw_card_count: rawCards.length,
    dimensions_run: dimensionIds,
  };
}

/**
 * Build lessons file text merge for the run (pure).
 */
export function planLessonFileUpdate(existingText, lessons, { date } = {}) {
  return mergeLessonsIntoMarkdown(
    existingText || defaultLessonsHeader(),
    lessons,
    { date },
  );
}
