// Exact-key Legistar committee graph materialization.
//
// OfficeRecord rows are observations, not a current-state table. Repeated
// PersonId + BodyId rows remain separate when their dates, titles, or source
// hashes differ so appointment history cannot be overwritten by a uniqueness
// constraint.

import { createHash } from "node:crypto";

export const COMMITTEE_GRAPH_SCHEMA = "cityscroll.committee_graph.v1";
export const COMMITTEE_GATE_SAMPLE_SIZE = 30;
export const COMMITTEE_SOURCE_URL = "https://webapi.legistar.com/v1/nyc/persons";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sourceRowHash(raw) {
  return createHash("sha256").update(stableValue(raw)).digest("hex");
}

function dateValue(value) {
  const text = clean(value);
  return text ? text.slice(0, 10) : null;
}

function personId(raw) {
  return clean(raw.OfficeRecordPersonId ?? raw.PersonId ?? raw.person_id);
}

function bodyId(raw) {
  return clean(raw.OfficeRecordBodyId ?? raw.BodyId ?? raw.body_id);
}

function bodyName(raw) {
  return clean(raw.OfficeRecordBodyName ?? raw.BodyName ?? raw.body_name);
}

export function isExcludedGovernanceBody(name) {
  const normalized = clean(name).toLowerCase();
  return normalized === "city council"
    || normalized === "new york city council"
    || normalized === "public advocate"
    || normalized === "office of the public advocate";
}

function chairFromTitle(title) {
  const normalized = clean(title).toLowerCase();
  if (!normalized || /\b(?:vice|co|deputy)[ -]?chair/.test(normalized)) return false;
  return /(^|[\s,/(])chair(?:person)?($|[\s,/)])/.test(normalized);
}

export function normalizeOfficeRecord(raw = {}, { retrievedAt = null } = {}) {
  const person = personId(raw);
  const body = bodyId(raw);
  const name = bodyName(raw);
  if (!person || !body || !name || isExcludedGovernanceBody(name)) return null;
  const title = clean(raw.OfficeRecordTitle ?? raw.Title ?? raw.title) || null;
  const sourceRowHashValue = sourceRowHash(raw);
  return {
    official_id: `official:${person}`,
    person_id: person,
    committee_id: `committee:${body}`,
    body_id: body,
    body_name: name,
    title,
    is_chair: title ? chairFromTitle(title) : false,
    valid_from: dateValue(raw.OfficeRecordStartDate ?? raw.StartDate ?? raw.start_date),
    valid_to: dateValue(raw.OfficeRecordEndDate ?? raw.EndDate ?? raw.end_date),
    source_url: `${COMMITTEE_SOURCE_URL}/${encodeURIComponent(person)}/officerecords`,
    retrieved_at: retrievedAt,
    retrieved_on: retrievedAt ? dateValue(retrievedAt) : null,
    source_row_hash: sourceRowHashValue,
  };
}

function personIds(peopleDoc = {}) {
  const ids = new Set();
  for (const [id, row] of Object.entries(peopleDoc.by_person_id || {})) {
    const value = clean(row?.person_id || id).replace(/^official:/, "");
    if (value) ids.add(value);
  }
  for (const row of peopleDoc.rows || []) {
    const value = clean(row?.person_id).replace(/^official:/, "");
    if (value) ids.add(value);
  }
  return ids;
}

export function buildCommitteeGraph(sourceRows = [], peopleDoc = {}, {
  retrievedAt = new Date().toISOString(),
  gate = { publication_allowed: false },
} = {}) {
  const knownPeople = personIds(peopleDoc);
  const observations = [];
  const rejected = { unknown_person: 0, missing_identity_fields: 0, excluded_governance_body: 0 };
  for (const raw of sourceRows) {
    const rawPerson = personId(raw);
    const rawBody = bodyId(raw);
    const rawName = bodyName(raw);
    if (isExcludedGovernanceBody(rawName)) { rejected.excluded_governance_body += 1; continue; }
    if (!rawPerson || !rawBody || !rawName) { rejected.missing_identity_fields += 1; continue; }
    if (!knownPeople.has(rawPerson)) { rejected.unknown_person += 1; continue; }
    const observation = normalizeOfficeRecord(raw, { retrievedAt });
    if (observation) observations.push(observation);
  }
  const nodes = [...new Map(observations.map((row) => [row.committee_id, {
    id: row.committee_id,
    type: "committee",
    name: row.body_name,
    properties: { body_id: row.body_id, body_name: row.body_name },
    provenance: {
      source: { system: "nyc_legistar_office_records", id: row.body_id, url: row.source_url },
      source_fields: ["OfficeRecordBodyId", "OfficeRecordBodyName"],
      observed_at: row.retrieved_at,
    },
    confidence: { status: "not_scored", basis: "publisher_record" },
  }])).values()];
  const edges = observations.map((row) => ({
    id: `edge:member_of:${row.official_id}:${row.committee_id}:${row.source_row_hash}`,
    type: "member_of",
    from: row.official_id,
    to: row.committee_id,
    title: row.title,
    is_chair: row.is_chair,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    source_url: row.source_url,
    retrieved_at: row.retrieved_at,
    retrieved_on: row.retrieved_on,
    source_row_hash: row.source_row_hash,
    role_semantics: "descriptive membership only; no influence, support, control, or vote implication",
    provenance: {
      source: {
        system: "nyc_legistar_office_records",
        id: `officerecord:${row.person_id}:${row.body_id}:${row.source_row_hash}`,
        url: row.source_url,
      },
      source_fields: [
        "OfficeRecordPersonId", "OfficeRecordBodyId", "OfficeRecordBodyName",
        "OfficeRecordTitle", "OfficeRecordStartDate", "OfficeRecordEndDate",
      ],
      observed_at: row.retrieved_at,
    },
    confidence: { status: "strong", basis: "exact_publisher_keys" },
  }));
  return {
    schema: COMMITTEE_GRAPH_SCHEMA,
    generated_at: retrievedAt,
    identity: {
      official_key: "official:{OfficeRecordPersonId}",
      committee_key: "committee:{OfficeRecordBodyId}",
      name_identity_forbidden: true,
    },
    history: {
      observations_retained: observations.length,
      duplicate_person_body_rows_retained: observations.length - new Set(observations.map((row) => `${row.person_id}:${row.body_id}`)).size,
      current_membership_is_derived_only: true,
    },
    rejected,
    nodes,
    observations,
    public_edges: gate.publication_allowed ? edges : [],
    edge_observations: edges,
    public_graph: { nodes, edges: gate.publication_allowed ? edges : [] },
    publication: gate.publication_allowed ? "published" : "held",
  };
}

export function buildCommitteeGateReceipt({
  observedAt,
  samplePersonIds = [],
  currentPersonIds = [],
  formerPersonIds = [],
  socrataPersonIds = [],
  rows = null,
  peopleDoc = {},
  error = null,
  sampleComplete = true,
} = {}) {
  const sampleAvailable = Array.isArray(rows) && sampleComplete;
  const known = personIds(peopleDoc);
  const nonExcludedRows = sampleAvailable
    ? rows.filter((row) => !isExcludedGovernanceBody(bodyName(row)))
    : [];
  const exactRows = nonExcludedRows.filter((row) => {
    const id = personId(row);
    return known.has(id) && Boolean(bodyId(row)) && Boolean(bodyName(row));
  });
  const accepted = exactRows.map((row) => normalizeOfficeRecord(row, { retrievedAt: observedAt })).filter(Boolean);
  const reviewed = nonExcludedRows.length;
  const dateOrderFailures = accepted.filter((row) => row.valid_from && row.valid_to && row.valid_from > row.valid_to).length;
  const exactKeyPrecision = sampleAvailable && reviewed ? Number((exactRows.length / reviewed).toFixed(4)) : null;
  const currentHistoryOverlap = {
    current_person_count: currentPersonIds.length,
    historical_person_count: formerPersonIds.length,
    current_and_historical_person_count: currentPersonIds.filter((id) => formerPersonIds.includes(id)).length,
    current_and_socrata_person_count: currentPersonIds.filter((id) => socrataPersonIds.includes(id)).length,
    historical_and_socrata_person_count: formerPersonIds.filter((id) => socrataPersonIds.includes(id)).length,
  };
  const publicationAllowed = sampleAvailable
    && samplePersonIds.length === COMMITTEE_GATE_SAMPLE_SIZE
    && reviewed > 0
    && exactKeyPrecision >= 0.95
    && dateOrderFailures === 0;
  return {
    schema: "cityscroll.committee_gate_receipt.v1",
    observed_at: observedAt,
    sample_plan: {
      requested: COMMITTEE_GATE_SAMPLE_SIZE,
      current_term: 20,
      recent_former: 5,
      already_in_socrata_lookup: 5,
      person_ids: samplePersonIds,
    },
    source: {
      endpoint: "GET https://webapi.legistar.com/v1/nyc/persons/{PersonId}/officerecords",
      auth_token_env: "LEGISTAR_API_TOKEN",
      exact_join: "OfficeRecordPersonId = person_hub.council_member_id",
      name_only_edges: 0,
      error,
    },
    review: {
      accepted_non_council_non_advocate_rows: sampleAvailable ? exactRows.length : null,
      reviewed_non_council_non_advocate_rows: sampleAvailable ? reviewed : null,
      exact_key_precision: exactKeyPrecision,
      date_order_failures: sampleAvailable ? dateOrderFailures : null,
      unknown_person_ids: sampleAvailable ? nonExcludedRows.filter((row) => !known.has(personId(row))).length : null,
      missing_required_fields: sampleAvailable ? nonExcludedRows.filter((row) => !bodyId(row) || !bodyName(row) || !personId(row)).length : null,
      body_name_mismatches: null,
      current_vs_historical_overlap: currentHistoryOverlap,
      denominator: sampleAvailable ? reviewed : null,
    },
    gate: {
      exact_key_precision_minimum: 0.95,
      name_only_edges: 0,
      publication_allowed: publicationAllowed,
      publication_status: publicationAllowed ? "published" : "held",
      reason: publicationAllowed
        ? "Authenticated sample clears exact-key precision and history review."
        : (error || "Authenticated sample is unavailable; public membership edges remain held."),
    },
  };
}
