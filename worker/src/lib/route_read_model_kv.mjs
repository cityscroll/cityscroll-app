import { MEETING_ICS_FLOOR, MEETING_FLOOR_ROWS, NEAR_YOU_FLOOR } from "../data/route_read_model_floor.mjs";

export const ROUTE_READ_MODEL_SCHEMA_VERSION = 1;
export const NEAR_YOU_MANIFEST_KEY = "route-read-model:near-you:manifest:v1";
export const MEETING_MANIFEST_KEY = "route-read-model:meetings:manifest:v1";
export const COMMUNITY_DISTRICT_DIGEST_MANIFEST_KEY = "route-read-model:community-district-digest:manifest:v1";
export const ROUTE_READ_MODEL_TIMEOUT_MS = 5_000;

const cacheByKv = new WeakMap();
const boroughNames = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];

class RouteReadModelUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteReadModelUnavailable";
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
      timer = setTimeout(() => reject(new RouteReadModelUnavailable(`route read-model read exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    const value = await Promise.race([read, timeout]).then((raw) => {
      if (raw == null || raw === "") throw new RouteReadModelUnavailable(`missing route read-model key ${key}`);
      try {
        const value = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        return value;
      } catch (error) {
        throw new RouteReadModelUnavailable(`invalid route read-model key ${key}: ${error.message}`);
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
    const manifest = await getJson(kv, key, state, timeoutMs).then((manifest) => {
      if (Number(manifest.schema_version) !== ROUTE_READ_MODEL_SCHEMA_VERSION
        || manifest.kind !== kind || !manifest.version || !manifest.slices) {
        state.values.delete(key);
        throw new RouteReadModelUnavailable(`invalid ${kind} route read-model manifest`);
      }
      return manifest;
    });
    state.manifests.set(kind, manifest);
  }
  return state.manifests.get(kind);
}

function nearYouSliceIds(scope) {
  const place = scope?.place || {};
  let primary;
  if (Array.isArray(place.geographies) && place.geographies.length) primary = place.geographies;
  else if (place.location_scope) primary = [place.location_scope];
  else if (place.council_districts?.length) primary = [`council-district:${place.council_districts[0]}`];
  else if (place.community_districts?.length) primary = [`community-district:${place.community_districts[0]}`];
  else if (place.boroughs?.length) primary = [`borough:${place.boroughs[0]}`];
  else primary = boroughNames.map((name) => `borough:${name}`);
  const special = ["citywide", "virtual", "unlocated"];
  return [...new Set([...primary, ...special])];
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

function mergeActivity(slices) {
  const first = slices[0] || NEAR_YOU_FLOOR;
  const out = {
    ...first,
    by_level: { borough: {}, community_district: {}, council_district: {} },
    citywide: {}, virtual: {}, unlocated: {},
    district_items: { by_level: { borough: {}, community_district: {}, council_district: {} }, citywide: {}, virtual: {}, unlocated: {} },
    geography_items: { ...(first.geography_items || {}), definitions: {}, by_key: {} },
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
      const dest = out.geography_items.by_key[key] ||= {};
      for (const [lens, ids] of Object.entries(lenses || {})) dest[lens] = mergeArrays(dest[lens], ids);
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

export async function loadNearYouActivity(env, scope, lens = scope?.facets?.domains?.[0] || "meetings") {
  if (missingBinding(env)) return { activity: NEAR_YOU_FLOOR, communityGeography: {} };
  const kv = env.ALERT_STATE;
  const configuredTimeout = Number(env.NEAR_YOU_READ_MODEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : ROUTE_READ_MODEL_TIMEOUT_MS;
  const manifest = await manifestFor(kv, "near-you", timeoutMs);
  const ids = nearYouSliceIds(scope);
  const sliceLens = ["land", "property", "rules", "meetings", "money"].includes(lens) ? lens : "meetings";
  const state = stateFor(kv);
  const keys = ids.map((id) => {
    const key = sliceKey(manifest, id, sliceLens);
    if (!key) throw new RouteReadModelUnavailable(`missing near-you slice ${id}:${sliceLens}`);
    return key;
  });
  // Deduplicate only within this request, never by sharing active I/O across
  // requests. Validate every key first so missing coverage starts no reads.
  const reads = new Map([...new Set(keys)].map((key) => [key, getJson(kv, key, state, timeoutMs)]));
  const slices = await Promise.all(keys.map((key) => reads.get(key)));
  if (!slices.length || slices.some((slice) => !slice.activity?.records)) {
    throw new RouteReadModelUnavailable("near-you slice is empty");
  }
  return {
    activity: mergeActivity(slices.map((slice) => slice.activity || slice)),
    communityGeography: slices.find((slice) => slice.community_geography)?.community_geography || {},
    version: manifest.version,
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
