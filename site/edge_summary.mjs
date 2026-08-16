import { normalizeCrossSpineConfidence } from "./cross_spine_confidence.mjs";
import { officialSourceLink } from "./affordance_grammar.mjs";
import { residentOfficialSource } from "./graph_edge_provenance.mjs";
import { readerLabel, readerValue } from "./reader_surface_labels.mjs";

/**
 * Shared typed edge-summary contract.
 *
 * This is a presentation narrow waist, not a graph store. Producers provide
 * the already-materialized count and the already-scoped destination; this
 * module preserves those facts and gives every surface the same readable rail.
 */

export const EDGE_SUMMARY_SCHEMA = "cityscroll.edge_summary.v1";
export const EDGE_SUMMARY_STATES = Object.freeze(["matched", "empty", "unknown"]);
export const EDGE_SUMMARY_STATE_MEANINGS = Object.freeze({
  matched: "available",
  empty: "empty-in-scope",
  unknown: "unknown",
});
export const ENTITY_PIVOT_SCHEMA = EDGE_SUMMARY_SCHEMA;

const MAX_TEXT = 500;

function text(value, max = MAX_TEXT) {
  if (value == null) return null;
  const out = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function cloneScope(scope) {
  if (scope == null) return null;
  if (typeof scope !== "object") return text(scope, 300);
  if (Array.isArray(scope)) return scope.map((value) => cloneScope(value));
  return Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, cloneScope(value)]));
}

function normalizedCount(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizedState(value, count) {
  const state = text(value, 30)?.toLowerCase();
  if (EDGE_SUMMARY_STATES.includes(state)) return state;
  if (["not_yet_ingested", "not_ingested", "unavailable", "held", "not_indexed"].includes(state)) {
    return "unknown";
  }
  if (count == null) return "unknown";
  return count === 0 ? "empty" : "matched";
}

const CROSS_SPINE_READER_LABELS = Object.freeze({
  confirmed: "Confirmed connection",
  review: "Needs review",
  unmatched: "Connection not verified",
});

function crossSpineReaderLabel(value) {
  return CROSS_SPINE_READER_LABELS[normalizeCrossSpineConfidence(value)] || "";
}

function canonicalHref(href, asOf) {
  if (href == null || href === "") return null;
  const raw = String(href).trim();
  if (!raw) return null;
  const day = text(asOf, 40)?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || null;
  if (!day || raw.startsWith("#")) return raw;
  try {
    const url = new URL(raw, "https://cityscroll.org");
    if (!url.searchParams.has("as_of")) url.searchParams.set("as_of", day);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return /^https:\/\/cityscroll\.org/.test(raw) || raw.startsWith("/") ? path : raw;
  } catch {
    return raw;
  }
}

const VERIFIED_INTERNAL_ROUTES = [
  /^\/(?:notices|agencies|vendors|officials)\/[A-Za-z0-9_%~-]+\/?(?:\?.*)?(?:#[A-Za-z0-9_~-]+)?$/,
  /^\/meetings\/[A-Za-z0-9_%:/.~-]+\/?(?:\?.*)?(?:#[A-Za-z0-9_~-]+)?$/,
  /^\/browse\/(?:contracts|staffing|zoning|property|rules|meetings|people|places)\/?(?:\?.*)?(?:#.*)?$/,
  /^\/browse\/?(?:\?.*)?$/,
  /^\/parcels\/\d{10}\/?(?:\?.*)?$/,
  /^\/exams\/\d{4}\/?(?:\?.*)?$/,
  /^\/(?:near-you|following)(?:\/[^?#]*)?\/?(?:\?.*)?(?:#.*)?$/,
  /^\/community-boards\/?(?:\?.*)?(?:#.*)?$/,
  /^\/community-boards\/[A-Za-z0-9_%~-]+\/?(?:\?.*)?(?:#.*)?$/,
  /^#parcel-biography-(?:property|land|tax_lien|ll48|cofo)$/,
  /^#notice\/[A-Za-z0-9_%~-]+$/,
  /^\/#land\/[A-Za-z0-9_%~-]+(?:\?.*)?$/,
  /^#land\/[A-Za-z0-9_%~-]+(?:\?.*)?$/,
];

/** The route inventory is deliberately closed: a display name never mints a URL. */
export function entityPivotRouteStatus(href) {
  const value = canonicalHref(href);
  if (!value) return { verified: false, reason: "missing_destination", href: null };
  const verified = VERIFIED_INTERNAL_ROUTES.some((pattern) => pattern.test(value));
  return { verified, reason: verified ? null : "unsupported_destination", href: value };
}

/**
 * Resolve a typed edge to a published destination without deriving a URL from
 * its display text. Object routes win when supplied; bounded scope routes are
 * the fallback for aggregate edges. Every candidate must pass the closed
 * route inventory before it can be published.
 */
export function resolveEdgeSummaryDestination(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const candidates = [
    [raw.object_href, "object"],
    [raw.target_href, "object"],
    [raw.canonical_object_href, "object"],
    [raw.target_id != null ? raw.canonical_href : null, "object"],
    [raw.target_id != null ? raw.href : null, "object"],
    [raw.scope_href, "scope"],
    [raw.browse_href, "scope"],
    [raw.target_id == null ? raw.canonical_href : null, "scope"],
    [raw.target_id == null ? raw.href : null, "scope"],
  ].filter(([href]) => href != null && String(href).trim());
  for (const [href, kind] of candidates) {
    const route = entityPivotRouteStatus(canonicalHref(href, raw.as_of));
    if (route.verified) return { ...route, kind };
  }
  return {
    verified: false,
    reason: candidates.length ? "unsupported_destination" : "missing_destination",
    href: null,
    kind: null,
  };
}

function normalizeSource(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "source") && input.source === null) return null;
  const source = input.source && typeof input.source === "object" ? input.source : {};
  const kind = text(source.kind || input.source_kind, 80);
  const id = source.id ?? input.source_id;
  const name = source.name ?? input.source_name;
  const href = source.canonical_href ?? source.href ?? input.source_href;
  if (![kind, id, name, href].some((value) => value != null && String(value).trim())) return null;
  return {
    kind,
    id: id == null ? null : text(id, 240),
    name: name == null ? null : text(name, 240),
    canonical_href: canonicalHref(href),
  };
}

function normalizeEdgeProvenance(input = {}) {
  const provenance = input.provenance && typeof input.provenance === "object"
    ? input.provenance
    : {};
  const nested = input.cross_spine && typeof input.cross_spine === "object"
    ? input.cross_spine
    : (provenance.cross_spine && typeof provenance.cross_spine === "object"
      ? provenance.cross_spine
      : {});
  const rawConfidence = nested.confidence
    ?? input.cross_spine_confidence
    ?? provenance.cross_spine_confidence
    ?? null;
  const sourceHref = readerValue(provenance.source_href ?? provenance.source_url ?? input.source_href);
  return Object.freeze({
    source_system: readerValue(provenance.source_system),
    source_record_id: readerValue(provenance.source_record_id),
    source_fields: readerValue(provenance.source_fields),
    join_method: readerValue(provenance.join_method ?? provenance.basis ?? input.join_method),
    ...(sourceHref ? { source_href: sourceHref } : {}),
    observed_at: readerValue(provenance.observed_at ?? input.as_of),
    cross_spine_confidence: normalizeCrossSpineConfidence(rawConfidence) || "unmatched",
    cross_spine_explicit: input.cross_spine_explicit ?? rawConfidence != null,
  });
}

function crossSpinePivotFields(input = {}) {
  const provenance = normalizeEdgeProvenance(input);
  return {
    cross_spine_confidence: provenance.cross_spine_confidence,
    cross_spine_explicit: provenance.cross_spine_explicit,
  };
}

/** Normalize a relation on the le-01 edge-summary narrow waist. */
export function normalizeEntityPivot(input = {}, defaults = {}) {
  const raw = { ...defaults, ...input };
  const targetName = raw.target_name ?? raw.target_label ?? raw.name;
  const targetId = raw.target_id ?? raw.id;
  const relation = edgeRelationLabel({
    edge_type: raw.edge_type || raw.relation,
    relation_label: raw.relation_label,
    label: raw.label,
    target_name: targetName,
  });
  const route = resolveEdgeSummaryDestination(raw);
  const source = normalizeSource(raw);
  const status = raw.status === "held" || raw.pivot_state === "held" || !route.verified ? "held" : "accepted";
  return Object.freeze({
    schema: ENTITY_PIVOT_SCHEMA,
    relation_label: text(relation, 240) || "related records",
    target_kind: text(raw.target_kind, 80),
    target_id: targetId == null ? null : text(targetId, 240),
    target_name: targetName == null ? null : text(targetName, 240),
    canonical_href: status === "accepted" ? route.href : null,
    source: Object.freeze(source),
    provenance: normalizeEdgeProvenance(raw),
    ...crossSpinePivotFields(raw),
    scope: cloneScope(raw.scope),
    as_of: raw.as_of == null ? null : text(raw.as_of, 40),
    status,
    hold_reason: status === "held" ? (raw.hold_reason || route.reason) : null,
  });
}

export function normalizeEntityPivots(records, defaults = {}) {
  return (Array.isArray(records) ? records : []).map((record) => normalizeEntityPivot(record, defaults));
}

/** Fail a build/test when a supposedly accepted edge points outside the route inventory. */
export function assertEntityPivotClosure(records = []) {
  const failures = (Array.isArray(records) ? records : []).flatMap((record, index) => {
    const supplied = [
      record?.object_href,
      record?.target_href,
      record?.canonical_object_href,
      record?.canonical_href,
      record?.scope_href,
      record?.browse_href,
      record?.href,
    ].find((href) => href != null && String(href).trim());
    const destination = resolveEdgeSummaryDestination(record);
    return supplied && !destination.verified
      ? [{ index, href: String(supplied), reason: destination.reason }]
      : [];
  });
  if (failures.length) {
    throw new Error(`Entity pivot route closure failed: ${failures.map((item) => `${item.index}:${item.href}`).join(", ")}`);
  }
  return true;
}

function targetDisplay(pivot) {
  const kind = text(pivot.target_kind, 80);
  const name = text(pivot.target_name, 240) || text(pivot.target_id, 240) || "Related record";
  return kind ? `${kind.replaceAll("_", " ")} · ${name}` : name;
}

/** Render one typed pivot; held edges remain visible text with no fabricated link. */
export function renderEntityPivotLink(pivotInput = {}, { className = "", escape = escapeHTML } = {}) {
  const pivot = normalizeEntityPivot(pivotInput);
  const crossSpineConfidence = normalizeCrossSpineConfidence(
    pivotInput.cross_spine_confidence || pivotInput.cross_spine,
  ) || "unmatched";
  const crossSpineExplicit = pivotInput.cross_spine_explicit
    ?? (pivotInput.cross_spine_confidence != null || pivotInput.cross_spine != null);
  const crossSpineBlocksLink = crossSpineExplicit && crossSpineConfidence !== "confirmed";
  const sourceName = pivot.source?.name || pivot.source?.kind || "this record";
  const accessible = `${pivot.relation_label}: ${targetDisplay(pivot)}; from ${sourceName}`;
  const classes = ["ui-constellation-link", className].filter(Boolean).join(" ");
  const attrs = [
    `data-pivot-schema="${escape(ENTITY_PIVOT_SCHEMA)}"`,
    `data-pivot-status="${escape(pivot.status)}"`,
    `data-pivot-relation-label="${escape(pivot.relation_label)}"`,
    `data-pivot-target-kind="${escape(pivot.target_kind || "")}"`,
    `data-pivot-target-id="${escape(pivot.target_id || "")}"`,
    ...(pivot.source?.kind || pivot.source?.id || pivot.source?.name
      ? [
        `data-pivot-source-kind="${escape(pivot.source?.kind || "")}"`,
        `data-pivot-source-id="${escape(pivot.source?.id || "")}"`,
      ]
      : []),
    ...(pivotInput.link_confidence ? [`data-link-confidence="${escape(pivotInput.link_confidence)}"`] : []),
    `data-cross-spine-confidence="${escape(crossSpineConfidence)}"`,
  ].join(" ");
  const body = `<span aria-hidden="true">◆</span>${escape(pivot.target_name || pivot.target_id || "Related record")} <span class="entity-pivot-relation">${escape(pivot.relation_label)}</span>`;
  if (pivot.status !== "accepted" || crossSpineBlocksLink) {
    const reason = crossSpineBlocksLink
      ? crossSpineReaderLabel(crossSpineConfidence)
      : "Provisional: destination not verified";
    const accessibleReason = crossSpineBlocksLink ? `; ${reason}` : "";
    return `<span class="${escape(classes)} entity-pivot-held entity-pivot-cross-spine-${escape(crossSpineConfidence)}" ${attrs} aria-label="${escape(`${accessible}${accessibleReason}`)}">${body}<span class="entity-pivot-provisional">${escape(reason)}</span></span>`;
  }
  return `<a class="${escape(classes)}" href="${escape(pivot.canonical_href)}" ${attrs} aria-label="${escape(accessible)}">${body}</a>`;
}

export function renderEntityPivotRail(records, options = {}) {
  const pivots = normalizeEntityPivots(records);
  if (!pivots.length) return options.empty || "";
  const source = options.source || pivots.find((pivot) => pivot.source?.name)?.source || {};
  const heading = options.heading || "Jump to related";
  const id = options.id || "entity-pivot-heading";
  const items = pivots.map((pivot) => `<li class="entity-pivot-item" data-pivot-status="${escapeHTML(pivot.status)}">${renderEntityPivotLink(pivot, { className: options.className || "", escape: escapeHTML })}</li>`).join("");
  const sourceAffordance = source?.name
    ? (source.canonical_href
      ? `<p class="entity-pivot-source"><a href="${escapeHTML(source.canonical_href)}">Back to ${escapeHTML(source.name)}</a></p>`
      : `<p class="entity-pivot-source">Related from ${escapeHTML(source.name)}</p>`)
    : "";
  return `<section class="entity-pivot-rail ${escapeHTML(options.railClassName || "")}" data-entity-pivot-schema="${ENTITY_PIVOT_SCHEMA}" aria-labelledby="${escapeHTML(id)}"><h2 id="${escapeHTML(id)}">${escapeHTML(heading)}</h2>${sourceAffordance}<ul>${items}</ul></section>`;
}

/** Normalize one materialized relation without inventing missing facts. */
export function normalizeEdgeSummaryRecord(input = {}, defaults = {}) {
  const raw = { ...defaults, ...input };
  const count = normalizedCount(raw.count);
  const state = normalizedState(raw.state || raw.status, count);
  const pivot = normalizeEntityPivot(raw);
  const destination = resolveEdgeSummaryDestination({ ...raw, as_of: raw.as_of });
  return Object.freeze({
    schema: EDGE_SUMMARY_SCHEMA,
    source_kind: text(raw.source_kind),
    source_id: raw.source_id == null ? null : text(raw.source_id, 240),
    edge_type: text(raw.edge_type || raw.relation, 120),
    relation_label: pivot.relation_label,
    label: text(raw.label, 240),
    target_kind: text(raw.target_kind, 80),
    target_id: raw.target_id == null ? null : text(raw.target_id, 240),
    target_name: raw.target_name == null ? null : text(raw.target_name, 240),
    count,
    state,
    href: destination.href,
    canonical_href: destination.href,
    scope: cloneScope(raw.scope),
    as_of: raw.as_of == null ? null : text(raw.as_of, 40),
    source: pivot.source,
    provenance: normalizeEdgeProvenance(raw),
    // Derived graph facts are machine-readable metadata; readers see the
    // plain state copy below, while inspectors may opt into this payload.
    derived_feature_rollup: raw.derived_feature_rollup && typeof raw.derived_feature_rollup === "object"
      ? cloneScope(raw.derived_feature_rollup)
      : null,
    ...crossSpinePivotFields(raw),
  });
}

/** Normalize a producer's inventory while retaining record order. */
export function normalizeEdgeSummaryRecords(records, defaults = {}) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeEdgeSummaryRecord(record, defaults));
}

const EDGE_STATE_RANK = Object.freeze({ matched: 2, empty: 1, unknown: 0 });
const EDGE_CONFIDENCE_RANK = Object.freeze({ confirmed: 2, review: 1, unmatched: 0 });

/**
 * Rank for display only. The stable input index is the final tie-breaker so
 * ranking can never hide a supported family or change equal-signal order.
 */
export function edgeSummarySignalRank(record = {}, { context = null } = {}) {
  const state = normalizedState(record.state || record.status, normalizedCount(record.count));
  const confidence = normalizeCrossSpineConfidence(record.cross_spine_confidence)
    || normalizeCrossSpineConfidence(record.cross_spine)
    || "unmatched";
  const contextValues = typeof context === "string"
    ? [context]
    : context && typeof context === "object"
      ? [context.edge_type, context.target_kind, context.relation_label].filter(Boolean)
      : [];
  const recordText = [record.edge_type, record.target_kind, record.relation_label].filter(Boolean).join(" ").toLowerCase();
  const contextMatch = contextValues.some((value) => recordText.includes(String(value).toLowerCase())) ? 1 : 0;
  return [
    EDGE_STATE_RANK[state] ?? 0,
    contextMatch,
    EDGE_CONFIDENCE_RANK[confidence] ?? 0,
    normalizedCount(record.count) ?? -1,
  ];
}

/** Rank summaries by signal while retaining every input record. */
export function rankEdgeSummaryRecords(records, options = {}) {
  return normalizeEdgeSummaryRecords(records)
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftRank = edgeSummarySignalRank(left.record, options);
      const rightRank = edgeSummarySignalRank(right.record, options);
      for (let index = 0; index < leftRank.length; index += 1) {
        if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
      }
      return left.index - right.index;
    })
    .map(({ record }) => record);
}

export function edgeRelationLabel(recordOrType) {
  const relation = text(typeof recordOrType === "string" ? recordOrType : recordOrType?.edge_type, 120);
  if (typeof recordOrType !== "string") {
    const supplied = text(recordOrType?.relation_label || recordOrType?.label, 240);
    const target = text(recordOrType?.target_name, 240);
    if (supplied && target && supplied.toLocaleLowerCase().startsWith(target.toLocaleLowerCase())) {
      const remainder = supplied.slice(target.length).replace(/^\s*[:\-–—]\s*/, "").trim();
      if (remainder) return readerLabel(remainder, "related records");
    }
    if (supplied) return readerLabel(supplied, "related records");
  }
  if (!relation) return "related records";
  return readerLabel(({
    published_by_agency: "published by this agency",
    covers: "covers this district",
    published_board_source: "published board sources",
    hosts_meeting: "related meetings and hearings",
    issued_rule: "issued rule",
    statute_duty: "statutory mandates",
    certified_to_agency: "certified to the agency",
    votes_on: "voted on",
    top_vendor_by_award_12mo: "top vendors by award value",
    linked_to_vendor: "records linked to this vendor",
    sits_on_parcel: "records connected to this parcel",
    legal_occupancy_on_parcel: "occupancy records for this parcel",
    appeared_on_published_list: "published tax-lien list appearances",
    suitability_record_for_exact_bbl: "suitability records for this parcel",
  })[relation] || relation, "related records");
}

export function edgeSummaryStateCopy(record) {
  if (record.state === "matched") {
    return record.count == null
      ? "Available records"
      : `Available: ${record.count.toLocaleString("en-US")} ${record.count === 1 ? "record" : "records"}`;
  }
  if (record.state === "empty") {
    return ({
      contract: "No contract or award records linked yet",
      vendor: "No vendors linked yet",
      meeting: "No meetings or hearings linked yet",
      meetings: "No meetings or hearings linked yet",
      rule: "No rules linked yet",
      mandate: "Records not shown",
      exam: "No staffing exam records linked yet",
      project: "No land-use records linked yet",
      "tax-lien": "No tax-lien records linked yet",
      suitability: "No suitability records linked yet",
      "certificate-of-occupancy": "No occupancy records linked yet",
    }[record.target_kind] || "No related records linked yet");
  }
  return "Records not shown";
}

function targetCopy(record) {
  return text(record.target_name) || text(record.label) || text(record.target_kind) || "Related records";
}

function provenanceValue(value) {
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  const readable = readerValue(value);
  if (Array.isArray(readable)) {
    return readable
      .map((item) => readerLabel(item, ""))
      .filter((item) => item && !/^(?:nan|[+-]?infinity)(?:\s|$)/i.test(item))
      .join(", ");
  }
  const valueLabel = readerLabel(readable, "") || "";
  return /^(?:nan|[+-]?infinity)(?:\s|$)/i.test(valueLabel) ? "" : valueLabel;
}

function renderAsOfWidget(value) {
  const date = provenanceValue(value);
  if (!date) return "";
  return `<span class="edge-summary-as-of" aria-label="Data as of ${escapeHTML(date)}">as of ${escapeHTML(date)}</span>`;
}

export function renderEdgeSummaryProvenance(record = {}) {
  const provenance = record.provenance || normalizeEdgeProvenance(record);
  const confidence = normalizeCrossSpineConfidence(record.cross_spine_confidence)
    || provenance.cross_spine_confidence
    || "unmatched";
  const publicFields = [["Relation", record.relation_label || record.edge_type]].map(([label, value]) => {
    const rendered = provenanceValue(value);
    return rendered ? `<div class="edge-summary-provenance-row"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(rendered)}</dd></div>` : "";
  }).join("");
  const source = residentOfficialSource({
    sourceSystem: provenance.source_system,
    sourceRecordId: provenance.source_record_id,
    sourceHref: record.source?.canonical_href || provenance.source_href,
    label: record.source?.name || provenance.source_system,
  });
  const sourceLink = source
    ? `<p class="edge-summary-source">${officialSourceLink({ href: source.href, label: source.label, className: "edge-summary-source-link", escape: escapeHTML })}</p>`
    : "";
  const asOf = renderAsOfWidget(provenance.observed_at || record.as_of);
  const confidenceCopy = record.cross_spine_explicit ? crossSpineReaderLabel(confidence) : "";
  return `<details class="edge-summary-provenance edge-summary-provenance-${escapeHTML(confidence)}" data-edge-provenance="1" data-cross-spine-confidence="${escapeHTML(confidence)}"><summary>Connection details</summary>${confidenceCopy ? `<p>${escapeHTML(confidenceCopy)}</p>` : ""}${asOf}${publicFields ? `<dl>${publicFields}</dl>` : ""}${sourceLink}</details>`;
}

function recordLabel(record, targetKind) {
  const relation = record.relation_label || edgeRelationLabel(record);
  return [
    relation,
    edgeSummaryStateCopy(record),
  ].filter(Boolean).join("; ");
}

/**
 * Render a compact, keyboard-native inventory. Every anchor carries the
 * destination, relation, and state in its accessible name; null hrefs remain
 * honest text rather than becoming a fake link.
 */
export function renderEdgeSummaryRail(records, {
  heading = "Connected records",
  id = "edge-summary-heading",
  className = "",
  empty = "",
} = {}) {
  const normalized = rankEdgeSummaryRecords(records);
  if (!normalized.length) return empty;
  const items = normalized.map((record) => {
    const destination = targetCopy(record);
    const relation = record.relation_label || edgeRelationLabel(record);
    const status = edgeSummaryStateCopy(record);
    const targetKind = record.target_kind || "record";
    const label = recordLabel(record, targetKind);
    const metadata = [relation, status].filter(Boolean).join(" · ");
    const availability = EDGE_SUMMARY_STATE_MEANINGS[record.state] || EDGE_SUMMARY_STATE_MEANINGS.unknown;
    const destinationRoute = resolveEdgeSummaryDestination(record);
    const pivot = normalizeEntityPivot({
      ...record,
      relation_label: relation,
      target_name: destination,
      canonical_href: destinationRoute.href,
    });
    const crossSpineBlocksLink = record.cross_spine_explicit && record.cross_spine_confidence !== "confirmed";
    const heldEdge = record.state === "matched" && (pivot.status !== "accepted" || crossSpineBlocksLink);
    const canLink = record.state === "matched" && pivot.status === "accepted" && !crossSpineBlocksLink;
    const asOf = "";
    const confidence = normalizeCrossSpineConfidence(record.cross_spine_confidence) || "unmatched";
    const confidenceBadge = record.cross_spine_explicit
      ? `<span class="edge-summary-confidence edge-summary-confidence-${escapeHTML(confidence)}" data-cross-spine-confidence="${escapeHTML(confidence)}">${escapeHTML(crossSpineReaderLabel(confidence))}</span>`
      : "";
    const heldReason = heldEdge ? " · Destination not verified" : "";
    const content = canLink
      ? `<a class="edge-summary-link" href="${escapeHTML(pivot.canonical_href)}" aria-label="${escapeHTML(label)}" data-pivot-schema="${ENTITY_PIVOT_SCHEMA}" data-pivot-status="accepted" data-pivot-relation-label="${escapeHTML(relation)}" data-pivot-target-kind="${escapeHTML(targetKind)}" data-pivot-target-id="${escapeHTML(record.target_id || "")}" data-pivot-source-kind="${escapeHTML(record.source?.kind || record.source_kind || "")}" data-pivot-source-id="${escapeHTML(record.source?.id || record.source_id || "")}" data-cross-spine-confidence="${escapeHTML(record.cross_spine_confidence)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}${heldReason}</span></a>`
      : `<span class="edge-summary-text${heldEdge ? " entity-pivot-held" : ""}" aria-label="${escapeHTML(label)}" data-pivot-schema="${ENTITY_PIVOT_SCHEMA}" data-pivot-status="${heldEdge ? "held" : escapeHTML(record.state)}" data-cross-spine-confidence="${escapeHTML(record.cross_spine_confidence)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}${heldReason}</span></span>`;
    return `<li class="edge-summary-item" data-edge-state="${escapeHTML(record.state)}" data-edge-availability="${escapeHTML(availability)}" data-edge-type="${escapeHTML(record.edge_type)}" data-target-kind="${escapeHTML(targetKind)}" data-cross-spine-confidence="${escapeHTML(record.cross_spine_confidence || "unmatched")}"${record.count == null ? "" : ` data-edge-count="${record.count}"`}>${content}${confidenceBadge}${asOf}</li>`;
  }).join("");
  const source = normalized.find((record) => record.source?.name)?.source;
  const sourceAffordance = source?.name
    ? (source.canonical_href
      ? `<p class="entity-pivot-source"><a href="${escapeHTML(source.canonical_href)}">Back to ${escapeHTML(source.name)}</a></p>`
      : `<p class="entity-pivot-source">Related from ${escapeHTML(source.name)}</p>`)
    : "";
  const asOfDates = [...new Set(normalized.map((record) => provenanceValue(record.as_of)).filter(Boolean))];
  const asOf = asOfDates.map(renderAsOfWidget).join("");
  return `<section class="edge-summary-rail ${escapeHTML(className)}" data-edge-summary-schema="${EDGE_SUMMARY_SCHEMA}" data-entity-pivot-schema="${ENTITY_PIVOT_SCHEMA}" aria-labelledby="${escapeHTML(id)}"><h2 id="${escapeHTML(id)}">${escapeHTML(heading)}${asOf ? `<span class="edge-summary-freshness"> · ${asOf}</span>` : ""}</h2>${sourceAffordance}<ul>${items}</ul></section>`;
}

export function edgeSummaryState(status, count) {
  return normalizedState(status, normalizedCount(count));
}
