/**
 * Temporal provision history and law-at-time-T lookup.
 *
 * Validity is an interval query over immutable CodeVersions. Observation time
 * never fills a missing legal effective date, and current publisher text is
 * never substituted for a requested historical date.
 */

import {
  indexLegalChanges,
  redesignationCopy,
} from "./legal_change_edges.mjs";

export const PROVISION_AS_OF_SCHEMA = "cityscroll.provision_as_of.v1";
export const PROVISION_HISTORY_SCHEMA = "cityscroll.provision_history.v1";
export const PROVISION_HISTORY_INDEX_SCHEMA = "cityscroll.provision_history_index.v1";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function validAsOfDate(value) {
  const match = clean(value, 40).match(ISO_DATE);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0]) return null;
  return match[0];
}

function sortVersions(versions) {
  return [...versions].sort((left, right) => String(left.valid_from || left.valid_to || "").localeCompare(String(right.valid_from || right.valid_to || "")));
}

function versionCoversKnownValidity(version, asOf) {
  const from = validAsOfDate(version?.valid_from);
  const to = validAsOfDate(version?.valid_to);
  if (!from && !to) return false;
  if (from && from > asOf) return false;
  if (to && to <= asOf) return false;
  return true;
}

function historyEntry(change, graph, provisionId) {
  const lawId = change.legal_instrument_id || graph?.local_law?.id || null;
  const successor = change.redesignation?.successor_provision_id === provisionId;
  return freeze({
    change_id: change.id,
    operation: change.operation,
    state: change.state,
    legal_instrument_id: lawId,
    matter_id: change.matter_id || graph?.matter?.id || graph?.local_law?.matter_id || null,
    provision_id: change.target?.provision_id || null,
    citation: change.target?.citation || null,
    source_ref: change.source?.source_ref || null,
    source_url: change.source?.url || null,
    instruction_text: change.source?.instruction_text || null,
    effective_at: change.effective_at || change.materialization?.effective_at || null,
    materialization_status: change.materialization_status || "unresolved",
    redesignation: change.redesignation || null,
    redesignation_label: redesignationCopy(change, successor ? "successor" : "former"),
  });
}

export function getProvisionAsOf({
  provision_id: provisionId = null,
  provision = null,
  versions = [],
  changes = [],
  as_of: asOfInput = null,
} = {}) {
  const id = provisionId || provision?.id || null;
  const asOf = validAsOfDate(asOfInput);
  const relatedChanges = (Array.isArray(changes) ? changes : []).filter((change) => (
    change?.target?.provision_id === id
    || change?.redesignation?.successor_provision_id === id
  ));
  if (!asOf) {
    return freeze({
      schema: PROVISION_AS_OF_SCHEMA,
      provision_id: id,
      as_of: asOfInput ? clean(asOfInput, 40) : null,
      status: "unknown",
      text: null,
      version: null,
      reason: "as-of date is missing or invalid",
      used_publisher_current_text: false,
      source_ref: null,
      content_hash: null,
      redesignation_label: null,
      changes: relatedChanges,
    });
  }
  const covering = sortVersions(
    (Array.isArray(versions) ? versions : []).filter((version) => (
      version?.provision_id === id && versionCoversKnownValidity(version, asOf)
    )),
  );
  const version = covering.at(-1) || null;
  if (!version) {
    const redesignation = relatedChanges.find((change) => change.operation === "redesignate") || null;
    return freeze({
      schema: PROVISION_AS_OF_SCHEMA,
      provision_id: id,
      as_of: asOf,
      status: "unknown",
      text: null,
      version: null,
      reason: "no version with known legal validity covers this date",
      used_publisher_current_text: false,
      source_ref: null,
      content_hash: null,
      redesignation_label: redesignation ? redesignationCopy(redesignation, redesignation.redesignation?.successor_provision_id === id ? "successor" : "former") : null,
      changes: relatedChanges,
    });
  }
  const inactive = version.status === "repealed" || version.status === "redesignated";
  const redesignation = relatedChanges.find((change) => change.operation === "redesignate") || null;
  return freeze({
    schema: PROVISION_AS_OF_SCHEMA,
    provision_id: id,
    as_of: asOf,
    status: version.status === "repealed"
      ? "repealed"
      : version.status === "redesignated"
        ? "redesignated"
        : "current",
    text: inactive ? null : version.text,
    version,
    reason: null,
    used_publisher_current_text: false,
    source_ref: version.source_ref || null,
    content_hash: version.content_hash || null,
    redesignation_label: redesignation
      ? redesignationCopy(
        redesignation,
        redesignation.redesignation?.successor_provision_id === id ? "successor" : "former",
      )
      : null,
    changes: relatedChanges,
  });
}

export function buildProvisionHistoryIndex({ graphs = [], versions = {}, provisions = {} } = {}) {
  const legalIndex = indexLegalChanges(graphs);
  const byProvision = {};
  const provisionIds = new Set([
    ...Object.keys(legalIndex.by_provision || {}),
    ...Object.keys(versions || {}),
    ...Object.keys(provisions || {}),
  ]);
  for (const provisionId of provisionIds) {
    const rows = legalIndex.by_provision?.[provisionId] || [];
    const history = rows.map((row) => historyEntry(row.change, row.graph, provisionId));
    byProvision[provisionId] = freeze({
      provision_id: provisionId,
      citation: provisions?.[provisionId]?.citation || history[0]?.citation || null,
      versions: freeze(Array.isArray(versions?.[provisionId]) ? versions[provisionId] : []),
      changes: history,
      source_urls: [...new Set(history.map((row) => row.source_url).filter(Boolean))],
    });
  }
  const byLaw = {};
  for (const [lawId, rows] of Object.entries(legalIndex.by_law || {})) {
    byLaw[lawId] = freeze({
      legal_instrument_id: lawId,
      changes: rows.map((row) => historyEntry(row.change, row.graph, row.change.target?.provision_id)),
      provision_ids: [...new Set(rows.flatMap((row) => [
        row.change.target?.provision_id,
        row.change.redesignation?.successor_provision_id,
      ].filter(Boolean)))],
      source_urls: [...new Set(rows.map((row) => row.change.source?.url).filter(Boolean))],
    });
  }
  return freeze({
    schema: PROVISION_HISTORY_INDEX_SCHEMA,
    by_provision: byProvision,
    by_law: byLaw,
    by_matter: legalIndex.by_matter,
  });
}

export function renderProvisionAsOf(result, {
  empty = "CityScroll does not have a version with known legal validity for this date.",
  headingId = "current-text",
} = {}) {
  if (!result) return "";
  const status = result.status === "repealed"
    ? "repealed / inactive"
    : result.status === "redesignated"
      ? "redesignated"
      : result.status;
  const label = result.as_of ? `Text as of ${result.as_of}` : "Current text";
  const formerly = result.redesignation_label
    ? `<p class="code-change-formerly" data-redesignation="1">${escapeHtml(result.redesignation_label)}</p>`
    : "";
  if (result.status === "unknown" || result.text == null) {
    const inactive = result.status === "repealed" || result.status === "redesignated";
    const copy = inactive
      ? `This provision is ${status} on ${escapeHtml(result.as_of)}.`
      : empty;
    return `<section aria-labelledby="${escapeHtml(headingId)}"><h3 id="${escapeHtml(headingId)}">${escapeHtml(label)}</h3>${formerly}<p class="admin-code-empty" data-provision-as-of="${escapeHtml(result.as_of || "")}" data-provision-as-of-status="${escapeHtml(result.status)}">${escapeHtml(copy)}</p></section>`;
  }
  const body = `<div class="admin-code-text" data-provision-as-of="${escapeHtml(result.as_of)}" data-provision-as-of-status="${escapeHtml(result.status)}">${escapeHtml(result.text).replaceAll("\n\n", "</p><p>").replace(/^/, "<p>").replace(/$/, "</p>")}</div>`;
  return `<section aria-labelledby="${escapeHtml(headingId)}"><h3 id="${escapeHtml(headingId)}">${escapeHtml(label)}</h3>${formerly}${body}</section>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export { redesignationCopy };
