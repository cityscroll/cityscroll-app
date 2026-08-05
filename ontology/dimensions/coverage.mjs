// Dimension: coverage
// For every declared source contract, distinguish acquisition/product delivery
// from immutable D1 observation coverage. Emit cards only for the latter.

import { makeDimensionCard } from "./shared.mjs";
import { isProductMaterialized, normalizeSourceState } from "../source_state.mjs";

export const DIMENSION_ID = "coverage";

/**
 * Map source_contracts ids → source_coverage dual-write matrix ids when they differ.
 * Unmapped live contracts with no dual-write entry are treated as not-ingested
 * for observation coverage purposes when they declare ingest intent.
 */
const CONTRACT_TO_COVERAGE = Object.freeze({
  "city-record": "city-record-notices",
  "passport-public-contracts": "passport-public-contracts",
  "passport-public-rfx": "passport-public-rfx",
  "checkbook-contracts": "checkbook-contracts",
  "checkbook-spending": "checkbook-spending",
  "checkbook-nycha-contracts": "checkbook-nycha-contracts",
  "doing-business-entities": "doing-business-entities",
  "nycida-build-nyc-projects": "nycida-build-nyc-projects",
  "nyc-council-legistar": "legistar-events",
  "abo-local-authorities": "abo-external-awards",
  "abo-local-development-corporations": "abo-external-awards",
  "abo-state-authorities": "abo-external-awards",
});

/**
 * @param {object} input
 * @param {object} input.source_contracts — site/data/source_contracts.json
 * @param {object} input.source_coverage — entity_resolution/source_coverage.json
 * @param {object} [input.gap_taxonomy]
 */
export function evaluateCoverage(input = {}) {
  const contracts = Array.isArray(input.source_contracts?.contracts)
    ? input.source_contracts.contracts
    : [];
  const coverageSources = Array.isArray(input.source_coverage?.sources)
    ? input.source_coverage.sources
    : [];
  const coverageById = new Map(coverageSources.map((s) => [s.id, s]));

  const cards = [];
  const metrics = {
    declared_live: 0,
    product_materialized: 0,
    source_records_complete: 0,
    source_records_not_declared: 0,
    source_records_gaps: 0,
    disabled_or_pointer: 0,
  };

  for (const contract of contracts) {
    const id = String(contract.id || "").trim();
    if (!id) continue;
    const status = String(contract.status || "").toLowerCase();
    const contractClass = String(contract.contract_class || contract.kind || "").toLowerCase();

    if (status === "disabled" || contractClass === "pointer") {
      metrics.disabled_or_pointer += 1;
      continue;
    }
    // Only probe sources that claim to be product-live or build-time ingested
    if (status && !["live", "build-time"].includes(status)) {
      continue;
    }
    metrics.declared_live += 1;

    const coverageId = CONTRACT_TO_COVERAGE[id] || id;
    const coverage = coverageById.get(coverageId);
    const sourceState = normalizeSourceState({ contract, coverage, coverageId });
    if (isProductMaterialized(sourceState)) metrics.product_materialized += 1;
    const after = sourceState.source_records_coverage.dual_write_status;
    const knownGap = Boolean(sourceState.source_records_coverage.known_gap);

    // Declared live, not present in the observation coverage matrix at all
    if (!coverage) {
      // Skip pure pointer / non-ingest product feeds (RSS, geocoders) unless
      // they declare source_record intent.
      if (contract.ingest === false || contract.observation_coverage === false) {
        metrics.source_records_complete += 1;
        continue;
      }
      // SODA/API datasets and dual-write candidates matter; a missing matrix
      // row is an observation-retention gap, not evidence of failed acquisition.
      metrics.source_records_not_declared += 1;
      cards.push(makeDimensionCard({
        dimension: DIMENSION_ID,
        slug: `source-records-not-declared-${id}`,
        title: `Add immutable observation coverage: ${id}`,
        rank_score: 78,
        evidence: {
          source_id: id,
          coverage_id: coverageId,
          contract_status: status || null,
          kind: "source-records-not-declared",
          has_dataset: Boolean(contract.dataset_id),
          has_endpoint: Boolean(contract.endpoint),
          source_state: sourceState,
        },
        verify: contract.verify
          || `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${coverageId} present`,
        demo_win: `Source ${id} retains immutable D1 observations without changing its product-delivery status.`,
        context: [
          "site/data/source_contracts.json",
          "entity_resolution/source_coverage.json",
          contract.landing_page || null,
        ].filter(Boolean),
        lesson_class: "source-records-not-declared",
      }));
      continue;
    }

    if (after === "complete" && !knownGap) {
      metrics.source_records_complete += 1;
      continue;
    }

    if (after === "gap" || knownGap) {
      metrics.source_records_gaps += 1;
      cards.push(makeDimensionCard({
        dimension: DIMENSION_ID,
        slug: `dual-write-${coverageId}`,
        title: `Close observation coverage gap: ${coverageId}`,
        rank_score: 85,
        evidence: {
          source_id: id,
          coverage_id: coverageId,
          dual_write_after: after || null,
          known_gap: coverage.known_gap || null,
          kind: "dual-write-gap",
          source_state: sourceState,
        },
        verify: `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${coverageId} after=complete`,
        demo_win: `Source ${coverageId} retains immutable observations and counts as covered.`,
        context: [
          "entity_resolution/source_coverage.json",
          coverage.importer || null,
        ].filter(Boolean),
        lesson_class: "dual-write-coverage-gap",
      }));
    }
  }

  return {
    dimension: DIMENSION_ID,
    metrics,
    cards,
  };
}
