/**
 * Materialized parcel history.  A parcel is a navigation anchor, not a
 * claim that its members are one project, owner, or causal chain.
 */

import { createHash } from "node:crypto";

export const SITE_LIFECYCLE_SCHEMA = "cityscroll.site_lifecycle.v1";
export const SITE_LIFECYCLE_MEMBER_SCHEMA = "cityscroll.site_lifecycle_member.v1";
export const SITE_LIFECYCLE_SHARD_SIZE = 250;

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

function member({ subjectId, subjectHref, recordKind, sourceSystem, sourceEventDate, datePrecision = "day", sourceEvents = [], title, evidencePath, footprintScope, relationPath = [] }) {
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
      out.push(member({ subjectId, subjectHref: raw.href || item.href || `/procurements/${encodeURIComponent(raw.procurement_id || requestId)}`, recordKind: kind, sourceSystem: raw.source_system || "procurement", sourceEventDate: raw.event_date || raw.award_date || raw.start_date || raw.when, datePrecision: raw.date_precision || "day", title: raw.title || raw.short_title || raw.name || requestId, evidencePath: item.evidence_path || item.source_url || raw.evidence_path || `${raw.source_system || "procurement"}:${requestId}`, footprintScope: [lot], relationPath: raw.relation_path || [] }));
    }
  }
  return out;
}

function dedupeMembers(members) {
  const byId = new Map();
  for (const item of members) {
    if (!item || !item.subject_id) continue;
    const previous = byId.get(item.subject_id);
    if (!previous || JSON.stringify(item).localeCompare(JSON.stringify(previous)) < 0) byId.set(item.subject_id, item);
  }
  return [...byId.values()].sort((a, b) => (a.source_event_date || "9999-99-99").localeCompare(b.source_event_date || "9999-99-99") || a.record_kind.localeCompare(b.record_kind) || a.subject_id.localeCompare(b.subject_id));
}

/** Build forward parcel histories and an exact reciprocal member index. */
export function materializeSiteLifecycle({ landProjects = [], projectLots = [], councilMatters = [], councilLookup = null, procurementRecords = [], propertyRecords = [], generatedAt = null, generation = null } = {}) {
  const all = [...landProjects.flatMap((row) => projectMembers(row, projectLots)), ...councilMembers(councilMatters, projectLots, councilLookup), ...procurementMembers(procurementRecords, projectLots), ...procurementMembers(propertyRecords, projectLots)];
  const byParcel = new Map();
  for (const item of dedupeMembers(all)) for (const parcel of item.footprint_scope) {
    if (!byParcel.has(parcel)) byParcel.set(parcel, []);
    byParcel.get(parcel).push(item);
  }
  const parcels = {};
  for (const parcel of [...byParcel.keys()].sort()) parcels[parcel] = { parcel_id: parcel, parcel_href: `/parcels/${parcel}/`, members: dedupeMembers(byParcel.get(parcel)) };
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

export function createSiteLifecycleReader(manifest, shards = [], reverse = null) {
  const parcels = new Map();
  for (const shard of shards) for (const row of shard?.rows || []) if (bbl(row?.parcel_id)) parcels.set(row.parcel_id, row);
  const generation = manifest?.generation || shards.find((s) => s?.generation)?.generation || null;
  if (manifest?.generation && shards.some((s) => s?.generation && s.generation !== manifest.generation)) throw new Error("site lifecycle generation mismatch");
  if (reverse && manifest?.generation !== reverse.generation) throw new Error("site lifecycle reverse index generation mismatch");
  if (reverse && manifest?.content_hash !== reverse.content_hash) throw new Error("site lifecycle reverse index content hash mismatch");
  return { generation, get(parcelId) { const key = bbl(parcelId); return key ? parcels.get(key) || null : null; }, memberParcels(subjectId) { const key = id(subjectId); return reverse?.members?.[key]?.parcel_ids?.slice() || []; }, size: parcels.size };
}

export function siteLifecycleGeneration(document) { return document?.generation || null; }
