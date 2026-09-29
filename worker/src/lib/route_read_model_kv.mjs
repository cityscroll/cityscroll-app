import { MEETING_ICS_FLOOR, MEETING_FLOOR_ROWS, NEAR_YOU_FLOOR } from "../data/route_read_model_floor.mjs";

export const ROUTE_READ_MODEL_SCHEMA_VERSION = 1;
export const NEAR_YOU_MANIFEST_KEY = "route-read-model:near-you:manifest:v1";
export const MEETING_MANIFEST_KEY = "route-read-model:meetings:manifest:v1";
export const COMMUNITY_DISTRICT_DIGEST_MANIFEST_KEY = "route-read-model:community-district-digest:manifest:v1";
export const ROUTE_READ_MODEL_TIMEOUT_MS = 5_000;

const cacheByKv = new WeakMap();
const boroughNames = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];

/**
 * Typed internal causes for an unreadable route read model. They stay internal
 * (tests, logs and the section envelope's `cause` token); resident copy only
 * states the consequence and a recovery.
 */
export const ROUTE_READ_MODEL_CAUSES = Object.freeze({
  manifestMissing: "manifest_missing",
  manifestInvalid: "manifest_invalid",
  unknownGeography: "unknown_geography",
  missing: "missing_slice",
  malformed: "malformed_slice",
  timeout: "timeout",
  readFailed: "read_failed",
});

class RouteReadModelUnavailable extends Error {
  constructor(message, cause = ROUTE_READ_MODEL_CAUSES.readFailed) {
    super(message);
    this.name = "RouteReadModelUnavailable";
    this.reason = cause;
  }
}

function stateFor(kv) {
  let state = cacheByKv.get(kv);
  if (!state) {
    state = { manifests: new Map(), values: new Map() };
    cacheByKv.set(kv, state);
  }
  return state;
}

async function getJson(kv, key, state, timeoutMs = ROUTE_READ_MODEL_TIMEOUT_MS) {
  if (!state.values.has(key)) {
    const read = Promise.resolve().then(() => kv.get(key));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RouteReadModelUnavailable(
        `route read-model read exceeded ${timeoutMs}ms`,
        ROUTE_READ_MODEL_CAUSES.timeout,
      )), timeoutMs);
    });
    const value = await Promise.race([read, timeout]).then((raw) => {
      if (raw == null || raw === "") {
        throw new RouteReadModelUnavailable(`missing route read-model key ${key}`, ROUTE_READ_MODEL_CAUSES.missing);
      }
      try {
        const value = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        return value;
      } catch (error) {
        throw new RouteReadModelUnavailable(
          `invalid route read-model key ${key}: ${error.message}`,
          ROUTE_READ_MODEL_CAUSES.malformed,
        );
      }
    }).finally(() => {
      clearTimeout(timer);
    });
    // Only completed data may outlive a request. A pending KV read and its
    // timeout belong to the request that created them and can be cancelled
    // when that request ends (including an early unavailable-coverage reply).
    state.values.set(key, value);
  }
  return state.values.get(key);
}

async function manifestFor(kv, kind, timeoutMs = ROUTE_READ_MODEL_TIMEOUT_MS) {
  const state = stateFor(kv);
  if (!state.manifests.has(kind)) {
    const key = kind === "near-you"
      ? NEAR_YOU_MANIFEST_KEY
      : kind === "community-district-digest"
        ? COMMUNITY_DISTRICT_DIGEST_MANIFEST_KEY
        : MEETING_MANIFEST_KEY;
    const manifest = await getJson(kv, key, state, timeoutMs).catch((error) => {
      if (!(error instanceof RouteReadModelUnavailable)) throw error;
      if (error.reason === ROUTE_READ_MODEL_CAUSES.missing) error.reason = ROUTE_READ_MODEL_CAUSES.manifestMissing;
      if (error.reason === ROUTE_READ_MODEL_CAUSES.malformed) error.reason = ROUTE_READ_MODEL_CAUSES.manifestInvalid;
      throw error;
    }).then((manifest) => {
      if (Number(manifest.schema_version) !== ROUTE_READ_MODEL_SCHEMA_VERSION
        || manifest.kind !== kind || !manifest.version || !manifest.slices) {
        state.values.delete(key);
        throw new RouteReadModelUnavailable(`invalid ${kind} route read-model manifest`, ROUTE_READ_MODEL_CAUSES.manifestInvalid);
      }
      return manifest;
    });
    state.manifests.set(kind, manifest);
  }
  return state.manifests.get(kind);
}

/** The special buckets, each an independently loaded Near You section. */
const NEAR_YOU_SPECIAL_SECTIONS = Object.freeze(["citywide", "virtual", "unlocated"]);

/**
 * The slice reads one Near You request needs, partitioned into sections: the
 * requested (primary) scope and each special bucket. A requested
 * location_scope bucket is the primary scope for that request, so its failure
 * is a requested-results failure even though the same read also feeds that
 * bucket's section.
 */
function nearYouSectionPlan(scope) {
  const place = scope?.place || {};
  let primary;
  if (Array.isArray(place.geographies) && place.geographies.length) primary = place.geographies;
  else if (place.location_scope) primary = [place.location_scope];
  else if (place.council_districts?.length) primary = [`council-district:${place.council_districts[0]}`];
  else if (place.community_districts?.length) primary = [`community-district:${place.community_districts[0]}`];
  else if (place.boroughs?.length) primary = [`borough:${place.boroughs[0]}`];
  else primary = boroughNames.map((name) => `borough:${name}`);
  return {
    primary: [...new Set(primary)],
    ...Object.fromEntries(NEAR_YOU_SPECIAL_SECTIONS.map((bucket) => [bucket, [bucket]])),
  };
}

function nearYouSliceIds(scope) {
  return [...new Set(Object.values(nearYouSectionPlan(scope)).flat())];
}

function sliceKey(manifest, id, lens) {
  return manifest.slices[`${id}:${lens}`] || manifest.slices[id]?.[lens] || null;
}

function mergeArrays(left, right) {
  return [...new Set([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])])].sort();
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) target[key] = (Number(target[key]) || 0) + (Number(value) || 0);
  return target;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const COVERAGE_CONFLICT_REASON = "slice_coverage_conflict";

/**
 * Coverage metadata for one same-lens request. Equal metadata is shared, never
 * added. Slices that disagree (a different generation, source date, or status)
 * cannot be combined, so the merged index is typed unavailable for the lenses
 * involved rather than inheriting whichever slice happened to load first. A
 * legacy slice that published no coverage contributes none; when no slice
 * carries coverage the result has none, preserving legacy membership semantics.
 */
function mergeCoverage(slices) {
  const published = slices
    .map((slice) => slice?.geography_items?.coverage)
    .filter((coverage) => coverage && typeof coverage === "object");
  if (!published.length) return undefined;
  const distinct = new Set(published.map(canonicalJson));
  if (distinct.size === 1) return published[0];
  const lenses = [...new Set(published.flatMap((coverage) => Object.keys(coverage.by_lens || {})))].sort();
  const unavailable = { status: "unavailable", reason: COVERAGE_CONFLICT_REASON };
  return {
    ...unavailable,
    by_lens: Object.fromEntries(lenses.map((lens) => [lens, { ...unavailable }])),
  };
}

function mergeActivity(slices) {
  const first = slices[0] || NEAR_YOU_FLOOR;
  const { coverage: _firstCoverage, ...firstGeographyItems } = first.geography_items || {};
  const coverage = mergeCoverage(slices);
  const out = {
    ...first,
    by_level: { borough: {}, community_district: {}, council_district: {} },
    citywide: {}, virtual: {}, unlocated: {},
    district_items: { by_level: { borough: {}, community_district: {}, council_district: {} }, citywide: {}, virtual: {}, unlocated: {} },
    geography_items: {
      ...firstGeographyItems,
      ...(coverage ? { coverage } : {}),
      definitions: {},
      by_key: {},
    },
    records: {},
  };
  for (const slice of slices) {
    for (const level of Object.keys(out.by_level)) {
      for (const [id, counts] of Object.entries(slice.by_level?.[level] || {})) {
        out.by_level[level][id] = mergeCounts(out.by_level[level][id] || {}, counts);
      }
      for (const [id, lenses] of Object.entries(slice.district_items?.by_level?.[level] || {})) {
        const dest = out.district_items.by_level[level][id] ||= {};
        for (const [lens, ids] of Object.entries(lenses || {})) dest[lens] = mergeArrays(dest[lens], ids);
      }
    }
    for (const bucket of ["citywide", "virtual", "unlocated"]) {
      out[bucket] = mergeCounts(out[bucket], slice[bucket]);
      for (const [lens, ids] of Object.entries(slice.district_items?.[bucket] || {})) {
        out.district_items[bucket][lens] = mergeArrays(out.district_items[bucket][lens], ids);
      }
    }
    for (const [lens, rows] of Object.entries(slice.records || {})) out.records[lens] = { ...(out.records[lens] || {}), ...rows };
    for (const [key, definition] of Object.entries(slice.geography_items?.definitions || {})) out.geography_items.definitions[key] = definition;
    for (const [key, lenses] of Object.entries(slice.geography_items?.by_key || {})) {
      // An entry without the lens stays unfilterable, and a non-list stays
      // incomplete: neither is widened into a list (or a zero) by merging.
      const dest = out.geography_items.by_key[key] ||= {};
      for (const [lens, ids] of Object.entries(lenses || {})) {
        dest[lens] = Array.isArray(ids) && dest[lens] !== null ? mergeArrays(dest[lens], ids) : null;
      }
    }
  }
  return out;
}

function missingBinding(env) {
  return !env?.ALERT_STATE || typeof env.ALERT_STATE.get !== "function";
}

/**
 * Broader-district meeting inputs for one selected NTA, from the material
 * crosswalk relations stamped on the near-you manifest at build time. Reads the
 * overlapping community districts' own published slices and nothing else; a
 * district whose slice cannot be read is skipped, and any failure resolves to
 * null so broader enrichment never replaces or blocks the exact result list.
 */
export async function loadBroaderDistrictActivity(env, selectedKey, lens = "meetings") {
  if (missingBinding(env)) return null;
  if (!String(selectedKey || "").startsWith("geography:nta2020:")) return null;
  if (String(lens) !== "meetings") return null;
  const kv = env.ALERT_STATE;
  const configuredTimeout = Number(env.NEAR_YOU_READ_MODEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : ROUTE_READ_MODEL_TIMEOUT_MS;
  const manifest = await manifestFor(kv, "near-you", timeoutMs);
  const relations = manifest.broader_districts?.[selectedKey];
  if (!Array.isArray(relations) || !relations.length) return null;
  const state = stateFor(kv);
  const loadedRelations = [];
  const slices = {};
  for (const relation of relations.slice(0, 3)) {
    const id = String(relation?.id || "");
    if (!id) continue;
    const sliceId = `community-district:${id}`;
    const key = sliceKey(manifest, sliceId, "meetings");
    if (!key) continue;
    try {
      const slice = await getJson(kv, key, state, timeoutMs);
      // E17 guard: no real records in the published slice, no preview group.
      if (!slice?.activity?.records?.meetings) continue;
      slices[sliceId] = slice.activity;
      loadedRelations.push({
        key: `geography:community_district:${id}`,
        id,
        pct_from: Number.isFinite(Number(relation.pct_from)) ? Number(relation.pct_from) : null,
      });
    } catch {
      // Broader-load failure must not fail the page or the exact list.
    }
  }
  if (!loadedRelations.length) return null;
  return { relations: loadedRelations, slices };
}

export function clearRouteReadModelCache() {
  // WeakMap entries are intentionally isolate-scoped and cannot be enumerated;
  // tests use fresh KV objects, matching a new isolate's cache.
}

/**
 * Load one Near You request from a single manifest version, one section at a
 * time. Each section (the requested scope and each special bucket) settles on
 * its own: a failed read marks only that section unavailable, with a typed
 * cause, and never discards another section's records. Only slices of sections
 * that loaded completely are merged, so a failed section contributes no IDs,
 * counts or coverage. A manifest that is missing or invalid still rejects, as
 * does a request in which no section loaded.
 *
 * Returns `sections`, one `{ state: "ready" | "unavailable", cause }` entry per
 * section, and `partial` when any section is unavailable.
 */
export async function loadNearYouActivity(env, scope, lens = scope?.facets?.domains?.[0] || "meetings") {
  if (missingBinding(env)) {
    return {
      activity: NEAR_YOU_FLOOR,
      communityGeography: {},
      sections: Object.fromEntries(["primary", ...NEAR_YOU_SPECIAL_SECTIONS].map((name) => [name, { state: "ready", cause: null }])),
      partial: false,
    };
  }
  const kv = env.ALERT_STATE;
  const configuredTimeout = Number(env.NEAR_YOU_READ_MODEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : ROUTE_READ_MODEL_TIMEOUT_MS;
  // A manifest the store could not return at all is still a typed Near You
  // read failure (503 with navigation), not an unhandled error.
  const manifest = await manifestFor(kv, "near-you", timeoutMs).catch((error) => {
    if (error instanceof RouteReadModelUnavailable) throw error;
    throw new RouteReadModelUnavailable("near-you route read-model manifest read failed", ROUTE_READ_MODEL_CAUSES.readFailed);
  });
  const plan = nearYouSectionPlan(scope);
  const sliceLens = ["land", "property", "rules", "meetings", "money"].includes(lens) ? lens : "meetings";
  const state = stateFor(kv);
  // One read per distinct slice key within this request, never shared with
  // another request's active I/O. An id the manifest does not publish starts
  // no read and is an unknown geography, not an empty result.
  const reads = new Map();
  const readFor = (id) => {
    const key = sliceKey(manifest, id, sliceLens);
    if (!key) {
      return Promise.resolve({ ok: false, cause: ROUTE_READ_MODEL_CAUSES.unknownGeography });
    }
    if (!reads.has(key)) {
      reads.set(key, getJson(kv, key, state, timeoutMs).then((slice) => (slice?.activity?.records
        ? { ok: true, slice }
        : { ok: false, cause: ROUTE_READ_MODEL_CAUSES.malformed }
      ), (error) => ({
        ok: false,
        cause: error instanceof RouteReadModelUnavailable ? error.reason : ROUTE_READ_MODEL_CAUSES.readFailed,
      })));
    }
    return reads.get(key);
  };
  const settled = await Promise.all(Object.entries(plan).map(async ([section, ids]) => {
    const outcomes = await Promise.all(ids.map(readFor));
    const failed = outcomes.find((outcome) => !outcome.ok);
    return [section, failed
      ? { state: "unavailable", cause: failed.cause, slices: [] }
      : { state: "ready", cause: null, slices: outcomes.map((outcome) => outcome.slice) }];
  }));
  const sections = Object.fromEntries(settled.map(([section, { state: sectionState, cause }]) => [
    section, { state: sectionState, cause },
  ]));
  const loaded = [...new Set(settled.flatMap(([, outcome]) => outcome.slices))];
  if (!loaded.length) {
    const error = new RouteReadModelUnavailable("no near-you section could be read", sections.primary.cause);
    error.sections = sections;
    throw error;
  }
  return {
    activity: mergeActivity(loaded.map((slice) => slice.activity || slice)),
    communityGeography: loaded.find((slice) => slice.community_geography)?.community_geography || {},
    version: manifest.version,
    sections,
    partial: Object.values(sections).some((section) => section.state !== "ready"),
  };
}

function monthRange(todayISO, endISO) {
  if (!endISO) return [];
  const start = String(todayISO || "").slice(0, 7);
  const end = String(endISO || todayISO || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start)) return [];
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = (/^\d{4}-\d{2}$/.test(end) ? end : start).split("-").map(Number);
  const out = [];
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m += 1) {
    if (m === 13) { y += 1; m = 1; }
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (out.length > 120) break;
  }
  return out;
}

export async function loadMeetingRows(env, { todayISO, endISO, communityBoard } = {}) {
  if (missingBinding(env)) return MEETING_FLOOR_ROWS;
  const manifest = await manifestFor(env.ALERT_STATE, "meetings");
  const months = monthRange(todayISO, endISO);
  const selected = months.length ? months : Object.keys(manifest.slices);
  const state = stateFor(env.ALERT_STATE);
  const rows = [];
  for (const month of selected) {
    const key = manifest.slices[month];
    if (!key) continue;
    const slice = await getJson(env.ALERT_STATE, key, state);
    rows.push(...(Array.isArray(slice.rows) ? slice.rows : []));
  }
  if (communityBoard) return rows.filter((row) => String(row.board_id || "") === String(communityBoard).replace(/^community-board:/, ""));
  return rows;
}

export async function loadMeetingRecord(env, meetingId) {
  if (missingBinding(env)) {
    if (MEETING_ICS_FLOOR.meeting_id === meetingId) return MEETING_ICS_FLOOR;
    return MEETING_FLOOR_ROWS.find((row) => row?.meeting_id === meetingId) || null;
  }
  const manifest = await manifestFor(env.ALERT_STATE, "meetings");
  const key = manifest.id_to_slice?.[meetingId];
  if (!key) return null;
  const slice = await getJson(env.ALERT_STATE, key, stateFor(env.ALERT_STATE));
  return (slice.rows || []).find((row) => row?.meeting_id === meetingId) || null;
}

/**
 * Load one materialized community-district digest slice by identity. The
 * request path never receives the full digest corpus: the manifest selects
 * the keyed slice and the isolate cache reuses it for subsequent reads.
 */
export async function loadCommunityDistrictDigest(env, district) {
  if (missingBinding(env)) return null;
  const id = String(district || "").toUpperCase();
  if (!/^[MXKQR](?:0[1-9]|1[0-8])$/.test(id)) return null;
  const manifest = await manifestFor(env.ALERT_STATE, "community-district-digest");
  const key = manifest.slices?.[id];
  if (!key) return null;
  const slice = await getJson(env.ALERT_STATE, key, stateFor(env.ALERT_STATE));
  if (slice.kind !== "community-district-digest" || slice.slice_id !== id) return null;
  return slice.digest?.by_community_district?.[id] || null;
}

/**
 * One meeting from the versioned route read model, shaped as a shared meeting
 * read model so the meeting capability can answer from it without a second
 * projection. The vintage travels on the manifest the deployment published; an
 * older manifest without that envelope yields a null generated_at rather than
 * borrowing an unrelated clock.
 */
export async function loadMeetingReadModelForId(env, meetingId) {
  if (missingBinding(env)) return null;
  const record = await loadMeetingRecord(env, meetingId);
  if (!record) return null;
  const manifest = await manifestFor(env.ALERT_STATE, "meetings");
  const envelope = manifest.read_model || {};
  const schema = envelope.schema || manifest.source_schema || null;
  if (!schema) return null;
  return {
    schema,
    version: ROUTE_READ_MODEL_SCHEMA_VERSION,
    generated_at: envelope.generated_at || null,
    freshness: envelope.freshness || null,
    sources: envelope.sources || null,
    route_read_model_version: manifest.version || null,
    rows: [record],
  };
}

export { RouteReadModelUnavailable, nearYouSliceIds };
