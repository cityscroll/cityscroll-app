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
  /^\/(?:notices|agencies|vendors|officials)\/[A-Za-z0-9_%~-]+\/?(?:\?.*)?$/,
  /^\/browse\/(?:contracts|staffing|zoning|property|rules|meetings)\/?(?:\?.*)?$/,
  /^\/browse\/?(?:\?.*)?$/,
  /^\/parcels\/\d{10}\/?(?:\?.*)?$/,
  /^\/exams\/\d{4}\/?(?:\?.*)?$/,
  /^\/(?:near-you|following)(?:\/[^?#]*)?\/?(?:\?.*)?$/,
  /^#parcel-biography-(?:property|land|tax_lien|ll48|cofo)$/,
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

/** Normalize a relation on the le-01 edge-summary narrow waist. */
export function normalizeEntityPivot(input = {}, defaults = {}) {
  const raw = { ...defaults, ...input };
  const targetName = raw.target_name ?? raw.target_label ?? raw.name;
  const targetId = raw.target_id ?? raw.id;
  const relation = raw.relation_label
    || (raw.label ? edgeRelationLabel({ edge_type: raw.edge_type || raw.relation, label: raw.label, target_name: targetName }) : null)
    || edgeRelationLabel(raw.edge_type || raw.relation);
  const route = entityPivotRouteStatus(raw.canonical_href ?? raw.href);
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
    const route = record?.canonical_href ?? record?.href;
    const status = entityPivotRouteStatus(route);
    return route && !status.verified ? [{ index, href: String(route), reason: status.reason }] : [];
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
  ].join(" ");
  const body = `<span aria-hidden="true">◆</span>${escape(pivot.target_name || pivot.target_id || "Related record")} <span class="entity-pivot-relation">${escape(pivot.relation_label)}</span>`;
  if (pivot.status !== "accepted") {
    return `<span class="${escape(classes)} entity-pivot-held" ${attrs} aria-label="${escape(accessible)}">${body}<span class="entity-pivot-provisional">Provisional: destination not verified</span></span>`;
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
    href: canonicalHref(raw.href, raw.as_of),
    canonical_href: canonicalHref(raw.canonical_href ?? raw.href, raw.as_of),
    scope: cloneScope(raw.scope),
    as_of: raw.as_of == null ? null : text(raw.as_of, 40),
    source: pivot.source,
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

function recordLabel(record) {
  const target = targetCopy(record);
  const relation = record.relation_label || edgeRelationLabel(record);
  return `${target}: ${relation}; ${edgeSummaryStateCopy(record)}`;
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
    const label = recordLabel(record);
    const targetKind = record.target_kind || "record";
    const metadata = [
      relation,
      targetKind,
      status,
      record.as_of ? `as of ${record.as_of}` : null,
    ].filter(Boolean).join(" · ");
    const availability = EDGE_SUMMARY_STATE_MEANINGS[record.state] || EDGE_SUMMARY_STATE_MEANINGS.unknown;
    const pivot = normalizeEntityPivot({
      ...record,
      relation_label: relation,
      target_name: destination,
      canonical_href: record.href,
    });
    const heldEdge = record.state === "matched" && pivot.status !== "accepted";
    const content = pivot.status === "accepted"
      ? `<a class="edge-summary-link" href="${escapeHTML(record.href)}" aria-label="${escapeHTML(label)}" data-pivot-schema="${ENTITY_PIVOT_SCHEMA}" data-pivot-status="accepted" data-pivot-relation-label="${escapeHTML(relation)}" data-pivot-target-kind="${escapeHTML(targetKind)}" data-pivot-target-id="${escapeHTML(record.target_id || "")}" data-pivot-source-kind="${escapeHTML(record.source?.kind || record.source_kind || "")}" data-pivot-source-id="${escapeHTML(record.source?.id || record.source_id || "")}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}</span></a>`
      : `<span class="edge-summary-text${heldEdge ? " entity-pivot-held" : ""}" aria-label="${escapeHTML(label)}" data-pivot-schema="${ENTITY_PIVOT_SCHEMA}" data-pivot-status="${heldEdge ? "held" : escapeHTML(record.state)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}${heldEdge ? " · Provisional: destination not verified" : ""}</span></span>`;
    return `<li class="edge-summary-item" data-edge-state="${escapeHTML(record.state)}" data-edge-availability="${escapeHTML(availability)}" data-edge-type="${escapeHTML(record.edge_type)}" data-target-kind="${escapeHTML(targetKind)}"${record.count == null ? "" : ` data-edge-count="${record.count}"`}>${content}</li>`;
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
