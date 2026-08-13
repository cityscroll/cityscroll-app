/**
 * Bounded local constellation for a civic object.
 *
 * This is a presentation adapter, not a graph store. Producers pass the
 * edges and destinations they have already materialized; this module keeps a
 * small, keyboard-readable neighborhood beside a compact visual projection.
 */

import {
  edgeSummaryStateCopy,
  normalizeEdgeSummaryRecords,
  renderEdgeSummaryProvenance,
  resolveEdgeSummaryDestination,
} from "./edge_summary.mjs";

export const LOCAL_CONSTELLATION_SCHEMA = "cityscroll.local_constellation.v1";
export const LOCAL_CONSTELLATION_MAX_NODES = 8;

const KINDS = Object.freeze([
  "official",
  "committee",
  "vendor",
  "agency",
  "place",
  "record",
]);

const REGISTRY = Object.freeze({
  official: Object.freeze({
    label: "Official connections",
    relation_families: Object.freeze(["votes_on", "committee_membership", "member_of"]),
  }),
  committee: Object.freeze({
    label: "Committee connections",
    relation_families: Object.freeze(["member_of", "committee_membership"]),
  }),
  vendor: Object.freeze({
    label: "Vendor connections",
    relation_families: Object.freeze(["linked_to_vendor", "award_for_vendor", "contract_for_vendor", "paid_to_vendor", "named_franchisee"]),
  }),
  agency: Object.freeze({
    label: "Agency connections",
    relation_families: Object.freeze(["published_by_agency", "top_vendor_by_award_12mo", "hosts_meeting", "issued_rule", "statute_duty", "certified_to_agency"]),
  }),
  place: Object.freeze({
    label: "Place connections",
    relation_families: Object.freeze(["covers", "intersects", "nearby_record", "located_in"]),
  }),
  record: Object.freeze({
    label: "Record connections",
    relation_families: Object.freeze(["published_by_agency", "named_vendor", "related_land_use_project", "mandate_backlink", "related_record"]),
  }),
});

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function clone(value) {
  if (value == null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function canonicalKind(value) {
  const kind = clean(value, 40).toLowerCase();
  return kind === "notice" ? "record" : kind;
}

function sourceValue(input) {
  // Deliberately distinguish an explicit null receipt from a missing field.
  return Object.prototype.hasOwnProperty.call(input, "source") ? clone(input.source) : null;
}

function relationAllowed(kind, record) {
  const relation = clean(record?.edge_type || record?.relation || record?.relation_label, 120);
  if (!relation) return false;
  return REGISTRY[kind]?.relation_families.includes(relation) || relation === "related_record";
}

function nodeKey(record) {
  return clean(record?.target_id || record?.target_ref || record?.subject_ref || record?.target_name || record?.label, 320)
    || clean(record?.href, 800);
}

function normalizeNeighbor(record, defaults) {
  const normalized = normalizeEdgeSummaryRecords([record], defaults)[0];
  const rawState = clean(record?.node_state || record?.pivot_state || record?.state, 30).toLowerCase();
  const destination = resolveEdgeSummaryDestination(record);
  const state = rawState === "held" || normalized.state === "unknown" || !destination.verified
    ? "held"
    : "accepted";
  return Object.freeze({
    ...normalized,
    state,
    relation_family: normalized.edge_type,
    href: state === "accepted" ? destination.href : null,
    hold_reason: state === "held"
      ? (clean(record?.hold_reason, 180) || (normalized.state === "unknown" ? "This destination is not in the published route set." : destination.reason))
      : null,
    node_id: nodeKey(record) || null,
    node_name: normalized.target_name || normalized.label || normalized.target_kind || "Related record",
  });
}

export function localConstellationRegistry(kind = null) {
  if (kind == null) return REGISTRY;
  return REGISTRY[canonicalKind(kind)] || null;
}

/**
 * Build a local neighborhood from already-materialized edge records.
 * Empty and unknown edge-summary rows are coverage facts, not neighbors, so
 * they do not become visual nodes; the neighborhood still carries that
 * availability state. A held destination remains visible as text.
 */
export function buildLocalConstellation(input = {}, { limit = LOCAL_CONSTELLATION_MAX_NODES } = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const kind = canonicalKind(raw.kind || raw.object_kind);
  if (!KINDS.includes(kind)) return null;
  const registry = REGISTRY[kind];
  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, LOCAL_CONSTELLATION_MAX_NODES)
    : LOCAL_CONSTELLATION_MAX_NODES;
  const rawNeighbors = Array.isArray(raw.neighbors)
    ? raw.neighbors
    : Array.isArray(raw.edges) ? raw.edges : [];
  const seen = new Set();
  const candidates = rawNeighbors
    .filter((record) => relationAllowed(kind, record))
    .filter((record) => !["empty", "unknown"].includes(clean(record?.state || record?.status, 30).toLowerCase()))
    .map((record) => normalizeNeighbor(record, {
      source_kind: kind,
      source_id: raw.subject_id ?? raw.subject_ref ?? null,
      source_name: raw.subject_name ?? raw.name ?? null,
      source: sourceValue(raw),
    }))
    .filter((record) => {
      if (!record.node_id || seen.has(record.node_id)) return false;
      seen.add(record.node_id);
      return record.state === "accepted" || record.state === "held";
    });
  const nodes = candidates.slice(0, boundedLimit);
  const requestedState = clean(raw.availability_state || raw.state, 30).toLowerCase();
  const availabilityState = ["matched", "empty", "unknown"].includes(requestedState)
    ? requestedState
    : (nodes.length ? "matched" : "empty");
  return Object.freeze({
    schema: LOCAL_CONSTELLATION_SCHEMA,
    version: 1,
    kind,
    object_kind: kind,
    subject_ref: raw.subject_ref ?? null,
    subject_id: raw.subject_id ?? null,
    subject_name: raw.subject_name ?? raw.name ?? null,
    source: sourceValue(raw),
    provenance: Object.prototype.hasOwnProperty.call(raw, "provenance") ? clone(raw.provenance) : null,
    status: nodes.length ? "matched" : availabilityState,
    availability_state: availabilityState,
    bounded: true,
    limit: boundedLimit,
    node_count: nodes.length,
    omitted_count: Math.max(0, candidates.length - nodes.length),
    relation_families: registry.relation_families,
    label: registry.label,
    nodes,
  });
}

export function buildOfficialLocalConstellation(officialView, committeeRows, id, name) {
  return buildLocalConstellation({
    kind: "official",
    subject_ref: officialView?.official?.ref || `entity:official:${id}`,
    subject_id: id,
    subject_name: name,
    source: null,
    provenance: { method: "official_connections_v1" },
    neighbors: [
      ...(officialView?.events || []).map((event) => ({
        edge_type: "votes_on",
        relation_label: "votes_on",
        target_kind: "meeting",
        target_id: event.notice_id || event.event_id || null,
        target_name: event.notice_id || event.event_id || null,
        href: event.notice_id ? `#notice/${encodeURIComponent(event.notice_id)}` : null,
        state: event.notice_id ? "matched" : "unknown",
        provenance: null,
      })),
      ...(Array.isArray(committeeRows) ? committeeRows : []).map((row) => ({
        edge_type: "committee_membership",
        relation_label: "committee membership",
        target_kind: "committee",
        target_id: row.committee_id || row.id || null,
        target_name: row.committee || null,
        href: "/browse/people/#committees",
        state: row.committee_id ? "matched" : "unknown",
        provenance: row.provenance || null,
      })),
    ],
  });
}

function nodeMarkup(node) {
  const relation = node.relation_label || node.edge_type || "related record";
  const destination = node.href
    ? `<a class="local-constellation-node-link" href="${esc(node.href)}" data-pivot-schema="cityscroll.edge_summary.v1" data-pivot-status="accepted" data-pivot-relation-label="${esc(relation)}" data-pivot-target-kind="${esc(node.target_kind || "record")}" data-pivot-target-id="${esc(node.target_id || "")}">${esc(node.node_name)}</a>`
    : `<span class="local-constellation-node-held" data-pivot-status="held" aria-label="${esc(`${node.node_name}; ${node.hold_reason || "destination held"}`)}">${esc(node.node_name)} <span class="local-constellation-held-label">Held</span></span>`;
  return `<li class="local-constellation-list-item" data-local-node-state="${esc(node.state)}" data-edge-type="${esc(node.edge_type || "")}">
    <div class="local-constellation-node-main"><span class="local-constellation-node-dot" aria-hidden="true">◆</span>${destination}</div>
    <span class="local-constellation-relation">${esc(relation)}</span>
    ${node.href ? renderEdgeSummaryProvenance(node) : ""}
  </li>`;
}

function mapMarkup(view, headingId) {
  if (!view.nodes.length) return `<div class="local-constellation-map local-constellation-map-empty" aria-hidden="true"><span>○</span></div>`;
  const width = 360;
  const height = 190;
  const cx = 180;
  const cy = 95;
  const radius = 70;
  const points = view.nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index / view.nodes.length) - Math.PI / 2;
    return { node, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
  const lines = points.map(({ x, y }) => `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" />`).join("");
  const dots = points.map(({ node, x, y }) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="7" data-node-state="${esc(node.state)}"><title>${esc(`${node.node_name}: ${node.relation_label || node.edge_type || "related record"}`)}</title></circle>`).join("");
  const descId = `${headingId}-map-desc`;
  return `<svg class="local-constellation-map" role="img" aria-labelledby="${esc(headingId)} ${esc(descId)}" viewBox="0 0 ${width} ${height}">
    <desc id="${esc(descId)}">A bounded view of ${esc(view.nodes.length)} connected records. Use the equivalent list for links.</desc>
    <g class="local-constellation-lines" aria-hidden="true">${lines}</g>
    <circle class="local-constellation-center" cx="${cx}" cy="${cy}" r="18"><title>${esc(view.subject_name || "Current record")}</title></circle>
    <g class="local-constellation-dots" aria-hidden="true">${dots}</g>
  </svg>`;
}

export function ensureLocalConstellationStylesheet() {
  if (typeof document === "undefined" || document.querySelector("link[data-local-constellation-styles]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("/local_constellation.css", document.baseURI).href;
  link.dataset.localConstellationStyles = "1";
  document.head.appendChild(link);
}

export function renderLocalConstellationHTML(view, {
  heading = null,
  id = "local-constellation-heading",
  className = "",
} = {}) {
  if (!view || view.schema !== LOCAL_CONSTELLATION_SCHEMA) return "";
  const title = heading || view.label || "Local connections";
  const countText = view.status === "matched"
    ? `${view.nodes.length} connected ${view.nodes.length === 1 ? "record" : "records"}.`
    : edgeSummaryStateCopy({ state: view.status, count: view.status === "empty" ? 0 : null });
  const list = view.nodes.length
    ? `<ol class="local-constellation-list" aria-label="Equivalent list of connected records">${view.nodes.map(nodeMarkup).join("")}</ol>`
    : `<p class="local-constellation-empty" data-local-constellation-empty="true" data-edge-state="${esc(view.status)}">${esc(countText)}</p>`;
  const availability = view.availability_state || view.status;
  return `<section class="local-constellation ${esc(className)}" data-local-constellation="1" data-local-constellation-kind="${esc(view.kind)}" data-local-constellation-status="${esc(view.status)}" data-edge-state="${esc(availability)}" data-local-constellation-count="${view.node_count}" aria-labelledby="${esc(id)}">
    <div class="local-constellation-heading"><div><p class="local-constellation-kicker">Local connections</p><h2 id="${esc(id)}">${esc(title)}</h2><p class="local-constellation-summary">${esc(countText)} The map is limited to published neighbors.</p></div></div>
    <div class="local-constellation-body">${mapMarkup(view, id)}<div class="local-constellation-list-wrap">${list}</div></div>
  </section>`;
}

export const LOCAL_CONSTELLATION_KINDS = KINDS;
