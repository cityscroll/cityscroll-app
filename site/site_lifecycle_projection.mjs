/**
 * Materialized parcel history.  A parcel is a navigation anchor, not a
 * claim that its members are one project, owner, or causal chain.
 */

import { createHash } from "node:crypto";
import {
  SITE_LIFECYCLE_SCHEMA as READER_SITE_LIFECYCLE_SCHEMA,
  assembleSiteLifecycleDocument,
  createSiteLifecycleReader,
} from "./site_lifecycle_reader.mjs";

export const SITE_LIFECYCLE_SCHEMA = READER_SITE_LIFECYCLE_SCHEMA;
export const SITE_LIFECYCLE_MEMBER_SCHEMA = "cityscroll.site_lifecycle_member.v1";
export const SITE_LIFECYCLE_SHARD_SIZE = 250;
export { assembleSiteLifecycleDocument, createSiteLifecycleReader };

const clean = (value, max = 1000) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const date = (value) => {
  const v = clean(value, 40);
  return /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(v) ? v.slice(0, 10) : null;
};
const bbl = (value) => {
  const v = clean(value, 20).replace(/\.0$/, "");
  return /^\d{10}$/.test(v) ? v : null;
};
const id = (value) => clean(value, 240) || null;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function member({ subjectId, subjectHref, recordKind, sourceSystem, sourceEventDate, datePrecision = "day", sourceEvents = [], title, agency, stage, vendor, evidencePath, footprintScope, relationPath = [] }) {
  const subject_id = id(subjectId);
  if (!subject_id || !clean(recordKind, 80) || !clean(sourceSystem, 100)) return null;
  return {
    schema: SITE_LIFECYCLE_MEMBER_SCHEMA,
    subject_id,
    subject_href: clean(subjectHref, 1200) || null,
    record_kind: clean(recordKind, 80),
    source_system: clean(sourceSystem, 100),
    source_event_date: date(sourceEventDate),
    source_event_date_precision: date(sourceEventDate) ? clean(datePrecision, 30) || "unknown" : "unknown",
    source_events: sourceEvents.map((event) => ({ event: clean(event?.event, 60) || "observed", date: date(event?.date), date_precision: date(event?.date) ? clean(event?.date_precision, 30) || "day" : "unknown" })).filter((event) => event.date),
    source_title: clean(title, 500) || subject_id,
    agency: clean(agency, 160) || null,
    stage: clean(stage, 160) || null,
    vendor: clean(vendor, 240) || null,
    evidence_path: clean(evidencePath, 1200) || null,
    footprint_scope: Array.isArray(footprintScope) ? [...new Set(footprintScope.map(bbl).filter(Boolean))].sort() : [],
    relation_path: Array.isArray(relationPath) ? relationPath.map((step) => clean(step, 200)).filter(Boolean) : [],
  };
}

function projectMembers(row, projectLots = []) {
  const projectId = id(row?.project_id);
  if (!projectId) return [];
  const lots = [...new Set(projectLots.filter((lot) => id(lot?.project_id) === projectId).flatMap((lot) => lot?.bbls || lot?.bbl ? (lot.bbls || [lot.bbl]) : []).map(bbl).filter(Boolean))].sort();
  if (!lots.length) return [];
  const out = [];
  const href = clean(row.href, 1200) || `/browse/zoning/#land/${encodeURIComponent(projectId)}`;
  const title = row.project_name || row.title || projectId;
  const sourceEvents = ["app_filed_date", "noticed_date", "approval_date", "completed_date"].map((field) => ({ event: field.replaceAll("_", " "), date: row[field] })).filter((event) => date(event.date));
  const event = sourceEvents[0]?.date || null;
  out.push(member({ subjectId: `land:project:${projectId}`, subjectHref: href, recordKind: "land_project", sourceSystem: row.source_system || "zap-projects-open-data", sourceEventDate: event, datePrecision: event ? "day" : "unknown", sourceEvents, title, evidencePath: row.evidence_path || `zap-projects-open-data:${projectId}`, footprintScope: lots }));
  const applications = String(row.ulurp_numbers || "").split(/[;,]/).map((v) => clean(v, 80)).filter(Boolean);
  for (const application of [...new Set(applications)].sort()) out.push(member({ subjectId: `land:application:${application}`, subjectHref: `/browse/zoning/#land/${encodeURIComponent(projectId)}`, recordKind: "land_application", sourceSystem: row.source_system || "zap-projects-open-data", sourceEventDate: event, title: application, evidencePath: row.evidence_path || `zap-projects-open-data:${projectId}#ulurp_numbers`, footprintScope: lots, relationPath: [`land:project:${projectId}`] }));
  return out.filter(Boolean);
}

function councilMembers(rows, projectLots, councilLookup) {
  const out = [];
  for (const raw of rows || []) {
    const projectId = id(raw?.project_id || raw?.projectId);
    const matterId = id(raw?.matter_id || raw?.matterId || raw?.id);
    if (!projectId || !matterId) continue;
    const lots = projectLots.filter((lot) => id(lot?.project_id) === projectId).flatMap((lot) => lot?.bbls || lot?.bbl ? (lot.bbls || [lot.bbl]) : []).map(bbl).filter(Boolean);
    if (!lots.length) continue;
    out.push(member({ subjectId: `council:matter:${matterId}`, subjectHref: raw.href || `/matters/${encodeURIComponent(matterId)}/`, recordKind: "council_matter", sourceSystem: raw.source_system || "legistar", sourceEventDate: raw.event_date || raw.when, title: raw.title || raw.matter_file || matterId, evidencePath: raw.evidence_path || raw.source_url || `legistar:matter:${matterId}`, footprintScope: lots, relationPath: [`land:project:${projectId}`, `land:application:${clean(raw.join_value || raw.application_id, 80)}`].filter((v) => !v.endsWith(":")) }));
  }
  // Accept the existing keyed lookup without making Council directly identify a lot.
  for (const [matterId, raw] of Object.entries(councilLookup?.matters || {})) {
    if ((rows || []).some((row) => String(row?.matter_id || row?.id) === matterId)) continue;
    const projectId = id(raw?.project_id);
    if (!projectId) continue;
    out.push(...councilMembers([{ ...raw, matter_id: matterId }], projectLots, {}));
  }
  return out;
}

function procurementMembers(records, projectLots) {
  const out = [];
  for (const raw of records || []) {
    const evidence = Array.isArray(raw?.evidence) ? raw.evidence : [raw];
    const accepted = evidence.filter((item) => bbl(item?.resolved_bbl || item?.bbl) && item?.classification !== "ambiguous_target" && item?.classification !== "conflicting_target");
    for (const item of accepted) {
      const requestId = id(raw.request_id || raw.id || raw.source_record_id);
      if (!requestId) continue;
      const lot = bbl(item.resolved_bbl || item.bbl);
      const kind = clean(raw.record_kind || raw.object_kind || item.record_kind, 80) || "procurement_observation";
      const subjectId = id(raw.subject_id) || `${clean(raw.source_system || "procurement", 80)}:${kind}:${requestId}`;
      const canonical = subjectId.startsWith("procurement:contract:")
        ? `/procurements/${encodeURIComponent(subjectId)}`
        : (raw.href || item.href || `/procurements/${encodeURIComponent(raw.procurement_id || requestId)}`);
      out.push(member({ subjectId, subjectHref: canonical, recordKind: kind, sourceSystem: raw.source_system || "procurement", sourceEventDate: raw.event_date || raw.award_date || raw.start_date || raw.when, datePrecision: raw.date_precision || "day", title: raw.title || raw.short_title || raw.name || requestId, agency: raw.agency || raw.agency_name, stage: raw.stage || raw.primary_stage, vendor: raw.vendor || raw.vendor_name, evidencePath: item.evidence_path || item.source_url || raw.evidence_path || `${raw.source_system || "procurement"}:${requestId}`, footprintScope: [lot], relationPath: raw.relation_path || [] }));
    }
  }
  return out;
}

function mergeSourceEvents(left = [], right = []) {
  const byKey = new Map();
  for (const event of [...left, ...right]) {
    if (!event?.date) continue;
    const key = `${event.event || "observed"}:${event.date}:${event.date_precision || "unknown"}`;
    if (!byKey.has(key)) byKey.set(key, event);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.event.localeCompare(b.event));
}

function observationDateEvents(item) {
  const events = [...(item?.source_events || [])];
  if (
    item?.source_event_date
    && !events.some((event) => event?.date === item.source_event_date)
  ) {
    events.push({
      event: "observed",
      date: item.source_event_date,
      date_precision: item.source_event_date_precision || "day",
    });
  }
  return events;
}

/** Prefer the richer observation while preserving distinct dated evidence. */
function mergeMemberObservations(left, right) {
  if (!left) return right;
  if (!right) return left;
  const preferRight =
    JSON.stringify(right).localeCompare(JSON.stringify(left)) < 0;
  const primary = preferRight ? right : left;
  const secondary = preferRight ? left : right;
  const sourceEvents = mergeSourceEvents(observationDateEvents(left), observationDateEvents(right));
  const eventDate =
    [primary.source_event_date, secondary.source_event_date].filter(Boolean).sort()[0] || null;
  return {
    ...primary,
    source_event_date: eventDate,
    source_event_date_precision: eventDate
      ? primary.source_event_date_precision || secondary.source_event_date_precision || "unknown"
      : "unknown",
    source_events: sourceEvents,
    source_title: primary.source_title || secondary.source_title,
    agency: primary.agency || secondary.agency,
    stage: primary.stage || secondary.stage,
    vendor: primary.vendor || secondary.vendor,
    evidence_path: primary.evidence_path || secondary.evidence_path,
    subject_href: primary.subject_href || secondary.subject_href,
    footprint_scope: [...new Set([...(left.footprint_scope || []), ...(right.footprint_scope || [])])].sort(),
    relation_path: [...new Set([...(left.relation_path || []), ...(right.relation_path || [])])],
  };
}

function dedupeMembers(members) {
  const byId = new Map();
  for (const item of members) {
    if (!item || !item.subject_id) continue;
    byId.set(item.subject_id, mergeMemberObservations(byId.get(item.subject_id), item));
  }
  return [...byId.values()].sort((a, b) => (a.source_event_date || "9999-99-99").localeCompare(b.source_event_date || "9999-99-99") || a.record_kind.localeCompare(b.record_kind) || a.subject_id.localeCompare(b.subject_id));
}

/** Build forward parcel histories and an exact reciprocal member index. */
export function materializeSiteLifecycle({ landProjects = [], projectLots = [], councilMatters = [], councilLookup = null, procurementRecords = [], propertyRecords = [], generatedAt = null, generation = null } = {}) {
  // Retain every observation first, distribute footprints, then project identity
  // per parcel. Collapsing by subject before distribution drops alternate lots.
  const all = [...landProjects.flatMap((row) => projectMembers(row, projectLots)), ...councilMembers(councilMatters, projectLots, councilLookup), ...procurementMembers(procurementRecords, projectLots), ...procurementMembers(propertyRecords, projectLots)].filter(Boolean);
  const byParcel = new Map();
  for (const item of all) for (const parcel of item.footprint_scope || []) {
    if (!byParcel.has(parcel)) byParcel.set(parcel, []);
    byParcel.get(parcel).push(item);
  }
  const parcels = {};
  for (const parcel of [...byParcel.keys()].sort()) parcels[parcel] = { parcel_id: parcel, parcel_href: `/parcels/${parcel}/`, members: dedupeMembers(byParcel.get(parcel)) };

  // After footprints are distributed, project identity across parcels so every
  // admitted entry point retains the subject's distinct dated observations.
  const bySubject = new Map();
  for (const history of Object.values(parcels)) {
    for (const item of history.members) {
      bySubject.set(item.subject_id, mergeMemberObservations(bySubject.get(item.subject_id), item));
    }
  }
  for (const history of Object.values(parcels)) {
    history.members = history.members.map((item) => {
      const merged = bySubject.get(item.subject_id);
      return merged ? { ...merged } : item;
    });
  }

  const members = {};
  for (const [parcel, history] of Object.entries(parcels)) for (const item of history.members) {
    members[item.subject_id] ||= { subject_id: item.subject_id, parcel_ids: [] };
    members[item.subject_id].parcel_ids.push(parcel);
  }
  for (const value of Object.values(members)) value.parcel_ids.sort();
  const payload = { parcels, members };
  const content_hash = hash(payload);
  const generation_id = generation || content_hash;
  return { schema: SITE_LIFECYCLE_SCHEMA, version: 1, generated_at: generatedAt, generation: generation_id, content_hash, counts: { parcels: Object.keys(parcels).length, members: Object.keys(members).length }, ...payload };
}

export function shardSiteLifecycle(document, shardSize = SITE_LIFECYCLE_SHARD_SIZE) {
  const size = Math.max(1, Math.floor(Number(shardSize) || SITE_LIFECYCLE_SHARD_SIZE));
  const entries = Object.values(document?.parcels || {}).sort((a, b) => a.parcel_id.localeCompare(b.parcel_id));
  const shards = [];
  for (let i = 0; i < entries.length; i += size) shards.push({ schema: `${SITE_LIFECYCLE_SCHEMA}.shard`, version: 1, generation: document.generation, content_hash: document.content_hash, shard: String(shards.length).padStart(4, "0"), rows: entries.slice(i, i + size) });
  return shards;
}

export function siteLifecycleGeneration(document) { return document?.generation || null; }
