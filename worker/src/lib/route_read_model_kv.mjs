import { MEETING_ICS_FLOOR, MEETING_FLOOR_ROWS, NEAR_YOU_FLOOR } from "../data/route_read_model_floor.mjs";

export const ROUTE_READ_MODEL_SCHEMA_VERSION = 1;
export const NEAR_YOU_MANIFEST_KEY = "route-read-model:near-you:manifest:v1";
export const MEETING_MANIFEST_KEY = "route-read-model:meetings:manifest:v1";

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

async function getJson(kv, key, state) {
  if (!state.values.has(key)) {
    const pending = Promise.resolve(kv.get(key)).then((raw) => {
      if (raw == null || raw === "") throw new RouteReadModelUnavailable(`missing route read-model key ${key}`);
      try {
        const value = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        return value;
      } catch (error) {
        throw new RouteReadModelUnavailable(`invalid route read-model key ${key}: ${error.message}`);
      }
    });
    state.values.set(key, pending);
  }
  return state.values.get(key);
}

async function manifestFor(kv, kind) {
  const state = stateFor(kv);
  if (!state.manifests.has(kind)) {
    const key = kind === "near-you" ? NEAR_YOU_MANIFEST_KEY : MEETING_MANIFEST_KEY;
    const pending = getJson(kv, key, state).then((manifest) => {
      if (Number(manifest.schema_version) !== ROUTE_READ_MODEL_SCHEMA_VERSION
        || manifest.kind !== kind || !manifest.version || !manifest.slices) {
        throw new RouteReadModelUnavailable(`invalid ${kind} route read-model manifest`);
      }
      return manifest;
    });
    state.manifests.set(kind, pending);
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

export function clearRouteReadModelCache() {
  // WeakMap entries are intentionally isolate-scoped and cannot be enumerated;
  // tests use fresh KV objects, matching a new isolate's cache.
}

export async function loadNearYouActivity(env, scope, lens = scope?.facets?.domains?.[0] || "meetings") {
  if (missingBinding(env)) return { activity: NEAR_YOU_FLOOR, communityGeography: {} };
  const kv = env.ALERT_STATE;
  const manifest = await manifestFor(kv, "near-you");
  const ids = nearYouSliceIds(scope);
  const sliceLens = ["land", "property", "rules", "meetings", "money"].includes(lens) ? lens : "meetings";
  const state = stateFor(kv);
  const slices = await Promise.all(ids.map(async (id) => {
    const key = sliceKey(manifest, id, sliceLens);
    if (!key) throw new RouteReadModelUnavailable(`missing near-you slice ${id}:${sliceLens}`);
    return getJson(kv, key, state);
  }));
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
  if (missingBinding(env)) return MEETING_ICS_FLOOR.meeting_id === meetingId ? MEETING_ICS_FLOOR : null;
  const manifest = await manifestFor(env.ALERT_STATE, "meetings");
  const key = manifest.id_to_slice?.[meetingId];
  if (!key) return null;
  const slice = await getJson(env.ALERT_STATE, key, stateFor(env.ALERT_STATE));
  return (slice.rows || []).find((row) => row?.meeting_id === meetingId) || null;
}

export { RouteReadModelUnavailable, nearYouSliceIds };
