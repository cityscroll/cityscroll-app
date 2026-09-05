/**
 * NYC Council land-use matter bridge (LDP-11).
 *
 * Measures exact land-identifier prevalence in the Council matters already
 * materialized by the strict notice→event join (`meeting_outcomes_snapshot.json`,
 * `exact_date_body_tokens`), then classifies each eligible matter appearance
 * against the retained ZAP project registry. Only a publisher-supplied ULURP
 * token or exact ZAP project id present on the matter (`MatterFile` / matter
 * title) may advance a row past `unresolved`. Title, address, committee name,
 * meeting date, or "zoning" wording alone never mint a land-project join.
 *
 * A successful exact-matter join reuses the existing `about_project` /
 * `reviews_project` relation contract from `site/land_project_decision_relations.mjs`
 * (LDP-06/LDP-07) rather than inventing a parallel vocabulary, and attaches the
 * observed Council depth already retained on the matter: event identity,
 * committee action(s), roll-call vote, and agenda/meeting documents. None of
 * that depth is reinterpreted as a documented land decision — the negative
 * rule below is enforced regardless of how the action or vote reads.
 */

import { extractUlurpKeys } from "../../site/ulurp_tokens.mjs";
import { materializeExactNoticeProjectEdge } from "../../site/land_project_decision_relations.mjs";

export const COUNCIL_LAND_BRIDGE_SCHEMA = "cityscroll.council_land_bridge_measurement.v1";
export const COUNCIL_LAND_EDGE_SCHEMA = "cityscroll.council_land_matter_edge.v1";
export const USEFULNESS_THRESHOLD = 0.3;

export const JOIN_METHODS = Object.freeze({
  EXACT_ULURP_TOKEN: "exact_ulurp_token",
  EXACT_ZAP_PROJECT_ID: "exact_zap_project_id",
});

export const REJECTION_REASONS = Object.freeze({
  NOT_ELIGIBLE: "not_present_council_matter",
  NO_REFERENCE: "no_reference",
  NO_EXACT_LAND_KEY: "no_exact_land_key",
  AMBIGUOUS_KEY: "ambiguous_key",
});

const ZAP_PROJECT_ID_RE = /\b(?:19|20)\d{2}[A-Z]\d{4}\b/g;

function clean(value, max = 2000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Flatten `meeting_outcomes_snapshot.json` into one row per (event, matter)
 * appearance. Only `snapshot_state: "present"` notices carry materialized
 * Legistar depth (the strict `exact_date_body_tokens` join already gates
 * that state); absent notices are never eligible.
 *
 * @param {object} snapshot - `site/data/meeting_outcomes_snapshot.json` shape
 * @returns {object[]}
 */
export function flattenCouncilMatterRows(snapshot = {}) {
  const rows = [];
  for (const [requestId, notice] of Object.entries(snapshot?.by_notice || {})) {
    if (notice?.snapshot_state !== "present") continue;
    const event = notice.event || {};
    for (const matter of notice.matters || []) {
      rows.push({
        request_id: clean(requestId, 40),
        event: {
          event_id: clean(event.event_id, 40) || null,
          name: clean(event.name, 240) || null,
          date: clean(event.date, 20) || null,
          url: clean(event.url, 1000) || null,
          documents: Array.isArray(event.documents) ? event.documents : [],
        },
        matter_id: clean(matter?.matter_id, 40) || null,
        matter_file: clean(matter?.matter_file, 120) || null,
        matter_url: clean(matter?.matter_url, 1000) || null,
        title: clean(matter?.title, 2000) || null,
        actions: Array.isArray(matter?.actions) ? matter.actions.map((a) => clean(a, 240)) : [],
        outcome: clean(matter?.outcome, 240) || null,
        votes: matter?.votes && typeof matter.votes === "object" ? matter.votes : null,
        documents: Array.isArray(matter?.documents) ? matter.documents : [],
      });
    }
  }
  return rows;
}

/** True for any flattened row: eligibility is source-shaped (a materialized present-notice matter). */
export function isEligibleCouncilMatterRow(row = {}) {
  return Boolean(row.matter_id);
}

/**
 * Build the retained-ZAP exact-ULURP-token registry a candidate matter is
 * measured against. `zapRows` is the committed
 * `zap_projects_warehouse_lookup.json` row set.
 */
export function buildZapKeyRegistry(zapRows = []) {
  const byUlurp = new Map();
  const byProjectId = new Set();
  for (const row of zapRows || []) {
    const projectId = clean(row?.project_id, 40);
    if (!projectId) continue;
    byProjectId.add(projectId);
    for (const key of extractUlurpKeys(row.ulurp_numbers)) {
      if (!byUlurp.has(key)) byUlurp.set(key, new Set());
      byUlurp.get(key).add(projectId);
    }
  }
  return { byUlurp, byProjectId };
}

function matterHaystack(row = {}) {
  return [row.matter_file, row.title].filter(Boolean).join(" ");
}

function candidateKeysForRow(haystack, registry) {
  const candidates = [];
  for (const key of extractUlurpKeys(haystack)) {
    const projectIds = registry.byUlurp.get(key);
    if (projectIds?.size) candidates.push({ method: JOIN_METHODS.EXACT_ULURP_TOKEN, key, project_ids: [...projectIds] });
  }
  for (const match of haystack.toUpperCase().matchAll(ZAP_PROJECT_ID_RE)) {
    const key = match[0];
    if (registry.byProjectId.has(key)) {
      candidates.push({ method: JOIN_METHODS.EXACT_ZAP_PROJECT_ID, key, project_ids: [key] });
    }
  }
  return candidates;
}

/**
 * Classify one Council matter appearance's exact-land-identifier eligibility.
 * Similarity, title, address, committee identity, or meeting-date signals are
 * never join inputs; only a candidate key present in the retained ZAP
 * registry can advance a row past `unresolved`.
 */
export function classifyCouncilMatterRow(row = {}, registry) {
  if (!isEligibleCouncilMatterRow(row)) {
    return { status: "not_eligible", reason: REJECTION_REASONS.NOT_ELIGIBLE, candidates: [] };
  }
  const haystack = matterHaystack(row);
  if (!haystack.trim()) {
    return { status: "rejected", reason: REJECTION_REASONS.NO_REFERENCE, candidates: [] };
  }
  const candidates = candidateKeysForRow(haystack, registry);
  if (!candidates.length) {
    return { status: "unresolved", reason: REJECTION_REASONS.NO_EXACT_LAND_KEY, candidates: [] };
  }
  const projectIdSet = new Set(candidates.flatMap((candidate) => candidate.project_ids));
  if (projectIdSet.size > 1) {
    return { status: "rejected", reason: REJECTION_REASONS.AMBIGUOUS_KEY, candidates };
  }
  const projectId = [...projectIdSet][0];
  return { status: "matched", reason: null, project_id: projectId, candidates };
}

/**
 * Materialize one matched Council matter into the shared `about_project` /
 * `reviews_project` relation contract (LDP-06/LDP-07), then attach the
 * observed event/matter/action/vote/document depth this card adds. Returns
 * null when the shared classifier does not accept the underlying join (for
 * example a missing required evidence field) — a defensive floor on top of
 * `classifyCouncilMatterRow`'s own gate.
 */
export function materializeCouncilMatterEdge(row = {}, classification) {
  if (classification?.status !== "matched") return null;
  const primary = classification.candidates[0];
  const sourceUrl = row.matter_url || row.event?.url || null;
  const subjectEdge = materializeExactNoticeProjectEdge(
    {
      agency_name: "City Council",
      label: row.event?.name || null,
      short_title: row.title || null,
      section_name: "Public Hearings and Meetings",
      source_system: "legistar",
      source_url: sourceUrl,
    },
    {
      project_id: classification.project_id,
      from: `legistar-event:${row.event?.event_id || "unknown"}:matter:${row.matter_id}`,
      method: primary.method,
      source_record: `legistar:matter:${row.matter_id}`,
      join_key: primary.method === JOIN_METHODS.EXACT_ZAP_PROJECT_ID ? "zap_project_id" : "ulurp_number",
      join_value: primary.key,
      source_fields: ["matter_file", "title"],
      method_version: "1",
      observed_time: row.event?.date || null,
    },
  );
  if (!subjectEdge?.accepted) return null;

  const documents = [
    ...(row.event?.documents || []).map((doc) => ({ scope: "event", name: doc?.name || null, url: doc?.url || null })),
    ...(row.documents || []).map((doc) => ({ scope: "matter", name: doc?.name || doc?.MatterAttachmentName || null, url: doc?.url || doc?.MatterAttachmentHyperlink || null })),
  ].filter((doc) => doc.url);
  if (row.matter_url) documents.push({ scope: "matter", name: "Legistar matter detail", url: row.matter_url });

  return Object.freeze({
    schema: COUNCIL_LAND_EDGE_SCHEMA,
    relation: subjectEdge.canonical_relation,
    proceeding_relation: subjectEdge.proceeding_relation,
    compatibility_relation: subjectEdge.compatibility_relation,
    is_decision: false,
    from: subjectEdge.canonical_edge.from,
    to: subjectEdge.canonical_edge.to,
    project_id: classification.project_id,
    council_depth: Object.freeze({
      event: Object.freeze({
        event_id: row.event?.event_id ?? null,
        name: row.event?.name ?? null,
        date: row.event?.date ?? null,
        url: row.event?.url ?? null,
      }),
      matter: Object.freeze({
        matter_id: row.matter_id,
        matter_file: row.matter_file,
        matter_url: row.matter_url,
        title: row.title,
      }),
      actions: Object.freeze([...row.actions]),
      outcome: row.outcome,
      votes: row.votes ? Object.freeze({ ...row.votes }) : null,
      documents: Object.freeze(documents),
    }),
    provenance: subjectEdge.evidence,
    negative_rule:
      "Exact matter identity supports an observed review/concern record at most; a committee action or roll-call vote here is never equated with a documented land decision.",
  });
}

function tally(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key];
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

/**
 * Measure exact land-identifier coverage across the eligible Council matter
 * corpus and produce a versioned receipt. Edges materialize only when both
 * the row count and the measured rate clear `USEFULNESS_THRESHOLD`;
 * otherwise the receipt is an honest stop receipt and no edge is returned.
 */
export function measureCouncilLandBridge({
  rows = [],
  zapRows = [],
  generatedAt,
  sourceVintage = {},
} = {}) {
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const registry = buildZapKeyRegistry(zapRows);
  const eligible = rows.filter(isEligibleCouncilMatterRow);
  const classified = eligible.map((row) => ({ row, classification: classifyCouncilMatterRow(row, registry) }));

  const matched = classified.filter((entry) => entry.classification.status === "matched");
  const unresolved = classified.filter((entry) => entry.classification.status === "unresolved");
  const rejected = classified.filter((entry) => entry.classification.status === "rejected");

  const rate = eligible.length ? matched.length / eligible.length : 0;
  const aboveThreshold = eligible.length > 0 && rate >= USEFULNESS_THRESHOLD;
  const gate = matched.length > 0 && aboveThreshold ? "GO" : "STOP";

  const precisionSample = matched.slice(0, 10).map((entry) => ({
    matter_id: entry.row.matter_id,
    matter_file: entry.row.matter_file,
    event_id: entry.row.event?.event_id || null,
    project_id: entry.classification.project_id,
    join_method: entry.classification.candidates[0]?.method,
    join_key: entry.classification.candidates[0]?.key,
    source_url: entry.row.matter_url || entry.row.event?.url || null,
  }));

  const materializedEdges = gate === "GO"
    ? matched
      .map((entry) => materializeCouncilMatterEdge(entry.row, entry.classification))
      .filter(Boolean)
    : [];

  return {
    schema: COUNCIL_LAND_BRIDGE_SCHEMA,
    generated_at: generatedAt,
    source_vintage: sourceVintage,
    join_measurement: {
      strategy: "exact_ulurp_token | exact_zap_project_id",
      usefulness_threshold: USEFULNESS_THRESHOLD,
      rates: {
        exact_land_identifier: {
          joined: matched.length,
          total: eligible.length,
          rate: Number(rate.toFixed(6)),
        },
      },
      verdict: gate === "GO"
        ? `Above usefulness threshold (>=${Math.round(USEFULNESS_THRESHOLD * 100)}%). Ship Council matter edge materialization.`
        : `Below usefulness threshold (${(rate * 100).toFixed(2)}%). The Council land-matter bridge stays disabled.`,
    },
    coverage: {
      eligible_rows: eligible.length,
      matched: matched.length,
      unresolved: unresolved.length,
      rejected: rejected.length,
      unresolved_reasons: tally(unresolved.map((entry) => entry.classification), "reason"),
      rejected_reasons: tally(rejected.map((entry) => entry.classification), "reason"),
    },
    precision_sample: precisionSample,
    gate: {
      result: gate,
      thresholds: { minimum_matches: 1, minimum_rate: USEFULNESS_THRESHOLD },
      rationale: gate === "GO"
        ? `${matched.length} of ${eligible.length} eligible Council matter appearances (${(rate * 100).toFixed(2)}%) carry a retained exact land identifier.`
        : `${matched.length} of ${eligible.length} eligible Council matter appearances (${(rate * 100).toFixed(2)}%) carry a retained exact land identifier; below the ${Math.round(USEFULNESS_THRESHOLD * 100)}% usefulness bar.`,
      resident_ingestion_committed: false,
    },
    materialized_edges: materializedEdges,
    honest_absent: gate === "STOP",
  };
}
