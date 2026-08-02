// Dimension: coverage
// For every declared source contract, check whether it is actually ingested
// and moving a coverage metric. Emit a card per declared-not-ingested source.

import { makeDimensionCard } from "./shared.mjs";

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
    ingested_complete: 0,
    declared_not_ingested: 0,
    dual_write_gaps: 0,
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
    const after = coverage?.dual_write?.after;
    const knownGap = Boolean(coverage?.known_gap);

    // Declared live, not present in the observation coverage matrix at all
    if (!coverage) {
      // Skip pure pointer / non-ingest product feeds (RSS, geocoders) unless
      // they declare source_record intent.
      if (contract.ingest === false || contract.observation_coverage === false) {
        metrics.ingested_complete += 1;
        continue;
      }
      // Heuristic: SODA/API datasets and dual-write candidates matter;
      // landing-only manuals without dataset_id/endpoint may still be declared-not-ingested
      // when status is live and scope includes lifecycle.
      metrics.declared_not_ingested += 1;
      cards.push(makeDimensionCard({
        dimension: DIMENSION_ID,
        slug: `not-ingested-${id}`,
        title: `Ingest declared source: ${id}`,
        rank_score: 78,
        evidence: {
          source_id: id,
          coverage_id: coverageId,
          contract_status: status || null,
          kind: "declared-not-ingested",
          has_dataset: Boolean(contract.dataset_id),
          has_endpoint: Boolean(contract.endpoint),
        },
        verify: contract.verify
          || `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${coverageId} present`,
        demo_win: `Declared source ${id} is ingested and moves a coverage metric readers can trust.`,
        context: [
          "site/data/source_contracts.json",
          "entity_resolution/source_coverage.json",
          contract.landing_page || null,
        ].filter(Boolean),
        lesson_class: "declared-not-ingested",
      }));
      continue;
    }

    if (after === "complete" && !knownGap) {
      metrics.ingested_complete += 1;
      continue;
    }

    if (after === "gap" || knownGap) {
      metrics.dual_write_gaps += 1;
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
