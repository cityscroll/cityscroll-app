/**
 * Shared typed edge-summary contract.
 *
 * This is a presentation narrow waist, not a graph store. Producers provide
 * the already-materialized count and the already-scoped destination; this
 * module preserves those facts and gives every surface the same readable rail.
 */

export const EDGE_SUMMARY_SCHEMA = "cityscroll.edge_summary.v1";
export const EDGE_SUMMARY_STATES = Object.freeze(["matched", "empty", "unknown"]);

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

/** Normalize one materialized relation without inventing missing facts. */
export function normalizeEdgeSummaryRecord(input = {}, defaults = {}) {
  const raw = { ...defaults, ...input };
  const count = normalizedCount(raw.count);
  const state = normalizedState(raw.state || raw.status, count);
  return Object.freeze({
    schema: EDGE_SUMMARY_SCHEMA,
    source_kind: text(raw.source_kind),
    source_id: raw.source_id == null ? null : text(raw.source_id, 240),
    edge_type: text(raw.edge_type || raw.relation, 120),
    label: text(raw.label, 240),
    target_kind: text(raw.target_kind, 80),
    target_name: raw.target_name == null ? null : text(raw.target_name, 240),
    count,
    state,
    href: canonicalHref(raw.href, raw.as_of),
    scope: cloneScope(raw.scope),
    as_of: raw.as_of == null ? null : text(raw.as_of, 40),
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
  })[relation] || relation.replaceAll("_", " ");
}

function stateCopy(record) {
  if (record.state === "matched") {
    return record.count == null ? "Count unavailable" : `${record.count.toLocaleString("en-US")} ${record.count === 1 ? "record" : "records"}`;
  }
  if (record.state === "empty") return "None in this materialization";
  return "Not measured";
}

function targetCopy(record) {
  return text(record.target_name) || text(record.label) || text(record.target_kind) || "Related records";
}

function recordLabel(record) {
  const target = targetCopy(record);
  const relation = edgeRelationLabel(record);
  return `${target}: ${relation}; ${stateCopy(record)}`;
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
    const relation = edgeRelationLabel(record);
    const status = stateCopy(record);
    const label = recordLabel(record);
    const targetKind = record.target_kind || "record";
    const metadata = [
      relation,
      targetKind,
      status,
      record.as_of ? `as of ${record.as_of}` : null,
    ].filter(Boolean).join(" · ");
    const content = record.href
      ? `<a class="edge-summary-link" href="${escapeHTML(record.href)}" aria-label="${escapeHTML(label)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}</span></a>`
      : `<span class="edge-summary-text" aria-label="${escapeHTML(label)}"><span class="edge-summary-target">${escapeHTML(destination)}</span><span class="edge-summary-detail">${escapeHTML(metadata)}</span></span>`;
    return `<li class="edge-summary-item" data-edge-state="${escapeHTML(record.state)}" data-edge-type="${escapeHTML(record.edge_type)}" data-target-kind="${escapeHTML(targetKind)}"${record.count == null ? "" : ` data-edge-count="${record.count}"`}>${content}</li>`;
  }).join("");
  return `<section class="edge-summary-rail ${escapeHTML(className)}" data-edge-summary-schema="${EDGE_SUMMARY_SCHEMA}" aria-labelledby="${escapeHTML(id)}"><h2 id="${escapeHTML(id)}">${escapeHTML(heading)}</h2><ul>${items}</ul></section>`;
}

export function edgeSummaryState(status, count) {
  return normalizedState(status, normalizedCount(count));
}
