#!/usr/bin/env node
// Build immutable, keyed Worker route read-model slices. The source artifacts
// remain the build inputs; only the versioned slices are published to ALERT_STATE.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "worker/.route-read-models");
const PATHS = {
  activity: join(ROOT, "worker/src/data/district_activity.json"),
  activitySite: join(ROOT, "site/data/district_activity.json"),
  meetings: join(ROOT, "site/data/shared_meeting_read_model.json"),
  geography: join(ROOT, "site/data/community_board_geography_lookup.json"),
  communityDigest: join(ROOT, "site/data/community_district_digests.json"),
  ntaLayer: join(ROOT, "site/data/geography/layers/nta2020/26B.json"),
  parcelManifest: join(ROOT, "site/data/parcel-geography/manifest.json"),
  meetingGeographyActive: join(ROOT, "site/data/meeting-geography-backfill/ACTIVE"),
};
export const LENSES = Object.freeze(["land", "property", "rules", "meetings", "money"]);
export const NEAR_YOU_PLACE_COVERAGE_STATES = Object.freeze([
  "ready",
  "zero",
  "source_unavailable",
]);
const LEVELS = ["borough", "community_district", "council_district"];
const BOROUGHS = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];
const RESIDENTIAL_NTA_SUBTYPE = "residential";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveActivityPath() {
  if (existsSync(PATHS.activity)) return PATHS.activity;
  if (existsSync(PATHS.activitySite)) return PATHS.activitySite;
  return PATHS.activity;
}

function hashInputs(dependencies = null) {
  const hash = createHash("sha256");
  // The generated projection is absent from source-only test fixtures. Hash
  // it when materialized while preserving the existing required inputs.
  const inputs = [
    resolveActivityPath(),
    PATHS.meetings,
    PATHS.geography,
    PATHS.communityDigest,
    PATHS.ntaLayer,
    PATHS.parcelManifest,
    PATHS.meetingGeographyActive,
  ];
  for (const path of inputs) {
    if ((path === PATHS.communityDigest || path === PATHS.ntaLayer
      || path === PATHS.parcelManifest || path === PATHS.meetingGeographyActive)
      && !existsSync(path)) continue;
    if (path === PATHS.activitySite && path !== resolveActivityPath()) continue;
    hash.update(readFileSync(path));
  }
  if (dependencies) hash.update(JSON.stringify(dependencies));
  return `v1-${hash.digest("hex").slice(0, 16)}`;
}

/** Canonical selectable residential NTA places from the closed geography layer. */
export function residentialPlacesFromNtaLayer(layerDoc = {}) {
  const vintage = layerDoc?.vintage?.id || null;
  const sourceId = layerDoc?.source?.contract_id || null;
  const layerType = String(layerDoc?.type || "nta2020");
  const features = Array.isArray(layerDoc?.features) ? layerDoc.features : [];
  const places = [];
  for (const feature of features) {
    const subtype = String(feature?.subtype || "");
    if (subtype !== RESIDENTIAL_NTA_SUBTYPE) continue;
    const id = String(feature?.id || "").trim();
    const key = String(feature?.key || (id ? `geography:${layerType}:${id}` : "")).trim();
    const label = String(feature?.label || "").trim();
    if (!key || !id || !label) continue;
    places.push({
      key,
      type: layerType,
      id,
      label,
      class: "statistical",
      subtype: RESIDENTIAL_NTA_SUBTYPE,
      source_id: sourceId,
      boundary_vintage: vintage,
    });
  }
  places.sort((left, right) => left.id.localeCompare(right.id) || left.key.localeCompare(right.key));
  return places;
}

export function requiredNearYouSliceIds(residentialPlaces = [], lenses = LENSES) {
  return residentialPlaces.flatMap((place) => lenses.map((lens) => `${place.key}:${lens}`));
}

/**
 * Observed membership only. A missing by_key row is source_unavailable —
 * never a fabricated empty array.
 */
export function placeCoverageState(activity, sliceId, lens) {
  const id = String(sliceId || "");
  const topic = String(lens || "");
  if (!id || !LENSES.includes(topic)) return "source_unavailable";
  if (id.startsWith("geography:")) {
    const entry = activity?.geography_items?.by_key?.[id];
    if (!entry || typeof entry !== "object" || !Object.prototype.hasOwnProperty.call(entry, topic)) {
      return "source_unavailable";
    }
    if (!Array.isArray(entry[topic])) return "source_unavailable";
    return entry[topic].length ? "ready" : "zero";
  }
  const members = idsFor(activity, id, topic);
  return members.length ? "ready" : "zero";
}

export function validateNearYouManifestCompleteness(manifest, residentialPlaces = [], lenses = LENSES) {
  const missing = requiredNearYouSliceIds(residentialPlaces, lenses)
    .filter((sliceId) => !manifest?.slices?.[sliceId]);
  return {
    ok: missing.length === 0,
    required: residentialPlaces.length * lenses.length,
    present: (residentialPlaces.length * lenses.length) - missing.length,
    missing,
  };
}

/**
 * Activate only a complete candidate. Incomplete or partially published
 * candidates leave the prior good manifest in place (fail-then-recover).
 */
export function decideNearYouManifestActivation({
  previousManifest = null,
  candidateManifest = null,
  residentialPlaces = [],
  lenses = LENSES,
  publishedSliceKeys = null,
} = {}) {
  if (!candidateManifest || typeof candidateManifest !== "object" || Array.isArray(candidateManifest)) {
    return {
      activate: false,
      reason: "stale_or_invalid_manifest",
      missing: [],
      activeManifest: previousManifest,
    };
  }
  if (Number(candidateManifest.schema_version) !== 1 || candidateManifest.kind !== "near-you"
    || !candidateManifest.version || !candidateManifest.slices) {
    return {
      activate: false,
      reason: "stale_or_invalid_manifest",
      missing: [],
      activeManifest: previousManifest,
    };
  }
  const completeness = validateNearYouManifestCompleteness(candidateManifest, residentialPlaces, lenses);
  if (!completeness.ok) {
    return {
      activate: false,
      reason: "incomplete_manifest",
      missing: completeness.missing,
      activeManifest: previousManifest,
    };
  }
  if (publishedSliceKeys) {
    const keys = publishedSliceKeys instanceof Set ? publishedSliceKeys : new Set(publishedSliceKeys);
    const unpublished = requiredNearYouSliceIds(residentialPlaces, lenses).filter((sliceId) => {
      const key = candidateManifest.slices[sliceId];
      return !key || !keys.has(key);
    });
    if (unpublished.length) {
      return {
        activate: false,
        reason: "partial_publication",
        missing: unpublished,
        activeManifest: previousManifest,
      };
    }
  }
  return {
    activate: true,
    reason: "complete",
    missing: [],
    activeManifest: candidateManifest,
  };
}

/**
 * Parcel membership, record-assertion, and shared meeting source generations
 * that a local/meeting publication must name. Absent generations refuse
 * activation — readers never follow a generation that cannot prove its inputs.
 */
export function localGeographyPublicationDependencies({
  parcelManifest = null,
  meetingGeographyPointer = null,
  sharedMeetingModel = null,
} = {}) {
  return {
    parcel_membership_generation: parcelManifest?.membership?.generated_at
      || parcelManifest?.memberships?.generated_at
      || null,
    parcel_coordinate_vintage: parcelManifest?.coordinate_vintage || null,
    assertion_generation: meetingGeographyPointer?.active_generation || null,
    source_generation: sharedMeetingModel?.generated_at || null,
  };
}

export function loadLocalGeographyPublicationDependencies(root = ROOT) {
  const parcelPath = join(root, "site/data/parcel-geography/manifest.json");
  const activePath = join(root, "site/data/meeting-geography-backfill/ACTIVE");
  const meetingsPath = join(root, "site/data/shared_meeting_read_model.json");
  return localGeographyPublicationDependencies({
    parcelManifest: existsSync(parcelPath) ? readJson(parcelPath) : null,
    meetingGeographyPointer: existsSync(activePath) ? readJson(activePath) : null,
    sharedMeetingModel: existsSync(meetingsPath) ? readJson(meetingsPath) : null,
  });
}

export function validateLocalGeographyPublicationDependencies(dependencies = {}) {
  const missing = [];
  if (!dependencies?.parcel_membership_generation) missing.push("parcel_membership_generation");
  if (!dependencies?.parcel_coordinate_vintage) missing.push("parcel_coordinate_vintage");
  if (!dependencies?.assertion_generation) missing.push("assertion_generation");
  if (!dependencies?.source_generation) missing.push("source_generation");
  return { ok: missing.length === 0, missing };
}

/**
 * Near You list rows that open a canonical /meetings/ detail carry the full
 * meeting: identity (or an encoded /meetings/ route). Notice-hash destinations
 * are not meeting-detail completeness subjects.
 */
export function canonicalMeetingDetailIdFromNearYouRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const id = String(record.id || record.meeting_id || "").trim();
  if (id.startsWith("meeting:")) return id;
  const route = String(record.route || "");
  const match = route.match(/^\/meetings\/([^/?#]+)/);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded.startsWith("meeting:") ? decoded : null;
  } catch {
    return null;
  }
}

export function collectEmittedMeetingDetailIds(nearYou) {
  const ids = new Set();
  const entriesByKey = new Map((nearYou?.entries || []).map((entry) => [entry.key, entry.value]));
  for (const [sliceId, key] of Object.entries(nearYou?.manifest?.slices || {})) {
    if (!String(sliceId).endsWith(":meetings")) continue;
    const raw = entriesByKey.get(key);
    if (!raw) continue;
    const slice = typeof raw === "string" ? JSON.parse(raw) : raw;
    for (const record of Object.values(slice?.activity?.records?.meetings || {})) {
      const meetingId = canonicalMeetingDetailIdFromNearYouRecord(record);
      if (meetingId) ids.add(meetingId);
    }
  }
  return [...ids].sort();
}

/**
 * Every emitted meeting-detail destination must exist in the staged meetings
 * id_to_slice map and in that slice's row population (E17).
 */
export function validateMeetingDetailCompleteness({ nearYou = null, meetings = null } = {}) {
  const emitted = collectEmittedMeetingDetailIds(nearYou);
  const idToSlice = meetings?.manifest?.id_to_slice || {};
  const entriesByKey = new Map((meetings?.entries || []).map((entry) => [entry.key, entry.value]));
  const missing = [];
  for (const meetingId of emitted) {
    const key = idToSlice[meetingId];
    if (!key) {
      missing.push(meetingId);
      continue;
    }
    const raw = entriesByKey.get(key);
    if (!raw) {
      missing.push(meetingId);
      continue;
    }
    const slice = typeof raw === "string" ? JSON.parse(raw) : raw;
    const present = (slice?.rows || []).some((row) => row?.meeting_id === meetingId);
    if (!present) missing.push(meetingId);
  }
  return {
    ok: missing.length === 0,
    emitted: emitted.length,
    missing,
  };
}

function withPublicationDependencies(manifest, dependencies) {
  return {
    ...manifest,
    publication_dependencies: {
      parcel_membership_generation: dependencies?.parcel_membership_generation || null,
      parcel_coordinate_vintage: dependencies?.parcel_coordinate_vintage || null,
      assertion_generation: dependencies?.assertion_generation || null,
      source_generation: dependencies?.source_generation || null,
    },
  };
}

/**
 * Activate Near You and meeting manifests together. Incomplete meeting details,
 * missing geography dependencies, or partial shard publication leave the prior
 * generation active (atomic activation).
 */
export function decideLocalGeographyPublicationActivation({
  previous = null,
  candidate = null,
  residentialPlaces = [],
  lenses = LENSES,
  dependencies = null,
  publishedSliceKeys = null,
} = {}) {
  const previousActive = {
    nearYouManifest: previous?.nearYouManifest || null,
    meetingsManifest: previous?.meetingsManifest || null,
  };
  const refuse = (reason, missing = []) => ({
    activate: false,
    reason,
    missing,
    active: previousActive,
  });

  if (!candidate?.nearYouManifest || !candidate?.meetingsManifest) {
    return refuse("stale_or_invalid_manifest");
  }

  const dependencyCheck = validateLocalGeographyPublicationDependencies(
    dependencies || candidate.nearYouManifest.publication_dependencies,
  );
  if (!dependencyCheck.ok) {
    return refuse("missing_publication_dependencies", dependencyCheck.missing);
  }

  const nearDecision = decideNearYouManifestActivation({
    previousManifest: previousActive.nearYouManifest,
    candidateManifest: candidate.nearYouManifest,
    residentialPlaces,
    lenses,
    publishedSliceKeys,
  });
  if (!nearDecision.activate) {
    return refuse(nearDecision.reason, nearDecision.missing || []);
  }

  const meetingsManifest = candidate.meetingsManifest;
  if (Number(meetingsManifest.schema_version) !== 1 || meetingsManifest.kind !== "meetings"
    || !meetingsManifest.version || !meetingsManifest.id_to_slice) {
    return refuse("stale_or_invalid_manifest");
  }

  const detailCompleteness = validateMeetingDetailCompleteness({
    nearYou: {
      manifest: candidate.nearYouManifest,
      entries: candidate.nearYouEntries || [],
    },
    meetings: {
      manifest: meetingsManifest,
      entries: candidate.meetingsEntries || [],
    },
  });
  if (!detailCompleteness.ok) {
    return refuse("incomplete_meeting_details", detailCompleteness.missing);
  }

  if (publishedSliceKeys) {
    const keys = publishedSliceKeys instanceof Set ? publishedSliceKeys : new Set(publishedSliceKeys);
    const unpublishedMeetings = Object.values(meetingsManifest.id_to_slice || {})
      .filter((key) => key && !keys.has(key));
    if (unpublishedMeetings.length) {
      return refuse("partial_publication", unpublishedMeetings.slice(0, 20));
    }
  }

  return {
    activate: true,
    reason: "complete",
    missing: [],
    active: {
      nearYouManifest: candidate.nearYouManifest,
      meetingsManifest,
    },
  };
}

/**
 * Build Near You + meeting slices for one version, stamp shared publication
 * dependencies, and decide atomic activation against an optional previous pair.
 */
export function buildLocalGeographyPublication({
  activity,
  geography = {},
  meetings,
  version,
  residentialPlaces = [],
  dependencies = null,
  previous = null,
  publishedSliceKeys = null,
} = {}) {
  const deps = dependencies || localGeographyPublicationDependencies({
    sharedMeetingModel: meetings,
  });
  const nearYou = buildNearYou(activity, geography, version, { residentialPlaces });
  const meetingBuilt = buildMeetings(meetings, version);
  nearYou.manifest = withPublicationDependencies(nearYou.manifest, deps);
  meetingBuilt.manifest = withPublicationDependencies(meetingBuilt.manifest, deps);
  const activation = decideLocalGeographyPublicationActivation({
    previous,
    candidate: {
      nearYouManifest: nearYou.manifest,
      meetingsManifest: meetingBuilt.manifest,
      nearYouEntries: nearYou.entries,
      meetingsEntries: meetingBuilt.entries,
    },
    residentialPlaces,
    dependencies: deps,
    publishedSliceKeys,
  });
  return {
    version,
    dependencies: deps,
    nearYou,
    meetings: meetingBuilt,
    activation,
  };
}

function activityWithResidentialDefinitions(activity, residentialPlaces = []) {
  const definitions = { ...(activity?.geography_items?.definitions || {}) };
  for (const place of residentialPlaces) {
    if (definitions[place.key]) continue;
    definitions[place.key] = {
      key: place.key,
      type: place.type,
      id: place.id,
      label: place.label,
      class: place.class || "statistical",
      source_id: place.source_id || null,
      boundary_vintage: place.boundary_vintage || null,
    };
  }
  return {
    ...activity,
    geography_items: {
      ...(activity?.geography_items || {}),
      definitions,
      by_key: activity?.geography_items?.by_key || {},
    },
  };
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
    .filter(([key, lenses]) => lenses[lens].length
      || (key === id && Array.isArray(activity.geography_items?.by_key?.[key]?.[lens]))));
  // Keep only definitions needed for this slice. A selected geography keeps its
  // definition even when source coverage is unpublished (no fabricated by_key).
  const definitionKeys = new Set(Object.keys(geoMembership));
  if (String(id).startsWith("geography:") && activity.geography_items?.definitions?.[id]) {
    definitionKeys.add(id);
  }
  const definitions = Object.fromEntries([...definitionKeys]
    .map((key) => [key, activity.geography_items?.definitions?.[key]])
    .filter(([, definition]) => definition));
  const geographyItems = {
    schema: activity.geography_items?.schema,
    built_at: activity.geography_items?.built_at,
    lenses: [lens],
    public_types: activity.geography_items?.public_types,
    definitions,
    by_key: geoMembership,
    note: activity.geography_items?.note,
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

export function communityGeographySlice(geography, id) {
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
    nodes: (geography.nodes || []).filter((node) => refs.has(node.id)),
    public_edges: edges,
  };
}

export function buildNearYou(activity, geography, version, {
  residentialPlaces = [],
} = {}) {
  const sourceActivity = activityWithResidentialDefinitions(activity, residentialPlaces);
  const ids = [
    ...BOROUGHS.map((borough) => `borough:${borough}`),
    ...Object.keys(sourceActivity.district_items?.by_level?.community_district || {}).map((id) => `community-district:${id}`),
    ...Object.keys(sourceActivity.district_items?.by_level?.council_district || {}).map((id) => `council-district:${id}`),
    "citywide", "virtual", "unlocated",
    ...Object.keys(sourceActivity.geography_items?.definitions || {}),
    ...residentialPlaces.map((place) => place.key),
  ];
  const entries = [];
  const slices = {};
  const coverageBySlice = {};
  for (const id of [...new Set(ids)]) {
    for (const lens of LENSES) {
      const coverageState = placeCoverageState(sourceActivity, id, lens);
      const activitySlice = sliceActivity(sourceActivity, id, lens);
      const key = keyFor(version, "near-you", `${id}:${lens}`);
      const sliceId = `${id}:${lens}`;
      slices[sliceId] = key;
      coverageBySlice[sliceId] = coverageState;
      entries.push({ key, value: JSON.stringify({
        schema_version: 1,
        kind: "near-you",
        version,
        slice_id: id,
        lens,
        coverage: {
          state: coverageState,
          // source_unavailable means the place is published without observed
          // membership for this lens; it is not a fabricated zero.
        },
        activity: activitySlice,
        community_geography: communityGeographySlice(geography, id),
      }) });
    }
  }
  return {
    entries,
    manifest: {
      schema_version: 1,
      kind: "near-you",
      version,
      source_schema: activity.schema,
      slices,
      residential_place_count: residentialPlaces.length,
      coverage_census: {
        ready: Object.values(coverageBySlice).filter((state) => state === "ready").length,
        zero: Object.values(coverageBySlice).filter((state) => state === "zero").length,
        source_unavailable: Object.values(coverageBySlice).filter((state) => state === "source_unavailable").length,
      },
    },
    residentialPlaces,
    coverageBySlice,
  };
}

function buildCommunityDistrictDigests(digest, version) {
  if (!digest) {
    return { entries: [], manifest: { schema_version: 1, kind: "community-district-digest", version, source_schema: null, slices: {} } };
  }
  const entries = [];
  const slices = {};
  for (const id of Object.keys(digest.by_community_district || {}).sort()) {
    const key = keyFor(version, "community-district-digest", id);
    slices[id] = key;
    entries.push({ key, value: JSON.stringify({
      schema_version: 1, kind: "community-district-digest", version, slice_id: id,
      digest: { ...digest, by_community_district: { [id]: digest.by_community_district[id] } },
    }) });
  }
  return { entries, manifest: { schema_version: 1, kind: "community-district-digest", version, source_schema: digest.schema, slices } };
}

/**
 * The vintage envelope a reader needs to answer for one meeting served from
 * these slices: the source model's schema, its generated_at, its freshness
 * block and its per-source coverage. `board_coverage` is deliberately dropped —
 * it is a per-board table of the whole corpus, it dwarfs the rest of the
 * manifest, and it says nothing about the single meeting a reader asked for.
 */
function readModelEnvelope(meetings) {
  const sources = {};
  for (const [name, envelope] of Object.entries(meetings.sources || {})) {
    const { board_coverage: _boardCoverage, ...rest } = envelope || {};
    sources[name] = rest;
  }
  return {
    schema: meetings.schema || null,
    generated_at: meetings.generated_at || null,
    freshness: meetings.freshness || null,
    sources,
  };
}

// A meeting the source publishes without an event date has no month to browse
// under, but it still has an exact identity a reader can ask for. It is
// published in its own slice, which is reachable through `id_to_slice` and
// deliberately absent from `slices`, so month browsing sees exactly what it saw
// before while an exact lookup can still reach every committed meeting.
const UNDATED_MEETING_SLICE = "undated";

export function buildMeetings(meetings, version) {
  const grouped = new Map();
  const idToSlice = {};
  for (const row of meetings.rows || []) {
    if (!row?.meeting_id) continue;
    const month = String(row.event_date || "").slice(0, 7);
    const bucket = /^\d{4}-\d{2}$/.test(month) ? month : UNDATED_MEETING_SLICE;
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket).push(row);
  }
  const entries = [];
  const slices = {};
  for (const [month, rows] of grouped) {
    const key = keyFor(version, "meetings", month);
    if (month !== UNDATED_MEETING_SLICE) slices[month] = key;
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
      read_model: readModelEnvelope(meetings),
      slices,
      id_to_slice: idToSlice,
      canary_meeting_id: canary?.meeting_id || null,
    },
  };
}

function assertCanaries(out, residentialPlaces = []) {
  const near = readJson(join(out, "near-you.manifest.json"));
  const meetings = readJson(join(out, "meetings.manifest.json"));
  for (const id of ["borough:Queens:meetings", "community-district:M07:meetings"]) {
    if (!near.slices[id]) throw new Error(`Near You canary key missing: ${id}`);
  }
  if (!meetings.canary_meeting_id || !meetings.id_to_slice[meetings.canary_meeting_id]) {
    throw new Error("meeting canary is missing from the versioned manifest");
  }
  const completeness = validateNearYouManifestCompleteness(near, residentialPlaces);
  if (!completeness.ok) {
    throw new Error(`Near You residential manifest incomplete: missing ${completeness.missing.slice(0, 5).join(", ")}${completeness.missing.length > 5 ? "…" : ""}`);
  }
  const nearEntries = new Map(readJson(join(out, "near-you.bulk.json")).map((entry) => [entry.key, JSON.parse(entry.value)]));
  for (const id of ["borough:Queens:meetings", "community-district:M07:meetings"]) {
    const slice = nearEntries.get(near.slices[id]);
    if (!slice?.activity?.records?.meetings || Object.keys(slice.activity.records.meetings).length === 0) {
      throw new Error(`Near You canary is empty: ${id}`);
    }
  }
  for (const fixture of ["geography:nta2020:BK0101:meetings", "geography:nta2020:QN0103:meetings", "geography:nta2020:SI0101:meetings"]) {
    const key = near.slices[fixture];
    if (!key) throw new Error(`Near You residential fixture missing: ${fixture}`);
    const slice = nearEntries.get(key);
    if (!slice?.coverage?.state) throw new Error(`Near You residential fixture lacks coverage: ${fixture}`);
    if (slice.coverage.state === "zero") {
      throw new Error(`Near You residential fixture fabricated a zero: ${fixture}`);
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
  const dependencies = loadLocalGeographyPublicationDependencies(ROOT);
  const version = arg("--version", null) || hashInputs(dependencies);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const activity = readJson(resolveActivityPath());
  const meetings = readJson(PATHS.meetings);
  const geography = readJson(PATHS.geography);
  const communityDigest = existsSync(PATHS.communityDigest) ? readJson(PATHS.communityDigest) : null;
  if (!existsSync(PATHS.ntaLayer)) {
    throw new Error(`canonical NTA layer missing: ${PATHS.ntaLayer}`);
  }
  const residentialPlaces = residentialPlacesFromNtaLayer(readJson(PATHS.ntaLayer));
  if (!residentialPlaces.length) {
    throw new Error("canonical residential NTA registry is empty");
  }
  const publication = buildLocalGeographyPublication({
    activity,
    geography,
    meetings,
    version,
    residentialPlaces,
    dependencies,
  });
  if (!publication.activation.activate) {
    throw new Error(
      `local geography publication refused activation (${publication.activation.reason}`
      + `${publication.activation.missing?.length ? `: ${publication.activation.missing.slice(0, 5).join(", ")}` : ""})`,
    );
  }
  const near = publication.nearYou;
  const meeting = publication.meetings;
  const community = buildCommunityDistrictDigests(communityDigest, version);
  writeFileSync(join(out, "near-you.bulk.json"), JSON.stringify(near.entries));
  writeFileSync(join(out, "community-district-digest.bulk.json"), JSON.stringify(community.entries));
  writeFileSync(join(out, "meetings.bulk.json"), JSON.stringify(meeting.entries));
  writeBulkChunks(out, "near-you", near.entries);
  writeBulkChunks(out, "meetings", meeting.entries);
  writeFileSync(join(out, "near-you.manifest.json"), JSON.stringify(near.manifest, null, 2));
  writeFileSync(join(out, "community-district-digest.manifest.json"), JSON.stringify(community.manifest, null, 2));
  writeFileSync(join(out, "meetings.manifest.json"), JSON.stringify(meeting.manifest, null, 2));
  writeFileSync(join(out, "route-read-model-receipt.json"), JSON.stringify({
    schema_version: 1, version, generated_at: new Date().toISOString(),
    near_you_slice_count: near.entries.length,
    community_district_digest_slice_count: community.entries.length,
    meeting_slice_count: meeting.entries.length,
    residential_place_count: residentialPlaces.length,
    coverage_census: near.manifest.coverage_census,
    publication_dependencies: dependencies,
  }, null, 2));
  assertCanaries(out, residentialPlaces);
  if (check) console.log(`route read-model canaries passed (${version})`);
  else console.log(`built ${near.entries.length + community.entries.length + meeting.entries.length} route read-model slices (${version}; residential ${residentialPlaces.length})`);
}

// Importable so a test can exercise the published slice layout against the
// committed read model without running the whole build.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
