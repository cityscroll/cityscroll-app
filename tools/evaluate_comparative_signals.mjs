#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAwardRankComparativeReadModel } from "../site/comparative_award_rank.mjs";
import {
  admitComparativeFact,
  buildPublishedStorySignalReadModel,
  projectPublishedStorySignal,
} from "../site/comparative_signal_admission.mjs";
import { detectAmendments } from "../worker/src/lib/checkbook_lifecycle.mjs";
import { readSharedProcurementReadModel } from "./lib/procurement_read_model_io.mjs";

const AWARDS = new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url);
const SOURCE_CONTRACTS = new URL("../site/data/source_contracts.json", import.meta.url);
const AWARD_RECEIPTS = new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url);
const STORY_SIGNALS = new URL("../site/data/comparative_story_signals.json", import.meta.url);
const PROCUREMENT = new URL("../site/data/shared_procurement_read_model.json", import.meta.url);
const NEGATIVE_CONTROL = new URL(
  "../test/fixtures/comparative_signal_admission/successor_absence.json",
  import.meta.url,
);
const FROZEN_CASES = new URL(
  "../test/fixtures/comparative_signal_evaluation/frozen-cases.json",
  import.meta.url,
);
const OUTPUT = new URL("../docs/evidence/comparative-signal-evaluation.json", import.meta.url);
const REPORT = new URL("../docs/evidence/comparative-signal-evaluation.md", import.meta.url);

export const COMPARATIVE_SIGNAL_EVALUATION_SCHEMA = "cityscroll.comparative_signal_evaluation.v1";
export const COMPARATIVE_SIGNAL_EVALUATION_METHOD = "frozen_comparative_pilot_evaluation_v1";

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 1_000_000) / 1_000_000 : null,
  };
}

function sizeBand(value) {
  if (value >= 10_000_000) return "large";
  if (value >= 1_000_000) return "medium";
  return "small";
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function dominantShare(counts, denominator) {
  const largest = Math.max(0, ...Object.values(counts));
  return ratio(largest, denominator);
}

function sourceContract(sourceContracts, id) {
  return (Array.isArray(sourceContracts?.contracts) ? sourceContracts.contracts : [])
    .find((contract) => contract.id === id) || null;
}

function awardShownCases(storySignals) {
  return storySignals.signals.map((signal) => ({
    case_id: `award_amount_rank:${signal.subject.id}`,
    metric_family: "source_bounded_award_rank",
    source_family: signal.comparison.population.source_family,
    object_type: "award",
    agency: signal.comparison.population.agency_name,
    event_key: `award:${signal.subject.id}`,
    size_band: sizeBand(signal.value),
    measurement: {
      subject_id: signal.subject.id,
      value: signal.value,
      rank: signal.comparison.rank,
      observed_count: signal.comparison.observed_count,
      agency: signal.comparison.population.agency_name,
    },
  }));
}

function checkbookSnapshots(procurement) {
  return (Array.isArray(procurement?.observations) ? procurement.observations : [])
    .filter((observation) => observation?.source_system === "checkbook_contracts")
    .map((observation) => observation.snapshot)
    .filter(Boolean);
}

function amountChangeShownCases(snapshots) {
  const agencies = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.agency]));
  return detectAmendments(snapshots).map((change) => ({
    case_id: `registered_amount_change:${change.contract_id}`,
    metric_family: "within_contract_registered_amount_change",
    source_family: "checkbook-contracts",
    object_type: "registered_contract",
    agency: agencies.get(change.contract_id) || null,
    event_key: `registered_contract:${change.contract_id}:amount_change`,
    size_band: sizeBand(change.current_amount),
    measurement: {
      subject_id: change.contract_id,
      original_amount: change.original_amount,
      current_amount: change.current_amount,
      delta: change.delta,
      agency: agencies.get(change.contract_id) || null,
    },
  }));
}

function canonicalCaseMeasurements(cases) {
  return cases
    .map((entry) => ({ case_id: entry.case_id, measurement: entry.measurement }))
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
}

function precisionDimension(shownCases, frozenCases) {
  const reviews = Array.isArray(frozenCases?.reviews) ? frozenCases.reviews : [];
  const byId = new Map(reviews.map((review) => [review.case_id, review]));
  const inspected = shownCases.map((shown) => {
    const review = byId.get(shown.case_id);
    const measurement_matches = Boolean(review)
      && JSON.stringify(shown.measurement) === JSON.stringify(review.expected);
    return {
      case_id: shown.case_id,
      metric_family: shown.metric_family,
      inspection_verdict: review?.inspection_verdict || "missing",
      measurement_matches,
      supported: review?.inspection_verdict === "supported" && measurement_matches,
    };
  });
  const supported = inspected.filter((entry) => entry.supported).length;
  return {
    definition: "Frozen inspections that support the exact shown measurement / shown outputs inspected",
    ...ratio(supported, shownCases.length),
    review_coverage: ratio(inspected.filter((entry) => entry.inspection_verdict !== "missing").length, shownCases.length),
    cases: inspected,
  };
}

function yieldDimension(awardReceipts, awardCases, snapshots, amountCases) {
  const positivePairs = snapshots.filter((snapshot) => (
    Number(snapshot.original) > 0 && Number(snapshot.current) > 0
  ));
  const families = {
    source_bounded_award_rank: {
      denominator_basis: "committed bounded subject allowlist",
      ...ratio(awardCases.length, awardReceipts.facts.length),
      peer_population_context: awardReceipts.coverage_receipt.eligible_count,
    },
    within_contract_registered_amount_change: {
      denominator_basis: "unique committed Checkbook observations with two positive registered amounts",
      ...ratio(amountCases.length, positivePairs.length),
      source_observation_context: snapshots.length,
    },
  };
  return {
    definition: "Outputs supported for inspection / eligible inputs actually evaluated by each shipped pilot",
    aggregate: ratio(
      awardCases.length + amountCases.length,
      awardReceipts.facts.length + positivePairs.length,
    ),
    families,
  };
}

function diversityDimension(shownCases) {
  const byFamily = countBy(shownCases.map((entry) => entry.metric_family));
  const bySource = countBy(shownCases.map((entry) => entry.source_family));
  const byObject = countBy(shownCases.map((entry) => entry.object_type));
  const byAgency = countBy(shownCases.map((entry) => entry.agency));
  const bySizeBand = countBy(shownCases.map((entry) => entry.size_band));
  return {
    definition: "Distinct represented dimensions and dominant-category shares across inspected outputs",
    shown_output_count: shownCases.length,
    metric_families: { count: Object.keys(byFamily).length, by_value: byFamily, dominant_share: dominantShare(byFamily, shownCases.length) },
    source_families: { count: Object.keys(bySource).length, by_value: bySource, dominant_share: dominantShare(bySource, shownCases.length) },
    object_types: { count: Object.keys(byObject).length, by_value: byObject, dominant_share: dominantShare(byObject, shownCases.length) },
    agencies: { count: Object.keys(byAgency).length, by_value: byAgency, dominant_share: dominantShare(byAgency, shownCases.length) },
    size_bands: { count: Object.keys(bySizeBand).length, by_value: bySizeBand, dominant_share: dominantShare(bySizeBand, shownCases.length) },
    all_large_contract: shownCases.length > 0 && shownCases.every((entry) => entry.size_band === "large"),
  };
}

function redundancyDimension(shownCases) {
  const uniqueEvents = new Set(shownCases.map((entry) => entry.event_key)).size;
  const duplicates = shownCases.length - uniqueEvents;
  return {
    definition: "Additional shown outputs attached to an already-represented civic event / all shown outputs",
    ...ratio(duplicates, shownCases.length),
    unique_event_count: uniqueEvents,
  };
}

function stabilityDimension({ awards, sourceContracts, awardReceipts, storySignals, snapshots, amountCases }) {
  const reversedLookup = { ...awards, rows: [...awards.rows].reverse() };
  const rebuiltAwardReceipts = buildAwardRankComparativeReadModel(reversedLookup, {
    sourceContract: sourceContract(sourceContracts, "ocp-recent-contract-awards"),
    sourceContractsSchemaVersion: sourceContracts.schema_version,
    subjectIds: awardReceipts.materialization_scope.subject_ids,
    windowStart: awardReceipts.window.start,
  });
  const reorderedAwardSignals = buildPublishedStorySignalReadModel(rebuiltAwardReceipts.facts);
  const awardStable = JSON.stringify(awardShownCases(reorderedAwardSignals))
    === JSON.stringify(awardShownCases(storySignals));
  const reversedAmountCases = amountChangeShownCases([...snapshots].reverse());
  const amountStable = JSON.stringify(canonicalCaseMeasurements(reversedAmountCases))
    === JSON.stringify(canonicalCaseMeasurements(amountCases));
  const cases = [
    { metric_family: "source_bounded_award_rank", perturbation: "reverse committed source-row order", stable: awardStable },
    { metric_family: "within_contract_registered_amount_change", perturbation: "reverse committed source-observation order", stable: amountStable },
  ];
  return {
    definition: "Pilot semantic outputs unchanged after an immaterial source-row reorder",
    ...ratio(cases.filter((entry) => entry.stable).length, cases.length),
    cases,
  };
}

function mnarSafetyDimension(negativeControl) {
  const admission = admitComparativeFact(negativeControl);
  const projected = projectPublishedStorySignal(admission);
  const publicArtifact = buildPublishedStorySignalReadModel([negativeControl]);
  const publicText = JSON.stringify({ projected, publicArtifact });
  const unsupportedPublished = admission.state === "published" || projected !== null
    || publicArtifact.signals.length > 0;
  const heldReasonLeak = /held_mnar|negative_inference|failed_predicates|gate_id/i.test(publicText);
  const negativeClaimLeak = publicText.includes(negativeControl.claim);
  const safelyWithheld = admission.state === "held_mnar"
    && !unsupportedPublished && !heldReasonLeak && !negativeClaimLeak;
  return {
    definition: "Tempting unsupported negative claims safely withheld / tempting negative claims evaluated",
    ...ratio(safelyWithheld ? 1 : 0, 1),
    expected_state: "held_mnar",
    observed_state: admission.state,
    unsupported_negative_claims_published: unsupportedPublished ? 1 : 0,
    held_reason_public_leaks: heldReasonLeak ? 1 : 0,
    negative_claim_public_leaks: negativeClaimLeak ? 1 : 0,
  };
}

function handoffDimension(usage) {
  assert.equal(usage?.numerator_event, "investigation_share:add_signal");
  assert.equal(usage?.denominator_event, "comparative_signal_shown:visible");
  assert.ok(Number.isInteger(usage?.shown_signal_opportunities) && usage.shown_signal_opportunities >= 0);
  assert.ok(Number.isInteger(usage?.investigation_handoffs) && usage.investigation_handoffs >= 0);
  assert.ok(usage.investigation_handoffs <= usage.shown_signal_opportunities);
  return {
    definition: "Aggregate Add to Investigation handoffs / aggregate shown-signal opportunities",
    numerator_event: usage.numerator_event,
    denominator_event: usage.denominator_event,
    observation_window: usage.observation_window,
    ...ratio(usage.investigation_handoffs, usage.shown_signal_opportunities),
    evidence_status: usage.shown_signal_opportunities > 0 ? "measured" : "unknown_no_exposure_denominator",
    source: usage.source,
  };
}

export function buildComparativeSignalEvaluation(inputs) {
  const {
    awards,
    sourceContracts,
    awardReceipts,
    storySignals,
    procurement,
    negativeControl,
    frozenCases,
  } = inputs;
  assert.equal(frozenCases?.schema, "cityscroll.comparative_signal_evaluation_cases.v1");
  assert.deepEqual(buildPublishedStorySignalReadModel(awardReceipts.facts), storySignals);

  const awardCases = awardShownCases(storySignals);
  const snapshots = checkbookSnapshots(procurement);
  const amountCases = amountChangeShownCases(snapshots);
  const shownCases = [...awardCases, ...amountCases].sort((left, right) => left.case_id.localeCompare(right.case_id));
  const precision = precisionDimension(shownCases, frozenCases);
  const yieldResult = yieldDimension(awardReceipts, awardCases, snapshots, amountCases);
  const diversity = diversityDimension(shownCases);
  const redundancy = redundancyDimension(shownCases);
  const stability = stabilityDimension({
    awards,
    sourceContracts,
    awardReceipts,
    storySignals,
    snapshots,
    amountCases,
  });
  const mnarSafety = mnarSafetyDimension(negativeControl);
  const handoff = handoffDimension(frozenCases.aggregate_handoff_usage);
  const recommendation = frozenCases.recommendation;
  assert.ok(["expand", "revise", "stop"].includes(recommendation?.status));
  assert.ok(Array.isArray(recommendation.metric_families_to_expand));

  const expansionEligible = recommendation.status === "expand"
    && recommendation.human_expansion_decision === "recorded"
    && recommendation.new_bounded_card_required === false
    && recommendation.metric_families_to_expand.length > 0;
  const gates = {
    precision_reviews_complete: precision.review_coverage.rate === 1,
    stability_complete: stability.rate === 1,
    mnar_safe: mnarSafety.rate === 1
      && mnarSafety.unsupported_negative_claims_published === 0
      && mnarSafety.held_reason_public_leaks === 0
      && mnarSafety.negative_claim_public_leaks === 0,
    no_automatic_metric_expansion: !expansionEligible,
  };

  return {
    schema: COMPARATIVE_SIGNAL_EVALUATION_SCHEMA,
    method: COMPARATIVE_SIGNAL_EVALUATION_METHOD,
    evaluation_id: frozenCases.evaluation_id,
    evaluated_at: frozenCases.evaluated_at,
    scope: {
      positive_pilots: ["source_bounded_award_rank", "within_contract_registered_amount_change"],
      negative_control: "successor_solicitation_absence",
      measurement_mode: "deterministic_committed_inputs_no_llm",
    },
    input_fingerprints: {
      awards: fingerprint(awards),
      source_contracts: fingerprint(sourceContracts),
      award_receipts: fingerprint(awardReceipts),
      story_signals: fingerprint(storySignals),
      procurement: fingerprint(procurement),
      negative_control: fingerprint(negativeControl),
      frozen_cases: fingerprint(frozenCases),
    },
    dimensions: {
      precision,
      yield: yieldResult,
      diversity,
      redundancy,
      stability,
      mnar_safety: mnarSafety,
      investigation_handoff: handoff,
    },
    recommendation,
    expansion_gate: {
      eligible: expansionEligible,
      metric_families_enabled: [],
      human_decision: recommendation.human_expansion_decision,
      new_bounded_card_required: recommendation.new_bounded_card_required,
    },
    gates: { ...gates, passed: Object.values(gates).every(Boolean) },
  };
}

function percent(rate) {
  return rate == null ? "unknown" : `${(rate * 100).toFixed(2)}%`;
}

export function renderComparativeSignalEvaluationReport(evaluation) {
  const dimensions = evaluation.dimensions;
  const recommendation = evaluation.recommendation;
  return `# Comparative intelligence pilot evaluation

Evaluation: \`${evaluation.evaluation_id}\`
Method: \`${evaluation.method}\`
Inputs: committed CityScroll materializations and a frozen inspection ledger; no LLM is used.

## Decision

**Recommendation: revise; do not expand the metric set yet.** ${recommendation.summary}

This is a recommendation for the captain, not an admission decision. No additional metric family is enabled by this evaluation. Expansion still requires a recorded human decision and a new bounded card.

## Results

| Dimension | Numerator / denominator | Result | Reading |
| --- | ---: | ---: | --- |
| Precision | ${dimensions.precision.numerator} / ${dimensions.precision.denominator} | ${percent(dimensions.precision.rate)} | Every frozen inspection supports the exact output, but three cases are too few to justify expansion. |
| Yield | ${dimensions.yield.aggregate.numerator} / ${dimensions.yield.aggregate.denominator} | ${percent(dimensions.yield.aggregate.rate)} | This is an output-per-eligible-input rate, not a signal count. Award rank is 1/1 within its committed allowlist; amount change is 2/1,704 positive amount pairs. |
| Diversity | ${dimensions.diversity.metric_families.count} families, ${dimensions.diversity.source_families.count} sources, ${dimensions.diversity.object_types.count} object types, ${dimensions.diversity.agencies.count} agencies | dominant family ${percent(dimensions.diversity.metric_families.dominant_share.rate)} | The sample is not all large contracts, but it remains procurement-only and tiny. |
| Redundancy | ${dimensions.redundancy.numerator} / ${dimensions.redundancy.denominator} duplicates | ${percent(dimensions.redundancy.rate)} | No civic event produces cosmetic duplicate outputs in the frozen cases. |
| Stability | ${dimensions.stability.numerator} / ${dimensions.stability.denominator} pilots | ${percent(dimensions.stability.rate)} | Reversing committed source-row order does not change semantic outputs or their canonical order. |
| MNAR safety | ${dimensions.mnar_safety.numerator} / ${dimensions.mnar_safety.denominator} tempting negative claims withheld | ${percent(dimensions.mnar_safety.rate)} | The successor-absence control remains \`held_mnar\`; no claim or held reason reaches the public projection. |
| Investigation handoff | ${dimensions.investigation_handoff.numerator} / ${dimensions.investigation_handoff.denominator} shown opportunities | ${percent(dimensions.investigation_handoff.rate)} | ${dimensions.investigation_handoff.evidence_status === "measured" ? "Aggregate handoff use is measured." : "No exposure denominator is committed yet, so usefulness is unknown—not zero."} |

## Pilot-specific findings

- **Award rank:** the shipped private signal reproduces its $53.0M amount, fourth-place rank, 264-row HPD peer set, source, and historical window. Its yield denominator is intentionally the one-subject pilot allowlist; the 8,395 eligible peer rows are context, not 8,395 shown candidates.
- **Registered-amount change:** the existing lifecycle detector finds two exact-contract changes among 1,704 committed Checkbook observations with positive original and current amounts. Both frozen inspections reproduce the source values and arithmetic. This pilot is not yet carried through the comparative receipt/admission/story-signal boundary, which is the main revision before broader evaluation.
- **MNAR negative control:** “No successor solicitation exists” remains unpublished because the observation contract is not closed-world. The harness fails if it publishes, if \`held_mnar\` changes, or if backstage reasons leak.
- **Usefulness:** CityScroll already emits aggregate, non-identifying \`investigation_share:add_signal\` when an admitted signal is added to Investigation. This card adds one event, \`comparative_signal_shown:visible\`, as its aggregate opportunity denominator. With 0/0 committed opportunities, the usefulness rate remains unknown.

## Expansion recommendation

Keep the two current families bounded. Before considering another family:

1. Put registered-amount change behind the same frozen comparative receipt and admission boundary as award rank.
2. Accumulate a larger, frozen inspection sample across both families and more than one observation window.
3. Accumulate a production observation window for the new aggregate shown-opportunity denominator and the existing \`investigation_share:add_signal\` count.
4. Re-run this harness. Any expansion still needs a captain-recorded decision and its own bounded card.

The current recommendation is **revise**, not expand or stop. The pilots are correct, non-redundant, stable, and MNAR-safe in the frozen cases; evidence of breadth and product usefulness is still insufficient.
`;
}

export function loadComparativeSignalEvaluationInputs() {
  return {
    awards: json(AWARDS),
    sourceContracts: json(SOURCE_CONTRACTS),
    awardReceipts: json(AWARD_RECEIPTS),
    storySignals: json(STORY_SIGNALS),
    procurement: readSharedProcurementReadModel(PROCUREMENT),
    negativeControl: json(NEGATIVE_CONTROL),
    frozenCases: json(FROZEN_CASES),
  };
}

export function writeComparativeSignalEvaluation({ check = false } = {}) {
  const evaluation = buildComparativeSignalEvaluation(loadComparativeSignalEvaluationInputs());
  if (!evaluation.gates.passed) throw new Error("comparative signal evaluation gates failed");
  const files = [
    [OUTPUT, `${JSON.stringify(evaluation, null, 2)}\n`],
    [REPORT, renderComparativeSignalEvaluationReport(evaluation)],
  ];
  const stale = files.filter(([url, content]) => !existsSync(url) || readFileSync(url, "utf8") !== content);
  if (check && stale.length) {
    for (const [url] of stale) console.error(`stale comparative evaluation artifact: ${fileURLToPath(url)}`);
    process.exitCode = 1;
    return evaluation;
  }
  if (!check) {
    for (const [url, content] of stale) writeFileSync(url, content);
  }
  console.log(stale.length
    ? `wrote comparative pilot evaluation (${stale.length} artifact${stale.length === 1 ? "" : "s"})`
    : "comparative pilot evaluation current");
  return evaluation;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeComparativeSignalEvaluation({ check: process.argv.includes("--check") });
}
