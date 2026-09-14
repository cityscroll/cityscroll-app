/**
 * Versioned, place-scoped text projection for the local-topic front door.
 *
 * This module deliberately indexes records; it does not deduplicate them or
 * infer relationships from similar wording. Callers must provide the exact
 * district membership and the source-backed identity for every row.
 */
export const DISTRICT_TOPIC_INDEX_SCHEMA = "cityscroll.district_topic_index.v1";
export const DISTRICT_TOPIC_INDEX_VERSION = 1;
export const DISTRICT_TOPIC_SOURCE_FAMILIES = Object.freeze([
  "district_activity", "community_board_request", "community_board_response",
  "community_board_project", "community_board_position", "community_board_decision",
  "community_board_meeting", "document_excerpt", "shared_procurement_read_model",
]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value, max = 4000) => String(value ?? "")
  .replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, max);
const day = (value) => { const v = clean(value, 20).slice(0, 10); return DAY.test(v) ? v : null; };
const array = (value) => Array.isArray(value) ? value : [];
const first = (...values) => values.map(day).find(Boolean) || null;
const href = (value) => { const v = clean(value, 2000); return v.startsWith("/") && !v.startsWith("//") ? v : null; };
const url = (value) => { const v = clean(value, 2000); return /^https?:\/\/[^\s<>"']+$/.test(v) ? v : null; };

function districtKeys(row) {
  const place = row?.place || row?.locality || {};
  return new Set(array(row?.districts || row?.district_membership || row?.district_memberships)
    .concat([row?.district, row?.district_id, row?.community_district, row?.community_district_id, place?.district, place?.community_district].filter(Boolean))
    .map((value) => typeof value === "object" ? (value.key || value.id || value.code) : value)
    .map((value) => clean(value, 120).toLowerCase()).filter(Boolean));
}

function textFields(row, fields) {
  return fields.flatMap((field) => {
    const value = row?.[field];
    return Array.isArray(value) ? value.map((item) => clean(item)).filter(Boolean) : [clean(value)].filter(Boolean);
  });
}

const FIELD_GROUPS = Object.freeze({
  district_activity: ["title", "summary", "description", "agency", "type", "status"],
  community_board_request: ["title", "request", "request_text", "priority", "description", "subject"],
  community_board_response: ["response", "response_text", "answer", "agency_response", "change", "notes"],
  community_board_project: ["title", "project", "project_name", "description", "project_description", "address"],
  community_board_position: ["title", "position", "position_text", "stance", "subject", "description"],
  community_board_decision: ["title", "decision", "decision_text", "subject", "subject_topics", "passages", "authority"],
  community_board_meeting: ["title", "name", "agenda", "description", "meeting_type", "committee"],
  document_excerpt: ["title", "excerpt", "text", "accepted_excerpt", "passage", "summary"],
  shared_procurement_read_model: ["short_title", "title", "summary", "agency_name", "vendor_name", "search_text"],
});

function sourceFamily(row, fallback) {
  const actionFamily = {
    budget_request: "community_board_request", agency_response_change: "community_board_response",
    land_position: "community_board_position", decision: "community_board_decision",
    resolution: "community_board_decision", meeting: "community_board_meeting",
    project: "community_board_project", document_publication: "document_excerpt",
  }[row?.action_type];
  return clean(row?.source_family || row?.source?.family || row?.provenance?.source_family || actionFamily || fallback, 100);
}

function normalizeEntry(row, fallbackFamily, district) {
  if (!row || typeof row !== "object") return null;
  const family = sourceFamily(row, fallbackFamily);
  if (!DISTRICT_TOPIC_SOURCE_FAMILIES.includes(family)) return null;
  const objectType = clean(row.object_type || row.type || row.action_type || family, 100);
  const objectId = clean(row.object_id || row.object_ref || row.id || row.canonical_id || row.candidate_id, 400);
  const route = href(row.route || row.canonical_href || row.href || row.detail_route);
  const sourceReference = clean(row.source_reference || row.source_observation_ref || row.source_ref
    || row.source?.reference || row.source?.id || row.provenance?.source_observation_ref, 500);
  const sourceUrl = url(row.source_url || row.source?.url || row.provenance?.source_url || row.document?.document_url);
  const observedThrough = first(row.observed_through, row.observed_on, row.as_of, row.freshness?.observed_through,
    row.source?.observed_through, row.source?.observed_on, row.document?.observed_through);
  const texts = textFields(row, FIELD_GROUPS[family] || ["title", "summary", "description", "search_text"]);
  if (!district || !objectId || !route || !sourceReference || !sourceUrl || !observedThrough || !texts.length) return null;
  return Object.freeze({
    schema: DISTRICT_TOPIC_INDEX_SCHEMA,
    district,
    source_family: family,
    canonical_type: objectType,
    object_id: objectId,
    route,
    relationship: Object.freeze({ ...(row.board_id ? { board_id: clean(row.board_id, 120) } : {}), district }),
    source: Object.freeze({ reference: sourceReference, url: sourceUrl }),
    observed_through: observedThrough,
    text: texts.join(" ").slice(0, 8000),
    ...(family === "shared_procurement_read_model" ? { procurement_document: row } : {}),
  });
}

function rowsFor(input, family) {
  const activity = input?.community_board_activity || input?.board_activity;
  const activityRows = family === "community_board_request" ? array(activity).filter((row) => row?.action_type === "budget_request")
    : family === "community_board_response" ? array(activity).filter((row) => row?.action_type === "agency_response_change")
      : family === "community_board_project" ? array(activity).filter((row) => row?.action_type === "project")
        : family === "community_board_position" ? array(activity).filter((row) => row?.action_type === "land_position")
          : family === "community_board_decision" ? array(activity).filter((row) => ["decision", "resolution"].includes(row?.action_type))
            : family === "community_board_meeting" ? array(activity).filter((row) => row?.action_type === "meeting")
              : family === "document_excerpt" ? array(activity).filter((row) => row?.action_type === "document_publication") : [];
  if (activityRows.length) return activityRows;
  const value = input?.[family] ?? input?.[`${family}s`];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value).flatMap((row) => Array.isArray(row) ? row : [row]);
  return [];
}

export function buildDistrictTopicIndex(input = {}, { district } = {}) {
  const key = clean(district, 120).toLowerCase();
  const entries = DISTRICT_TOPIC_SOURCE_FAMILIES.flatMap((family) => rowsFor(input, family)
    .filter((row) => districtKeys(row).has(key))
    .map((row) => normalizeEntry(row, family, key)).filter(Boolean));
  const seen = new Set();
  const unique = entries.filter((entry) => { const id = `${entry.source_family}|${entry.object_id}`; if (seen.has(id)) return false; seen.add(id); return true; });
  return Object.freeze({ schema: DISTRICT_TOPIC_INDEX_SCHEMA, version: DISTRICT_TOPIC_INDEX_VERSION, district: key, entries: Object.freeze(unique), coverage: coverageReceipt(input, unique, key) });
}

export function searchDistrictTopics(index, query) {
  const terms = clean(query, 240).toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  if (!terms.length || index?.schema !== DISTRICT_TOPIC_INDEX_SCHEMA) return [];
  return (index.entries || []).filter((entry) => terms.every((term) => entry.text.toLocaleLowerCase("en-US").includes(term)))
    .map((entry) => Object.freeze({ ...entry, matched_terms: terms.filter((term) => entry.text.toLocaleLowerCase("en-US").includes(term)) }));
}

export function coverageReceipt(input = {}, entries = [], district = "") {
  const families = Object.fromEntries(DISTRICT_TOPIC_SOURCE_FAMILIES.map((family) => {
    const supplied = rowsFor(input, family);
    const indexed = entries.filter((entry) => entry.source_family === family).length;
    const counts = supplied.reduce((acc, row) => { const state = clean(row?.coverage_state || row?.state, 40) || "indexed"; acc[state] = (acc[state] || 0) + 1; return acc; }, {});
    return [family, { indexed, withheld: counts.withheld || 0, stale: counts.stale || 0, unavailable: counts.unavailable || 0, unlocated: supplied.filter((row) => !districtKeys(row).has(district)).length }];
  }));
  return Object.freeze({ schema: "cityscroll.district_topic_coverage.v1", district, by_source_family: Object.freeze(families) });
}

export const buildDistrictTopicSearchIndex = buildDistrictTopicIndex;
export const queryDistrictTopicIndex = searchDistrictTopics;
