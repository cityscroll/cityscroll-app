/** Shared official MapPLUTO acquisition primitives.
 *
 * This is the one home for talking to the NYC DCP MapPLUTO FeatureServer and
 * for parsing the retained PLUTO CSV. The Land bounded-centroid builder
 * (tools/build_bbl_mappluto_centroids.mjs) and the citywide parcel-point
 * builder (tools/build_citywide_parcel_points.mjs) both consume it, so the
 * official acquisition is extended once rather than forked per consumer.
 *
 * Build-time only. Resident reads never touch these functions.
 */

import { normalizeBbl } from "../../site/bbl_mappluto_centroids.mjs";

export const MAPPLUTO_QUERY =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
export const MAPPLUTO_USER_AGENT = "cityscroll-bbl-mappluto-centroids/1.0";
/** ArcGIS object-ID batches stay at or below the documented transfer limit. */
export const ARCGIS_MAX_OBJECTIDS_PER_BATCH = 1000;
export const ARCGIS_MAX_RETRIES = 3;

export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Bounded BBL-IN chunk fetch for the Land compatibility projection.
 * Verbatim extraction of the original official acquisition path.
 * @param {string[]} bbls
 * @param {{ fetchImpl?: typeof fetch, endpoint?: string }} [opts]
 */
export async function fetchArcgisChunk(bbls, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const endpoint = opts.endpoint || MAPPLUTO_QUERY;
  const where = `BBL IN (${bbls.map((bbl) => String(Number(bbl))).join(",")})`;
  const url = new URL(endpoint);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "BBL,Latitude,Longitude");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("resultRecordCount", String(Math.max(bbls.length, 1)));
  url.searchParams.set("f", "json");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": MAPPLUTO_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`MapPLUTO ArcGIS HTTP ${response.status} for ${bbls.length} BBLs`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`MapPLUTO ArcGIS error: ${JSON.stringify(payload.error)}`);
  }
  const byBbl = Object.create(null);
  for (const feature of payload?.features || []) {
    const attrs = feature?.attributes || {};
    const bbl = normalizeBbl(attrs.BBL);
    const lat = Number(attrs.Latitude);
    const lon = Number(attrs.Longitude);
    if (!bbl || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    byBbl[bbl] = { lat, lon };
  }
  return byBbl;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enumerate every publisher object ID exactly once via returnIdsOnly.
 * @param {{ fetchImpl?: typeof fetch, endpoint?: string, retries?: number }} [opts]
 * @returns {Promise<number[]>}
 */
export async function enumerateArcgisObjectIds(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const endpoint = opts.endpoint || MAPPLUTO_QUERY;
  const retries = Number.isInteger(opts.retries) && opts.retries > 0 ? opts.retries : ARCGIS_MAX_RETRIES;
  const url = new URL(endpoint);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("returnIdsOnly", "true");
  url.searchParams.set("f", "json");
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": MAPPLUTO_USER_AGENT },
      });
      if (!response.ok) throw new Error(`MapPLUTO ArcGIS id enumeration HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(`MapPLUTO ArcGIS error: ${JSON.stringify(payload.error)}`);
      const ids = Array.isArray(payload?.objectIds) ? payload.objectIds.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) throw new Error("MapPLUTO ArcGIS id enumeration returned no object IDs");
      return ids;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(250 * attempt);
    }
  }
  throw new Error(`MapPLUTO ArcGIS id enumeration failed after ${retries} attempts: ${lastError?.message || lastError}`);
}

/**
 * Fetch one exact object-ID batch (at most 1000 ids) with completeness checks.
 * A truncated response page (exceededTransferLimit or a transport short-read)
 * is a hard error: an incomplete generation must never be activated.
 * @param {number[]} objectIds
 * @param {{ fetchImpl?: typeof fetch, endpoint?: string, retries?: number, delayMs?: number }} [opts]
 * @returns {Promise<{ rows: Array<{objectid:number,bbl:string,lat:number,lon:number}>, returned: number }>}
 */
export async function fetchArcgisObjectBatch(objectIds, opts = {}) {
  if (!Array.isArray(objectIds) || objectIds.length === 0) return { rows: [], returned: 0 };
  if (objectIds.length > ARCGIS_MAX_OBJECTIDS_PER_BATCH) {
    throw new Error(
      `MapPLUTO ArcGIS object-ID batch of ${objectIds.length} exceeds the ${ARCGIS_MAX_OBJECTIDS_PER_BATCH}-id transfer bound`,
    );
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const endpoint = opts.endpoint || MAPPLUTO_QUERY;
  const retries = Number.isInteger(opts.retries) && opts.retries > 0 ? opts.retries : ARCGIS_MAX_RETRIES;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 0;
  const url = new URL(endpoint);
  url.searchParams.set("objectIds", objectIds.join(","));
  url.searchParams.set("outFields", "OBJECTID,BBL,Latitude,Longitude");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": MAPPLUTO_USER_AGENT },
      });
      if (!response.ok) throw new Error(`MapPLUTO ArcGIS HTTP ${response.status} for ${objectIds.length} object IDs`);
      const payload = await response.json();
      if (payload?.error) throw new Error(`MapPLUTO ArcGIS error: ${JSON.stringify(payload.error)}`);
      if (payload?.exceededTransferLimit) {
        throw new Error(
          `MapPLUTO ArcGIS batch exceeded the transfer limit for ${objectIds.length} object IDs — truncated page refuses activation`,
        );
      }
      const features = Array.isArray(payload?.features) ? payload.features : null;
      if (!features) throw new Error("MapPLUTO ArcGIS batch response missing features array");
      // A short read below the requested page with no pagination cursor is a
      // truncated batch, not a population statement.
      if (features.length > objectIds.length) {
        throw new Error(
          `MapPLUTO ArcGIS batch returned ${features.length} features for ${objectIds.length} requested object IDs`,
        );
      }
      const rows = [];
      for (const feature of features) {
        const attrs = feature?.attributes || {};
        const objectid = Number(attrs.OBJECTID);
        if (!Number.isInteger(objectid)) throw new Error("MapPLUTO ArcGIS feature missing OBJECTID");
        rows.push({
          objectid,
          bbl: String(attrs.BBL ?? "").trim(),
          lat: attrs.Latitude,
          lon: attrs.Longitude,
        });
      }
      return { rows, returned: features.length };
    } catch (error) {
      lastError = error;
      // Truncation and conflict-class errors are not transient; only retry
      // transport failures. Retrying a truncated page would still truncate.
      if (!/exceeded the transfer limit|missing features array|returned \d+ features/i.test(String(error?.message))) {
        if (attempt < retries) {
          if (delayMs) await sleep(delayMs);
          continue;
        }
      }
      throw new Error(
        `MapPLUTO ArcGIS object-ID batch failed for ${objectIds.length} ids after ${attempt} attempt(s): ${lastError?.message || lastError}`,
      );
    }
  }
  throw new Error(`MapPLUTO ArcGIS object-ID batch failed: ${lastError?.message || lastError}`);
}
