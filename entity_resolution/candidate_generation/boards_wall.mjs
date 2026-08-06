// Stratified board identity receipt helpers.
//
// The board wall contains three different identity problems. Keep them separate:
// publisher BodyId values are exact, community-board borough/number references
// are deterministic text extraction, and mayoral board slugs are reviewed local
// registry entries rather than city-published identifiers.

import { canonicalAgency } from "../../site/agency_identity.mjs";

export const BOARDS_WALL_SCHEMA = "cityscroll.published_walls.boards.v1";
export const MAYORAL_BOARD_REGISTRY_SCHEMA = "cityscroll.review.mayoral_board_registry.v1";

export const COMMUNITY_BOARD_COUNTS = Object.freeze({
  Bronx: 12,
  Brooklyn: 18,
  Manhattan: 12,
  Queens: 14,
  "Staten Island": 3,
});

const BOROUGH_NAMES = Object.keys(COMMUNITY_BOARD_COUNTS);
const BOROUGH_PATTERN = BOROUGH_NAMES.join("|");

function clean(value) {
  return String(value ?? "").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
}

function canonicalBorough(value) {
  const normalized = clean(value).toLowerCase();
  return BOROUGH_NAMES.find((borough) => borough.toLowerCase() === normalized) || null;
}

/** Return a stable body id only for a known NYC community-board borough/number. */
export function communityBoardBodyId(borough, number) {
  const canonical = canonicalBorough(borough);
  const district = Number(number);
  if (!canonical || !Number.isInteger(district) || district < 1 || district > COMMUNITY_BOARD_COUNTS[canonical]) return null;
  return `${canonical.toLowerCase().replace(/ /g, "-")}-cb-${String(district).padStart(2, "0")}`;
}

/**
 * Extract explicit borough + Community Board number pairs.
 *
 * The parser deliberately does not accept `CB 1`, a bare `Board 1`, a
 * community district, or a borough-free number. Those forms do not carry the
 * canonical identity needed by the wall.
 */
export function extractCommunityBoardReferences(value) {
  const text = clean(value);
  const found = [];
  const seen = new Set();
  const add = (boroughValue, numberValue, evidence) => {
    const bodyId = communityBoardBodyId(boroughValue, Number(numberValue));
    if (!bodyId || seen.has(bodyId)) return;
    seen.add(bodyId);
    found.push({
      body_id: bodyId,
      borough: canonicalBorough(boroughValue),
      number: Number(numberValue),
      evidence: clean(evidence),
    });
  };

  const boardThenBorough = new RegExp(
    `\\bcommunity\\s+board\\s*(?:no\\.?\\s*|#\\s*)?(\\d{1,2})\\s*(?:,|\\bin\\b|\\(|-)\\s*(${BOROUGH_PATTERN})\\b`,
    "gi",
  );
  for (const match of text.matchAll(boardThenBorough)) add(match[2], match[1], match[0]);

  const boroughThenBoard = new RegExp(
    `\\b(${BOROUGH_PATTERN})\\s+community\\s+board\\s*(?:no\\.?\\s*|#\\s*)?(\\d{1,2})\\b`,
    "gi",
  );
  for (const match of text.matchAll(boroughThenBoard)) add(match[1], match[2], match[0]);

  return found.sort((a, b) => a.body_id.localeCompare(b.body_id));
}

export function extractCommunityBoardReference(value) {
  const matches = extractCommunityBoardReferences(value);
  return matches.length === 1 ? matches[0] : null;
}

export function measureCommunityBoardExtraction(fixture = {}) {
  const positives = Array.isArray(fixture.positive) ? fixture.positive : [];
  const negatives = Array.isArray(fixture.negative) ? fixture.negative : [];
  const positiveResults = positives.map((row) => ({
    expected: row.body_id,
    actual: extractCommunityBoardReference(row.text)?.body_id || null,
  }));
  const negativeResults = negatives.map((row) => ({
    expected: null,
    actual: extractCommunityBoardReference(row.text)?.body_id || null,
  }));
  const truePositives = positiveResults.filter((row) => row.actual === row.expected).length;
  const falseNegatives = positiveResults.length - truePositives;
  const falsePositives = negativeResults.filter((row) => row.actual !== null).length;
  const proposed = truePositives + falsePositives;
  return {
    fixture_id: fixture.fixture_id || null,
    positive_cases: positives.length,
    negative_cases: negatives.length,
    true_positives: truePositives,
    false_negatives: falseNegatives,
    false_positives: falsePositives,
    precision: proposed ? Number((truePositives / proposed).toFixed(4)) : null,
    recall: positives.length ? Number((truePositives / positives.length).toFixed(4)) : null,
    fixture_proven_precision: proposed > 0 && falsePositives === 0,
    results: { positives: positiveResults, negatives: negativeResults },
  };
}

export function validateMayoralBoardRegistry(registry) {
  const errors = [];
  if (registry?.schema !== MAYORAL_BOARD_REGISTRY_SCHEMA) errors.push("schema mismatch");
  if (registry?.operative_links_enabled !== false) errors.push("operative links must remain disabled");
  if (!Array.isArray(registry?.entries) || registry.entries.length === 0) errors.push("entries must be non-empty");
  const ids = new Set();
  const slugs = new Set();
  for (const entry of registry?.entries || []) {
    if (!entry?.id || ids.has(entry.id)) errors.push(`duplicate or missing entry id: ${entry?.id || "(missing)"}`);
    if (entry?.minted_slug && slugs.has(entry.minted_slug)) errors.push(`duplicate minted slug: ${entry.minted_slug}`);
    if (entry?.id) ids.add(entry.id);
    if (entry?.minted_slug) slugs.add(entry.minted_slug);
    for (const field of ["display_name", "canonical_ref", "minted_slug", "review_status", "evidence"]) {
      if (!entry?.[field]) errors.push(`${entry?.id || "(missing)"}: missing ${field}`);
    }
    if (entry?.display_name && entry?.minted_slug && entry?.canonical_ref) {
      const canonical = canonicalAgency(entry.display_name);
      if (canonical.canonical_id !== entry.minted_slug || entry.canonical_ref !== `agency:id:${canonical.canonical_id}`) {
        errors.push(`${entry.id}: minted slug does not match canonicalAgency`);
      }
    }
    if (entry?.review_status === "reviewed" && (!entry.reviewer || !entry.reviewed_date)) {
      errors.push(`${entry.id}: reviewed entry needs reviewer and reviewed_date`);
    }
    if (entry?.review_status !== "reviewed") errors.push(`${entry?.id || "(missing)"}: seed entries must be explicitly reviewed before registry use`);
  }
  return { valid: errors.length === 0, errors };
}

export function buildBoardsWallReceipt({
  observedOn,
  legistarBodies = [],
  legistarMode = "fixture",
  legistarCoverage = {},
  communityInventory = {},
  unclassifiedSourceBodyTypes = [],
  excludedSourceCounts = {},
  communityExtraction,
  mayoralRegistry,
} = {}) {
  const registryCheck = validateMayoralBoardRegistry(mayoralRegistry);
  if (!registryCheck.valid) throw new Error(`Invalid mayoral board registry: ${registryCheck.errors.join("; ")}`);
  const expectedCommunityBoards = Object.values(COMMUNITY_BOARD_COUNTS).reduce((sum, count) => sum + count, 0);
  const observedCommunityBoards = Number(communityInventory.inventoried ?? 0);
  const bodyNames = [...new Set(legistarBodies.map((row) => String(row?.BodyName ?? row?.body_name ?? row?.name ?? "").trim()).filter(Boolean))].sort();
  const bodyIds = [...new Set(legistarBodies.map((row) => String(row?.BodyId ?? row?.body_id ?? row?.id ?? "").trim()).filter(Boolean))].sort();
  return {
    schema: BOARDS_WALL_SCHEMA,
    observed_on: observedOn,
    status: "stratified_review_receipt",
    contract: {
      populations_are_disjoint: true,
      candidates_or_inferences_are_not_public_facts: true,
      canonical_identities_required: true,
      operative_links_enabled: false,
    },
    scope_exclusions: {
      borough_presidents: {
        count: Number(excludedSourceCounts.borough_president ?? 0),
        reason: "Borough-president offices remain in the source inventory but are not one of the three board identity strata.",
      },
    },
    detectors: {
      unknown_source_body_types: [...new Set(unclassifiedSourceBodyTypes)].sort(),
      fail_closed_on_new_population: true,
      community_board_fixture_id: communityExtraction?.fixture_id || null,
      registry_schema: MAYORAL_BOARD_REGISTRY_SCHEMA,
    },
    strata: {
      council_adjacent: {
        status: "convertible",
        identity: "publisher_body_id",
        source: {
          endpoint: "https://webapi.legistar.com/v1/nyc/Bodies",
          token_env: "LEGISTAR_API_TOKEN",
          acquisition_path: "CI secret-backed authenticated request",
          mode: legistarMode,
        },
        bodies_observed: bodyIds.length,
        body_ids: bodyIds,
        body_names: bodyNames,
        coverage: legistarCoverage,
        operative_links_enabled: false,
      },
      community_boards: {
        status: "convertible",
        identity: "exact_borough_plus_number",
        inventory: {
          observed: observedCommunityBoards,
          expected: expectedCommunityBoards,
          rate: expectedCommunityBoards ? Number((observedCommunityBoards / expectedCommunityBoards).toFixed(4)) : 0,
          by_borough: communityInventory.by_borough || COMMUNITY_BOARD_COUNTS,
        },
        extraction: communityExtraction,
        coverage_block: communityExtraction?.fixture_proven_precision
          ? "Fixture precision is 100%; production promotion still requires the same exact parser and a dated source receipt."
          : "No precision promotion: extraction fixture did not clear the zero-false-positive bar.",
        operative_links_enabled: false,
      },
      mayoral_commissions: {
        status: "reviewed_registry_pending_operative_use",
        identity: "reviewed_minted_agency_slug",
        registry_schema: MAYORAL_BOARD_REGISTRY_SCHEMA,
        entries: mayoralRegistry.entries.length,
        publisher_identifiers_observed: 0,
        review_status: "reviewed_seed_entries",
        coverage_block: "The city-published source does not provide a board identifier; minted slugs remain local reviewed registry identities and do not authorize an operative join.",
        operative_links_enabled: false,
      },
    },
  };
}
