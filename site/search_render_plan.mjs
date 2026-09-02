/**
 * The canonical Search document's render plan.
 *
 * `search_document.mjs` paints from this plan, and the search-execution receipt
 * is built from the same plan object. That is the whole point: one pure selection
 * decides what a reader sees AND what is later observed, so a receipt can never
 * drift from the page and no observation path has to scrape the DOM.
 *
 * Nothing here touches `document`, `location`, or `fetch` — it is a pure function
 * of the already-normalized `/search` and `/search/candidates` responses.
 */

import { SEARCH_ACTIVITY_FAMILIES } from "../capabilities/search_activity.mjs";
import { relevanceResultHref } from "./universal_search_relevance_ux.mjs";
import { searchFamilyForResult } from "./search_lens_handoff.mjs";
import { topicCandidateTitle } from "./semantic_topic_search.mjs";

export const SEARCH_RENDER_PLAN_SCHEMA = "cityscroll.search_render_plan.v1";

/** Lane order on the canonical Search document; also the visible rank order. */
export const SEARCH_RENDER_FAMILIES = SEARCH_ACTIVITY_FAMILIES;

/** Family coverage states that mean "this source was not fully checked". */
const INCOMPLETE_FAMILY_STATUSES = new Set(["unknown", "not_covered"]);

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function laneIndex(keywordPayload) {
  return new Map((keywordPayload?.lanes || [])
    .filter((family) => family && typeof family === "object")
    .map((family) => [family.id, family]));
}

function keywordRow(record) {
  const canonicalHref = relevanceResultHref(record);
  const family = searchFamilyForResult(record);
  if (!canonicalHref || !SEARCH_RENDER_FAMILIES.includes(family)) return null;
  return {
    reference: clean(record?.object_ref, 360) || canonicalHref,
    entity_type: clean(record?.entity_type || record?.object_type, 80) || "unclassified",
    family,
    kind: "keyword",
    title: clean(record?.title, 500) || "Public record",
    canonical_href: canonicalHref,
  };
}

function semanticRow(candidate) {
  const family = clean(candidate?.civic_object_family, 80);
  const reference = clean(candidate?.candidate_id, 360);
  if (!reference || !SEARCH_RENDER_FAMILIES.includes(family)) return null;
  const canonicalHref = candidate?.source?.canonical_href == null
    ? null
    : clean(candidate.source.canonical_href, 600);
  return {
    reference,
    entity_type: clean(candidate?.source?.family, 80) || "unclassified",
    family,
    kind: "semantic",
    title: topicCandidateTitle(candidate),
    canonical_href: canonicalHref,
  };
}

/** Group keyword results into lanes exactly as the document renders them. */
function keywordItemsByFamily(keywordPayload) {
  const grouped = new Map(SEARCH_RENDER_FAMILIES.map((family) => [family, []]));
  for (const record of keywordPayload?.results || []) {
    const row = keywordRow(record);
    if (!row) continue;
    grouped.get(row.family).push({ kind: "keyword", record, row });
  }
  return grouped;
}

function semanticItemsByFamily(semantic) {
  const grouped = new Map(SEARCH_RENDER_FAMILIES.map((family) => [family, []]));
  for (const group of semantic?.groups || []) {
    if (!grouped.has(group?.id)) continue;
    for (const candidate of group.candidates || []) {
      const row = semanticRow(candidate);
      if (!row || row.family !== group.id) continue;
      grouped.get(group.id).push({ kind: "semantic", candidate, row });
    }
  }
  return grouped;
}

/**
 * Families whose source could not be fully checked for this execution.
 * A missing keyword payload means the keyword producer itself was unavailable,
 * which leaves every family incomplete rather than merely empty.
 */
function incompleteFamilies(keywordPayload) {
  if (!keywordPayload) return [...SEARCH_RENDER_FAMILIES];
  const lanes = laneIndex(keywordPayload);
  return SEARCH_RENDER_FAMILIES.filter((family) => {
    const lane = lanes.get(family);
    return !lane || INCOMPLETE_FAMILY_STATUSES.has(clean(lane.status, 40));
  });
}

function outcomeFor({ mode, renderedCount, incomplete }) {
  if (mode === "unavailable") return "unavailable";
  if (incomplete.length) return "partial";
  return renderedCount ? "matched" : "empty";
}

function producersFor(keywordPayload, semantic) {
  return {
    search_method: clean(keywordPayload?.match_mode, 120) || null,
    search_schema: clean(keywordPayload?.schema, 120) || null,
    candidates_method: clean(semantic?.method, 120) || null,
    candidates_schema: clean(semantic?.schema, 120) || null,
  };
}

/**
 * Build the render plan for one settled Search execution.
 *
 * `state` is the document's own settled-response record:
 *   { state: "legacy" | "combined" | "semantic" | "unavailable",
 *     payload?, keyword?, semantic?, coverage?, keywordCoverage? }
 */
export function buildSearchRenderPlan(state) {
  const mode = clean(state?.state, 40) || "unavailable";
  const keywordPayload = mode === "legacy" ? (state?.payload || null) : (state?.keyword || null);
  const semantic = state?.semantic || null;
  const coverage = (mode === "legacy" ? state?.coverage : state?.keywordCoverage) || null;

  const keywordItems = keywordItemsByFamily(keywordPayload);
  const semanticItems = mode === "legacy" || mode === "unavailable"
    ? new Map(SEARCH_RENDER_FAMILIES.map((family) => [family, []]))
    : semanticItemsByFamily(semantic);

  const families = [];
  const rows = [];
  const familyCounts = {};
  for (const family of SEARCH_RENDER_FAMILIES) {
    const semanticForFamily = semanticItems.get(family) || [];
    // Combined rendering suppresses a keyword result the semantic lane already shows.
    const semanticHrefs = new Set(semanticForFamily
      .map((item) => item.row.canonical_href)
      .filter(Boolean));
    const keywordForFamily = (mode === "unavailable" ? [] : keywordItems.get(family) || [])
      .filter((item) => !(mode === "combined" && semanticHrefs.has(item.row.canonical_href)));
    const items = mode === "semantic"
      ? semanticForFamily
      : [...semanticForFamily, ...keywordForFamily];
    for (const item of items) {
      item.row = { ...item.row, rank: rows.length + 1 };
      rows.push(item.row);
    }
    familyCounts[family] = items.length;
    families.push({ id: family, items, count: items.length });
  }

  const incomplete = mode === "unavailable" ? [...SEARCH_RENDER_FAMILIES] : incompleteFamilies(keywordPayload);
  return Object.freeze({
    schema: SEARCH_RENDER_PLAN_SCHEMA,
    mode,
    keyword_payload: keywordPayload,
    semantic,
    coverage,
    families,
    rows,
    rendered_count: rows.length,
    family_counts: familyCounts,
    incomplete_families: incomplete,
    outcome: outcomeFor({ mode, renderedCount: rows.length, incomplete }),
    producers: producersFor(keywordPayload, semantic),
  });
}
