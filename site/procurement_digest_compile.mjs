/**
 * Digest compile for observation-fed procurement objects.
 *
 * City Record-backed objects keep request_id delivery identity. CROL-negative
 * PASSPort/Checkbook rows compile as procurement_id rows and must not pretend
 * to be notices.
 */

import { procurementCanonicalHref } from "./procurement_object_contract.mjs";
import { vendorStem } from "./vendor_stem.mjs";

export const PROCUREMENT_DIGEST_SNAPSHOT_SCHEMA = "cityscroll.procurement_digest_snapshot.v1";
export const PROCUREMENT_DIGEST_LIMIT = 25;

const CITY_RECORD_REF = /^(?:city_record|city_record_procurement|crol):/i;
const AWARD_STAGES = new Set(["award", "pending", "registered", "payment", "contract"]);

function text(value, max = 500) {
  const result = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return result || null;
}

function isoDay(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  return null;
}

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function first(rows, fields, max = 500) {
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const field of fields) {
      const value = text(row?.[field], max);
      if (value) return value;
    }
  }
  return null;
}

function observationIndex(model) {
  return new Map((Array.isArray(model?.observations) ? model.observations : [])
    .map((entry) => [entry?.source_observation_ref, entry]));
}

function snapshotsFor(object, model) {
  if (Array.isArray(object?.snapshots) && object.snapshots.length) return object.snapshots;
  const index = observationIndex(model);
  return (object?.source_observation_refs || [])
    .map((ref) => index.get(ref)?.snapshot)
    .filter((row) => row && typeof row === "object");
}

function sourceSystemsFor(object, model) {
  if (Array.isArray(object?.source_systems) && object.source_systems.length) return object.source_systems;
  const index = observationIndex(model);
  return [...new Set((object?.source_observation_refs || [])
    .map((ref) => index.get(ref)?.source_system)
    .filter(Boolean))];
}

function stagesFor(object) {
  if (Array.isArray(object?.procurement_stages) && object.procurement_stages.length) {
    return object.procurement_stages.map((stage) => text(stage, 80)).filter(Boolean);
  }
  return (Array.isArray(object?.stages) ? object.stages : [])
    .map((entry) => text(typeof entry === "string" ? entry : entry?.stage, 80))
    .filter(Boolean);
}

export function isCrolNegativeProcurement(object = {}) {
  const hrefs = object?.compatibility?.city_record_notice_hrefs;
  if (Array.isArray(hrefs) && hrefs.length) return false;
  if (object?.request_id) return false;
  const refs = Array.isArray(object?.source_observation_refs) ? object.source_observation_refs : [];
  if (refs.some((ref) => CITY_RECORD_REF.test(String(ref || "")))) return false;
  const systems = Array.isArray(object?.source_systems) ? object.source_systems : [];
  if (systems.some((system) => CITY_RECORD_REF.test(`${system}:`))) return false;
  return Boolean(text(object?.procurement_id, 320)?.startsWith("procurement:"));
}

export function digestIdentity(row = {}) {
  return text(row.request_id, 80) || text(row.procurement_id, 320) || text(row.digest_id, 320);
}

export function stampDigestIdentity(row) {
  if (!row || typeof row !== "object") return row;
  const id = digestIdentity(row);
  return id ? { ...row, digest_id: id } : row;
}

export function procurementDigestRow(object = {}, model = {}) {
  if (!isCrolNegativeProcurement(object)) return null;
  const id = text(object.procurement_id, 320);
  const snapshots = snapshotsFor(object, model);
  const stages = stagesFor(object);
  const contractId = object.identity_keys?.contract_ids?.[0] || first(snapshots, ["contract_id", "id"], 160);
  const pin = object.identity_keys?.epins?.[0] || first(snapshots, ["epin", "pin"], 160);
  const title = first(snapshots, ["short_title", "title", "description"], 500)
    || `Contract ${contractId || pin || id.replace(/^procurement:[^:]+:/, "")}`;
  const amount = numeric(first(snapshots, [
    "contract_amount", "award_amount", "current_amount", "current", "amount", "check_amount",
  ], 80));
  const startDate = isoDay(first(snapshots, [
    "start_date", "registered", "registration_date", "start", "issue_date", "date",
  ], 40));
  const href = object.canonical_href || object.compatibility?.canonical_href || procurementCanonicalHref(id);
  return Object.freeze({
    procurement_id: id,
    digest_id: id,
    canonical_href: href,
    short_title: title,
    agency_name: first(snapshots, ["agency_name", "agency"], 240),
    vendor_name: first(snapshots, ["vendor_name", "vendor", "prime_vendor", "payee_name"], 240),
    contract_amount: amount,
    start_date: startDate,
    pin: pin || null,
    contract_id: contractId || null,
    procurement_stages: Object.freeze(stages),
    primary_stage: stages.at(-1) || null,
    source_systems: Object.freeze(sourceSystemsFor(object, model)),
    type_of_notice_description: null,
  });
}

function compactRowFromDigest(row) {
  if (!row?.procurement_id) return null;
  return {
    procurement_id: row.procurement_id,
    digest_id: row.digest_id || row.procurement_id,
    canonical_href: row.canonical_href || procurementCanonicalHref(row.procurement_id),
    short_title: row.short_title || null,
    agency_name: row.agency_name || null,
    vendor_name: row.vendor_name || null,
    contract_amount: row.contract_amount ?? null,
    start_date: row.start_date || null,
    pin: row.pin || null,
    contract_id: row.contract_id || null,
    procurement_stages: Array.isArray(row.procurement_stages) ? [...row.procurement_stages] : [],
    primary_stage: row.primary_stage || null,
    source_systems: Array.isArray(row.source_systems) ? [...row.source_systems] : [],
    type_of_notice_description: null,
  };
}

export function compactCrolNegativeDigestRows(model = {}) {
  const objects = Array.isArray(model?.rows) ? model.rows : [];
  return objects.map((object) => procurementDigestRow(object, model)).filter(Boolean);
}

export function buildProcurementDigestSnapshot(model = {}) {
  const rows = compactCrolNegativeDigestRows(model);
  return {
    schema: PROCUREMENT_DIGEST_SNAPSHOT_SCHEMA,
    generated_at: model.generated_at || null,
    row_count: rows.length,
    rows,
  };
}

function snapshotRows(source) {
  if (Array.isArray(source)) return source;
  if (source?.schema === PROCUREMENT_DIGEST_SNAPSHOT_SCHEMA && Array.isArray(source.rows)) {
    return source.rows;
  }
  if (Array.isArray(source?.rows) && source.rows[0]?.procurement_id && source.rows[0]?.object_type === "procurement") {
    return compactCrolNegativeDigestRows(source);
  }
  if (Array.isArray(source?.rows)) return source.rows;
  return [];
}

function wantsAwardFilter(filter = {}) {
  if (filter.procurement_id) return true;
  if (filter.noticeType === "solicitation") return false;
  if (filter.noticeType === "award") return true;
  return Boolean(filter.minAmount || filter.maxAmount);
}

function rowMatchesFilter(row, filter = {}, lens = "money") {
  if (!row?.procurement_id) return false;
  if (filter.procurement_id && text(filter.procurement_id, 320) !== row.procurement_id) return false;
  if (lens === "entity") {
    const name = text(filter.name, 120);
    if (!name) return false;
    if (filter.kind === "agency") {
      return text(row.agency_name, 240) === name;
    }
    const stem = vendorStem(name);
    if (stem.length < 3) return false;
    return vendorStem(row.vendor_name) === stem;
  }
  if (filter.agency && text(row.agency_name, 240) !== text(filter.agency, 240)) return false;
  if (filter.minAmount != null && (row.contract_amount == null || Number(row.contract_amount) < Number(filter.minAmount))) {
    return false;
  }
  if (filter.maxAmount != null && (row.contract_amount == null || Number(row.contract_amount) > Number(filter.maxAmount))) {
    return false;
  }
  if (!wantsAwardFilter(filter)) return false;
  const stages = stagesFor(row);
  if (stages.length && !stages.some((stage) => AWARD_STAGES.has(String(stage).toLowerCase()))) return false;
  const keywords = Array.isArray(filter.keywords) ? filter.keywords.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean) : [];
  if (keywords.length) {
    const haystack = [
      row.short_title, row.agency_name, row.vendor_name, row.pin, row.contract_id, row.procurement_id,
      ...(Array.isArray(row.procurement_stages) ? row.procurement_stages : []),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!keywords.every((keyword) => haystack.includes(keyword))) return false;
  }
  return true;
}

export function matchProcurementDigestRows(source, filter = {}, options = {}) {
  const lens = options.lens || "money";
  if (lens !== "money" && lens !== "entity") return [];
  const exactId = text(filter.procurement_id, 320);
  const limit = Number.isInteger(options.limit) ? options.limit : (exactId ? 1 : PROCUREMENT_DIGEST_LIMIT);
  const matched = snapshotRows(source)
    .map((row) => (row?.object_type === "procurement" ? procurementDigestRow(row, source) : compactRowFromDigest(row)))
    .filter(Boolean)
    .filter((row) => rowMatchesFilter(row, filter, lens))
    .sort((left, right) => String(right.start_date || "").localeCompare(String(left.start_date || "")));
  return matched.slice(0, Math.max(0, limit)).map((row) => Object.freeze(stampDigestIdentity(row)));
}

export function unionMoneyDigestRows(noticeRows = [], procurementRows = []) {
  const seen = new Set();
  const out = [];
  for (const row of [...(Array.isArray(noticeRows) ? noticeRows : []), ...(Array.isArray(procurementRows) ? procurementRows : [])]) {
    const stamped = stampDigestIdentity(row);
    const id = digestIdentity(stamped);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(stamped);
  }
  return out;
}

export function mergeProcurementDigestMatches(sub, rows, source, todayISO = null) {
  const lens = sub?.lens;
  const filter = sub?.filter && typeof sub.filter === "object" ? sub.filter : {};
  const current = Array.isArray(rows) ? rows.map(stampDigestIdentity) : [];
  if (lens !== "money" && lens !== "entity") return current;
  if (lens === "money" && (filter.route === "agency" || filter.route === "vendor")) return current;
  const extra = matchProcurementDigestRows(source, filter, { lens, todayISO });
  return unionMoneyDigestRows(current, extra);
}
