// Deterministic labeling-function accounting for pair_features_v2.
// A labeling function emits same, different, or abstain.  Accounting is
// independent of scorer precedence so overlap and conflict remain visible.

import { FEATURES_VERSION } from "../features/index.mjs";

export const LABELING_FUNCTIONS_VERSION = "er_labeling_functions_v1";
export const ACCOUNTING_SCHEMA_VERSION = 1;

const same = (name, predicate, description) => ({
  name,
  label: "same",
  description,
  apply: (features) => predicate(features) ? "same" : null,
});
const different = (name, predicate, description) => ({
  name,
  label: "different",
  description,
  apply: (features) => predicate(features) ? "different" : null,
});

export const LABELING_FUNCTIONS = Object.freeze([
  same("scoped_authority_key_equal_v1", (f) => f.authority_key_equal === true,
    "A complete, scoped authority key agrees on both sides."),
  same("contract_id_equal_v0", (f) => f.contract_id_equal === true,
    "A contract identifier agrees on both sides."),
  different("hard_id_conflict_v0", (f) => f.family === "procurement" && f.hard_id_conflict === true,
    "Comparable hard identifiers disagree for a procurement pair."),
  different("agency_place_conflict_v0", (f) => f.family === "agency" && f.agency_place_conflict === true,
    "Agency names identify different places."),
  different("vendor_legal_form_conflict_v0", (f) => f.family === "vendor" &&
    f.legal_form_conflict === true && f.token_jaccard === 1,
  "Vendor identity tokens agree exactly but legal forms disagree."),
  same("vendor_stem_equal_v0", (f) => f.family === "vendor" && f.stem_equal === true,
    "Vendor stems are equal."),
  same("agency_stem_equal_v0", (f) => f.family === "agency" && f.stem_equal === true,
    "Agency canonical stems are equal."),
  same("token_similarity_v0", (f) => f.family !== "procurement" &&
    f.legal_form_conflict !== true && f.token_jaccard >= 0.9,
  "Non-procurement identity tokens have at least 0.9 Jaccard similarity."),
  same("vendor_typo_proximity_v1", (f) => f.family === "vendor" &&
    f.legal_form_conflict !== true && f.typo_proximity?.close === true &&
    f.token_jaccard >= 0.5 && (f.shared_tokens?.length || 0) >= 1,
  "Vendor stems are within the bounded typo distance with token support."),
  same("vendor_truncation_v1", (f) => f.family === "vendor" &&
    f.legal_form_conflict !== true && f.stem_truncation === true &&
    ((f.shared_tokens?.length || 0) >= 1 || f.hard_id_equal === true),
  "One vendor stem is a bounded prefix of the other."),
  same("vendor_abbreviation_v1", (f) => f.family === "vendor" &&
    f.legal_form_conflict !== true && (f.abbreviation_matches || 0) > 0 &&
    f.abbreviation_matches >= f.left_token_count - f.shared_tokens.length &&
    f.abbreviation_matches >= f.right_token_count - f.shared_tokens.length,
  "Known vendor abbreviations explain all unmatched tokens."),
]);

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function assertFeatures(rows) {
  for (const row of rows) {
    if (row?.features?.features_version !== FEATURES_VERSION) {
      throw new Error(`labeling-function accounting requires ${FEATURES_VERSION}`);
    }
  }
}

function metricsFor(name, rows, votes, goldById) {
  const covered = rows.filter((row) => votes.get(row.pair_id)?.has(name));
  const overlap = covered.filter((row) => votes.get(row.pair_id).size > 1);
  const conflicts = covered.filter((row) => {
    const labels = [...votes.get(row.pair_id).values()];
    return labels.some((label) => label !== votes.get(row.pair_id).get(name));
  });
  const goldCovered = covered.filter((row) => goldById.has(row.pair_id));
  const correct = goldCovered.filter((row) =>
    votes.get(row.pair_id).get(name) === goldById.get(row.pair_id));
  return {
    labeling_function: name,
    coverage_count: covered.length,
    coverage_rate: rate(covered.length, rows.length),
    overlap_count: overlap.length,
    overlap_rate: rate(overlap.length, covered.length),
    conflict_count: conflicts.length,
    conflict_rate: rate(conflicts.length, covered.length),
    gold_coverage_count: goldCovered.length,
    gold_coverage_rate: rate(goldCovered.length, goldById.size),
    empirical_accuracy_count: correct.length,
    empirical_accuracy: rate(correct.length, goldCovered.length),
  };
}

export function accountLabelingFunctions({ rows = [], gold = [] } = {}) {
  assertFeatures(rows);
  const goldById = new Map(gold.map((row) => [String(row.pair_id || row.id), row.label]));
  const votes = new Map();
  const voteRows = rows.map((row) => {
    const pairVotes = new Map();
    for (const lf of LABELING_FUNCTIONS) {
      const label = lf.apply(row.features);
      if (label) pairVotes.set(lf.name, label);
    }
    votes.set(row.pair_id, pairVotes);
    return { pair_id: row.pair_id, votes: Object.fromEntries(pairVotes) };
  });
  const conflictPairs = voteRows.filter((row) => new Set(Object.values(row.votes)).size > 1);
  const coveredPairs = voteRows.filter((row) => Object.keys(row.votes).length > 0);
  const goldRows = rows.filter((row) => goldById.has(row.pair_id));
  return {
    kind: "entity_resolution_labeling_function_accounting",
    accounting_version: LABELING_FUNCTIONS_VERSION,
    schema_version: ACCOUNTING_SCHEMA_VERSION,
    features_version: FEATURES_VERSION,
    population: {
      pair_count: rows.length,
      gold_pair_count: goldRows.length,
      labeling_function_count: LABELING_FUNCTIONS.length,
      covered_pair_count: coveredPairs.length,
      covered_pair_rate: rate(coveredPairs.length, rows.length),
      conflict_pair_count: conflictPairs.length,
      conflict_pair_rate: rate(conflictPairs.length, rows.length),
    },
    definitions: {
      coverage: "rows on which the labeling function emits a non-abstain label",
      overlap: "covered rows on which at least one other labeling function also emits",
      conflict: "covered rows on which at least one other labeling function emits the opposite label",
      empirical_accuracy: "correct emitted labels divided by emitted labels on rows present in the supplied gold stratum",
    },
    labeling_functions: LABELING_FUNCTIONS.map((lf) => ({
      name: lf.name,
      label: lf.label,
      description: lf.description,
      metrics: metricsFor(lf.name, rows, votes, goldById),
    })),
    pair_votes: voteRows,
  };
}

export function renderLabelingFunctionSummary(report) {
  const rows = report.labeling_functions.map(({ name, label, metrics }) =>
    `| ${name} | ${label} | ${metrics.coverage_count} (${metrics.coverage_rate ?? "—"}) | ${metrics.overlap_count} (${metrics.overlap_rate ?? "—"}) | ${metrics.conflict_count} (${metrics.conflict_rate ?? "—"}) | ${metrics.empirical_accuracy_count}/${metrics.gold_coverage_count} (${metrics.empirical_accuracy ?? "—"}) |`
  ).join("\n");
  return `# Labeling-function accounting ${report.accounting_version}

Feature set: **${report.features_version}** · pairs: **${report.population.pair_count}** · gold stratum: **${report.population.gold_pair_count}**

Coverage is emitted labels divided by all pairs. Overlap is the share of a function's covered rows with another vote. Conflict is the share of its covered rows with an opposite vote. Accuracy is measured only where a gold label is supplied; empty denominators remain —.

| Labeling function | Label | Coverage | Overlap | Conflict | Gold accuracy |
| --- | --- | ---: | ---: | ---: | ---: |
${rows}

Overall: **${report.population.covered_pair_count}** pairs covered (${report.population.covered_pair_rate ?? "—"}); **${report.population.conflict_pair_count}** pairs have conflicting votes (${report.population.conflict_pair_rate ?? "—"}).
`;
}
