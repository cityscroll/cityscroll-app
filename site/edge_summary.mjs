import { normalizeCrossSpineConfidence } from "./cross_spine_confidence.mjs";

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
  unknown: "unknown-unindexed",
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
  if (count == null) return "unknown";
  return count === 0 ? "empty" : "matched";
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
  /^\/browse\/(?:contracts|staffing|zoning|property|rules|meetings|people|places)\/?(?:\?.*)?(?:#.*)?$/,
  /^\/browse\/?(?:\?.*)?$/,
  /^\/parcels\/\d{10}\/?(?:\?.*)?$/,
  /^\/exams\/\d{4}\/?(?:\?.*)?$/,
  /^\/(?:near-you|following)(?:\/[^?#]*)?\/?(?:\?.*)?$/,
  /^\/community-boards\/?(?:\?.*)?(?:#.*)?$/,
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
  const source = input.source && typeof input.source === "object" ? input.source : {};
  const kind = text(source.kind || input.source_kind, 80);
  const id = source.id ?? input.source_id;
  const name = source.name ?? input.source_name;
  const href = source.canonical_href ?? source.href ?? input.source_href;
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
  return Object.freeze({
    source_system: provenance.source_system ?? null,
    source_record_id: provenance.source_record_id ?? null,
    source_fields: Array.isArray(provenance.source_fields) ? [...provenance.source_fields] : null,
    join_method: provenance.join_method ?? provenance.basis ?? input.join_method ?? null,
    observed_at: provenance.observed_at ?? input.as_of ?? null,
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
  const relation = raw.relation_label
    || (raw.label ? edgeRelationLabel({ edge_type: raw.edge_type || raw.relation, label: raw.label, target_name: targetName }) : null)
    || edgeRelationLabel(raw.edge_type || raw.relation);
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
  const sourceName = pivot.source.name || pivot.source.kind || "this record";
  const accessible = `${pivot.relation_label}: ${targetDisplay(pivot)}; from ${sourceName}`;
  const classes = ["ui-constellation-link", className].filter(Boolean).join(" ");
  const attrs = [
    `data-pivot-schema="${escape(ENTITY_PIVOT_SCHEMA)}"`,
    `data-pivot-status="${escape(pivot.status)}"`,
    `data-pivot-relation-label="${escape(pivot.relation_label)}"`,
    `data-pivot-target-kind="${escape(pivot.target_kind || "")}"`,
    `data-pivot-target-id="${escape(pivot.target_id || "")}"`,
    ...(pivot.source.kind || pivot.source.id || pivot.source.name
      ? [
        `data-pivot-source-kind="${escape(pivot.source.kind || "")}"`,
        `data-pivot-source-id="${escape(pivot.source.id || "")}"`,
      ]
      : []),
    ...(pivotInput.link_confidence ? [`data-link-confidence="${escape(pivotInput.link_confidence)}"`] : []),
    `data-cross-spine-confidence="${escape(crossSpineConfidence)}"`,
  ].join(" ");
  const body = `<span aria-hidden="true">◆</span>${escape(pivot.target_name || pivot.target_id || "Related record")} <span class="entity-pivot-relation">${escape(pivot.relation_label)}</span>`;
  if (pivot.status !== "accepted" || crossSpineBlocksLink) {
    const reason = crossSpineBlocksLink
      ? `Cross-spine: ${crossSpineConfidence}`
      : "Provisional: destination not verified";
    return `<span class="${escape(classes)} entity-pivot-held entity-pivot-cross-spine-${escape(crossSpineConfidence)}" ${attrs} aria-label="${escape(`${accessible}; cross-spine confidence: ${crossSpineConfidence}`)}">${body}<span class="entity-pivot-provisional">${escape(reason)}</span></span>`;
  }
  return `<a class="${escape(classes)}" href="${escape(pivot.canonical_href)}" ${attrs} aria-label="${escape(accessible)}">${body}</a>`;
}

export function renderEntityPivotRail(records, options = {}) {
  const pivots = normalizeEntityPivots(records);
  if (!pivots.length) return options.empty || "";
  const source = options.source || pivots.find((pivot) => pivot.source.name)?.source || {};
  const heading = options.heading || "Jump to related";
  const id = options.id || "entity-pivot-heading";
  const items = pivots.map((pivot) => `<li class="entity-pivot-item" data-pivot-status="${escapeHTML(pivot.status)}">${renderEntityPivotLink(pivot, { className: options.className || "", escape: escapeHTML })}</li>`).join("");
  const sourceAffordance = source.name
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
    ...crossSpinePivotFields(raw),
  });
}

/** Normalize a producer's inventory while retaining record order. */
export function normalizeEdgeSummaryRecords(records, defaults = {}) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeEdgeSummaryRecord(record, defaults));
}

export function edgeRelationLabel(recordOrType) {
  const relation = text(typeof recordOrType === "string" ? recordOrType : recordOrType?.edge_type, 120);
  if (typeof recordOrType !== "string") {
    const supplied = text(recordOrType?.label, 240);
    const target = text(recordOrType?.target_name, 240);
    if (supplied && target && supplied.toLocaleLowerCase().startsWith(target.toLocaleLowerCase())) {
      const remainder = supplied.slice(target.length).replace(/^\s*[:\-–—]\s*/, "").trim();
      if (remainder) return remainder;
    }
  }
  if (!relation) return "related records";
  return ({
    published_by_agency: "published by this agency",
    hosts_meeting: "related meetings and hearings",
    issued_rule: "issued rules",
    statute_duty: "statutory mandates",
    certified_to_agency: "staffing exams certified to this agency",
    top_vendor_by_award_12mo: "top vendors by award value",
    linked_to_vendor: "records linked to this vendor",
    sits_on_parcel: "records connected to this parcel",
    legal_occupancy_on_parcel: "occupancy records for this parcel",
    appeared_on_published_list: "published tax-lien list appearances",
    suitability_record_for_exact_bbl: "suitability records for this parcel",
  })[relation] || relation.replaceAll("_", " ");
}

export function edgeSummaryStateCopy(record) {
  if (record.state === "matched") {
    return record.count == null
      ? "Available: count unavailable"
      : `Available: ${record.count.toLocaleString("en-US")} ${record.count === 1 ? "record" : "records"}`;
  }
  if (record.state === "empty") return "Empty in this scoped materialization";
  return "Unknown / not indexed";
}

function targetCopy(record) {
  return text(record.target_name) || text(record.label) || text(record.target_kind) || "Related records";
}

function scopeCopy(scope) {
  if (!scope || typeof scope !== "object") return "scope: not specified";
  const entries = Object.entries(scope)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => {
      const readableKey = key.replaceAll("_", " ");
      const readableValue = (Array.isArray(value) ? value : [value])
        .map((item) => String(item).replaceAll("_", " "))
        .join(", ");
      return `${readableKey}: ${readableValue}`;
    });
  return entries.length ? `scope: ${entries.join(", ")}` : "scope: not specified";
}

function provenanceValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Unavailable";
  return value == null || value === "" ? "Unavailable" : String(value);
}

export function renderEdgeSummaryProvenance(record = {}) {
  const provenance = record.provenance || normalizeEdgeProvenance(record);
  const confidence = normalizeCrossSpineConfidence(record.cross_spine_confidence)
    || provenance.cross_spine_confidence
    || "unmatched";
  const fields = [
    ["Relation", record.relation_label || record.edge_type],
    ["Source", provenance.source_system],
    ["Source record", provenance.source_record_id],
    ["Source fields", provenance.source_fields],
    ["Join method", provenance.join_method],
    ["Observed / as of", provenance.observed_at || record.as_of],
  ].map(([label, value]) => `<div class="edge-summary-provenance-row"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(provenanceValue(value))}</dd></div>`).join("");
  return `<details class="edge-summary-provenance edge-summary-provenance-${escapeHTML(confidence)}" data-edge-provenance="1" data-cross-spine-confidence="${escapeHTML(confidence)}"><summary>Why this connection? <span class="edge-summary-confidence">${escapeHTML(confidence)}</span></summary><dl>${fields}</dl><p class="edge-summary-provenance-boundary">This check compares claims. It does not choose a winner or merge identities.</p></details>`;
}

function recordLabel(record, targetKind) {
  const relation = record.relation_label || edgeRelationLabel(record);
  return [
    relation,
    `target kind: ${targetKind}`,
    `count: ${edgeSummaryStateCopy(record)}`,
    scopeCopy(record.scope),
    `as of: ${record.as_of || "unavailable"}`,
  ].join("; ");
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
  const normalized = normalizeEdgeSummaryRecords(records);
  if (!normalized.length) return empty;
  const items = normalized.map((record) => {
    const destination = targetCopy(record);
    const relation = record.relation_label || edgeRelationLabel(record);
    const status = edgeSummaryStateCopy(record);
    const targetKind = record.target_kind || "record";
    const label = recordLabel(record, targetKind);
    const metadata = [
      relation,
      targetKind,
      status,
      scopeCopy(record.scope),
      record.as_of ? `as of ${record.as_of}` : null,
    ].filter(Boolean).join(" · ");
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
    const heldReason = crossSpineBlocksLink
      ? ` · Cross-spine: ${record.cross_spine_confidence}`
      : (heldEdge ? " · Provisional: destination not verified" : "");
    const content = canLink
      ? `<a class="edge-summary-link" href="${escapeHTML(pivot.canonical_href)}" aria-label="${escapeHTML(label)}" data-pivot-schema="${ENTITY_PIVOT_SCHEMA}" data-pivot-status="accepted" data-pivot-relation-label="${escapeHTML(relation)}" data-pivot-target-kind="${escapeHTML(targetKind)}" data-pivot-target-id="${escapeHTML(record.target_id || "")}" data-pivot-source-kind="${escapeHTML(record.source?.kind || record.source_kind || "")}" data-pivot-source-id="${escapeHTML(record.source?.id || record.source_id || "")}" data-cross-spine-confidence="${escapeHTML(record.cross_spine_confidence)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}</span></a>`
      : `<span class="edge-summary-text${heldEdge ? " entity-pivot-held" : ""}" aria-label="${escapeHTML(label)}" data-pivot-schema="${ENTITY_PIVOT_SCHEMA}" data-pivot-status="${heldEdge ? "held" : escapeHTML(record.state)}" data-cross-spine-confidence="${escapeHTML(record.cross_spine_confidence)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}${heldReason}</span></span>`;
    return `<li class="edge-summary-item" data-edge-state="${escapeHTML(record.state)}" data-edge-availability="${escapeHTML(availability)}" data-edge-type="${escapeHTML(record.edge_type)}" data-target-kind="${escapeHTML(targetKind)}" data-cross-spine-confidence="${escapeHTML(record.cross_spine_confidence || "unmatched")}"${record.count == null ? "" : ` data-edge-count="${record.count}"`}>${content}${renderEdgeSummaryProvenance(record)}</li>`;
  }).join("");
  const source = normalized.find((record) => record.source?.name)?.source;
  const sourceAffordance = source?.name
    ? (source.canonical_href
      ? `<p class="entity-pivot-source"><a href="${escapeHTML(source.canonical_href)}">Back to ${escapeHTML(source.name)}</a></p>`
      : `<p class="entity-pivot-source">Related from ${escapeHTML(source.name)}</p>`)
    : "";
  return `<section class="edge-summary-rail ${escapeHTML(className)}" data-edge-summary-schema="${EDGE_SUMMARY_SCHEMA}" data-entity-pivot-schema="${ENTITY_PIVOT_SCHEMA}" aria-labelledby="${escapeHTML(id)}"><h2 id="${escapeHTML(id)}">${escapeHTML(heading)}</h2><p class="edge-summary-scope-note">This summary is limited to the relation families shown; other entity families are outside this materialization.</p>${sourceAffordance}<ul>${items}</ul></section>`;
}

export function edgeSummaryState(status, count) {
  return normalizedState(status, normalizedCount(count));
}
