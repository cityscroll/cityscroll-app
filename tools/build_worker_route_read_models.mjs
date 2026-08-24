#!/usr/bin/env node
// Build immutable, keyed Worker route read-model slices. The source artifacts
// remain the build inputs; only the versioned slices are published to ALERT_STATE.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "worker/.route-read-models");
const PATHS = {
  activity: join(ROOT, "worker/src/data/district_activity.json"),
  meetings: join(ROOT, "site/data/shared_meeting_read_model.json"),
  geography: join(ROOT, "site/data/community_board_geography_lookup.json"),
};
const LENSES = ["land", "property", "rules", "meetings", "money"];
const LEVELS = ["borough", "community_district", "council_district"];
const BOROUGHS = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashInputs() {
  const hash = createHash("sha256");
  for (const path of Object.values(PATHS)) hash.update(readFileSync(path));
  return `v1-${hash.digest("hex").slice(0, 16)}`;
}

function keyFor(version, kind, id) {
  return `${kind}:v1:${version}:${encodeURIComponent(id)}`;
}

function idsFor(activity, id, lens) {
  if (id === "citywide" || id === "virtual" || id === "unlocated") {
    return activity.district_items?.[id]?.[lens] || [];
  }
  const [kind, ...rest] = id.split(":");
  const value = rest.join(":");
  if (kind === "borough") return activity.district_items?.by_level?.borough?.[value]?.[lens] || [];
  if (kind === "community-district") return activity.district_items?.by_level?.community_district?.[value]?.[lens] || [];
  if (kind === "council-district") return activity.district_items?.by_level?.council_district?.[value]?.[lens] || [];
  return activity.geography_items?.by_key?.[id]?.[lens] || [];
}

function countFor(list, allowed) {
  return (list || []).filter((id) => allowed.has(String(id))).length;
}

function sliceActivity(activity, id, lens, { includeBasis = true } = {}) {
  const allowed = new Set(idsFor(activity, id, lens).map(String));
  const byLevel = {};
  const districtItems = { by_level: {}, citywide: {}, virtual: {}, unlocated: {} };
  for (const level of LEVELS) {
    byLevel[level] = {};
    districtItems.by_level[level] = {};
    for (const [area, counts] of Object.entries(activity.by_level?.[level] || {})) {
      const members = activity.district_items?.by_level?.[level]?.[area]?.[lens] || [];
      const count = countFor(members, allowed);
      if (count || area === id.split(":").slice(1).join(":")) {
        byLevel[level][area] = { [lens]: count };
        districtItems.by_level[level][area] = { [lens]: members.filter((member) => allowed.has(String(member))) };
      }
    }
  }
  const buckets = {};
  for (const bucket of ["citywide", "virtual", "unlocated"]) {
    const members = activity.district_items?.[bucket]?.[lens] || [];
    buckets[bucket] = { [lens]: countFor(members, allowed) };
    districtItems[bucket] = { [lens]: members.filter((member) => allowed.has(String(member))) };
  }
  const records = Object.fromEntries([...allowed]
    .map((recordId) => [recordId, activity.records?.[lens]?.[recordId]])
    .filter(([, record]) => record));
  const geoMembership = Object.fromEntries(Object.entries(activity.geography_items?.by_key || {})
    .map(([key, lenses]) => [key, { [lens]: (lenses?.[lens] || []).filter((member) => allowed.has(String(member))) }])
    .filter(([, lenses]) => lenses[lens].length));
  const geographyItems = {
    ...activity.geography_items,
    definitions: activity.geography_items?.definitions || {},
    by_key: geoMembership,
  };
  const core = {
    schema: activity.schema,
    boundary_vintage: activity.boundary_vintage,
    built_at: activity.built_at,
    levels: activity.levels,
    lenses: [lens],
    by_level: byLevel,
    citywide: buckets.citywide,
    virtual: buckets.virtual,
    unlocated: buckets.unlocated,
    district_items: districtItems,
    geography_items: geographyItems,
    records: { [lens]: records },
    explanation_paths: activity.explanation_paths,
    note: "Versioned keyed Near You slice; source activity is not bundled in the Worker.",
  };
  if (includeBasis && lens === "money" && activity.basis_layers?.contract_action_address) {
    const source = activity.basis_layers.contract_action_address;
    const basis = sliceActivity({ ...activity, ...source, records: source.records || {} }, id, lens, { includeBasis: false });
    core.basis_layers = { contract_action_address: basis };
  }
  return core;
}

function communityGeographySlice(geography, id) {
  const district = id.match(/^community-district:(.+)$/)?.[1] || null;
  if (!district) return {};
  const edges = (geography.public_edges || []).filter((edge) =>
    (edge.type === "covers" && edge.to === `community-district:${district}`)
    || (edge.type === "intersects" && (edge.from === `community-district:${district}` || edge.to === `community-district:${district}`)));
  const refs = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return {
    schema: geography.schema,
    generated_at: geography.generated_at,
    boundary_vintage: geography.boundary_vintage,
    gate: geography.gate,
    nodes: (geography.nodes || []).filter((node) => refs.has(node.subject_ref)),
    public_edges: edges,
  };
}

function buildNearYou(activity, geography, version) {
  const ids = [
    ...BOROUGHS.map((borough) => `borough:${borough}`),
    ...Object.keys(activity.district_items?.by_level?.community_district || {}).map((id) => `community-district:${id}`),
    ...Object.keys(activity.district_items?.by_level?.council_district || {}).map((id) => `council-district:${id}`),
    "citywide", "virtual", "unlocated",
    ...Object.keys(activity.geography_items?.definitions || {}),
  ];
  const entries = [];
  const slices = {};
  for (const id of [...new Set(ids)]) {
    for (const lens of LENSES) {
      const activitySlice = sliceActivity(activity, id, lens);
      const key = keyFor(version, "near-you", `${id}:${lens}`);
      slices[`${id}:${lens}`] = key;
      entries.push({ key, value: JSON.stringify({
        schema_version: 1,
        kind: "near-you",
        version,
        slice_id: id,
        lens,
        activity: activitySlice,
        community_geography: communityGeographySlice(geography, id),
      }) });
    }
  }
  return {
    entries,
    manifest: { schema_version: 1, kind: "near-you", version, source_schema: activity.schema, slices },
  };
}

function buildMeetings(meetings, version) {
  const grouped = new Map();
  const idToSlice = {};
  for (const row of meetings.rows || []) {
    const month = String(row.event_date || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month) || !row.meeting_id) continue;
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month).push(row);
  }
  const entries = [];
  const slices = {};
  for (const [month, rows] of grouped) {
    const key = keyFor(version, "meetings", month);
    slices[month] = key;
    for (const row of rows) idToSlice[row.meeting_id] = key;
    entries.push({ key, value: JSON.stringify({ schema_version: 1, kind: "meetings", version, month, rows }) });
  }
  const canary = (meetings.rows || []).find((row) => row?.meeting_id && row?.event_date);
  return {
    entries,
    manifest: {
      schema_version: 1,
      kind: "meetings",
      version,
      source_schema: meetings.schema,
      slices,
      id_to_slice: idToSlice,
      canary_meeting_id: canary?.meeting_id || null,
    },
  };
}

function assertCanaries(out) {
  const near = readJson(join(out, "near-you.manifest.json"));
  const meetings = readJson(join(out, "meetings.manifest.json"));
  for (const id of ["borough:Queens:meetings", "community-district:M07:meetings"]) {
    if (!near.slices[id]) throw new Error(`Near You canary key missing: ${id}`);
  }
  if (!meetings.canary_meeting_id || !meetings.id_to_slice[meetings.canary_meeting_id]) {
    throw new Error("meeting canary is missing from the versioned manifest");
  }
  const nearEntries = new Map(readJson(join(out, "near-you.bulk.json")).map((entry) => [entry.key, JSON.parse(entry.value)]));
  for (const id of ["borough:Queens:meetings", "community-district:M07:meetings"]) {
    const slice = nearEntries.get(near.slices[id]);
    if (!slice?.activity?.records?.meetings || Object.keys(slice.activity.records.meetings).length === 0) {
      throw new Error(`Near You canary is empty: ${id}`);
    }
  }
}

function writeBulkChunks(out, prefix, entries, maxBytes = 8 * 1024 * 1024) {
  let chunk = [];
  let bytes = 2;
  let index = 0;
  const flush = () => {
    if (!chunk.length) return;
    writeFileSync(join(out, `${prefix}.bulk.${String(index++).padStart(3, "0")}.json`), JSON.stringify(chunk));
    chunk = [];
    bytes = 2;
  };
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (chunk.length && bytes + entryBytes > maxBytes) flush();
    chunk.push(entry);
    bytes += entryBytes;
  }
  flush();
}

function main() {
  const out = arg("--output-dir", DEFAULT_OUT);
  const check = process.argv.includes("--check");
  const version = arg("--version", null) || hashInputs();
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const activity = readJson(PATHS.activity);
  const meetings = readJson(PATHS.meetings);
  const geography = readJson(PATHS.geography);
  const near = buildNearYou(activity, geography, version);
  const meeting = buildMeetings(meetings, version);
  writeFileSync(join(out, "near-you.bulk.json"), JSON.stringify(near.entries));
  writeFileSync(join(out, "meetings.bulk.json"), JSON.stringify(meeting.entries));
  writeBulkChunks(out, "near-you", near.entries);
  writeBulkChunks(out, "meetings", meeting.entries);
  writeFileSync(join(out, "near-you.manifest.json"), JSON.stringify(near.manifest, null, 2));
  writeFileSync(join(out, "meetings.manifest.json"), JSON.stringify(meeting.manifest, null, 2));
  writeFileSync(join(out, "route-read-model-receipt.json"), JSON.stringify({
    schema_version: 1, version, generated_at: new Date().toISOString(),
    near_you_slice_count: near.entries.length, meeting_slice_count: meeting.entries.length,
  }, null, 2));
  assertCanaries(out);
  if (check) console.log(`route read-model canaries passed (${version})`);
  else console.log(`built ${near.entries.length + meeting.entries.length} route read-model slices (${version})`);
}

main();
