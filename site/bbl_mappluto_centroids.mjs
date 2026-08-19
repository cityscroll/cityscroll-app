/**
 * Bounded BBL → MapPLUTO centroid lookup for Land map pins.
 *
 * Resident reads use the committed artifact only. MapPLUTO / ArcGIS stays on the
 * offline build path (CSV extract or batch FeatureServer query) — never the
 * resident hot path.
 */

export const BBL_MAPPLUTO_CENTROIDS_SCHEMA_VERSION = 1;
export const BBL_MAPPLUTO_CENTROIDS_SOURCE = "mappluto";
export const BBL_MAPPLUTO_CENTROIDS_ARTIFACT =
  "site/data/bbl_mappluto_centroids_lookup.json";
/** Align with MapPLUTO source-contract max_stale_days. */
export const BBL_MAPPLUTO_CENTROIDS_MAX_AGE_DAYS = 120;
/** Acceptance bar for sell-facing BBL coverage. */
export const BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE = 0.95;
/** Field canary from scout Gap 2 / PR #1057 upstream. */
export const BBL_MAPPLUTO_CENTROID_CANARIES = Object.freeze({
  "3012660036": "2026K0123",
  // Completed ELURP whose WH-06 lot is absent from the current sell-facing
  // warehouse; keep the MapPLUTO pin so permalinks do not fall through to
  // "Location not resolved" after /zap-outcomes KV drops the project.
  "5017800015": "2025R0257",
});
export const BBL_MAPPLUTO_CENTROIDS_MODES = Object.freeze([
  "mappluto_pluto_csv",
  "mappluto_arcgis_batch",
]);

export function normalizeBbl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length > 10) return digits.slice(-10);
  return digits.padStart(10, "0");
}

/**
 * Sell-facing project ids from the WH-05 ZAP projects warehouse lookup.
 * @param {object} projectsDoc
 * @returns {Set<string>}
 */
export function sellFacingProjectIds(projectsDoc) {
  const rows = Array.isArray(projectsDoc?.rows) ? projectsDoc.rows : [];
  const out = new Set();
  for (const row of rows) {
    const id = String(row?.project_id || "").trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Unique BBLs for sell-facing projects from WH-06 zap_bbl rows, plus canaries.
 * @param {object} bblDoc zap_bbl_warehouse_lookup.json
 * @param {Iterable<string>|Set<string>} projectIds
 * @param {{ includeCanaries?: boolean }} [opts]
 * @returns {{ bbls: string[], by_project: Record<string, string[]>, canary_bbls: string[] }}
 */
export function collectSellFacingBbls(bblDoc, projectIds, opts = {}) {
  const includeCanaries = opts.includeCanaries !== false;
  const wanted = projectIds instanceof Set ? projectIds : new Set(projectIds || []);
  const byProject = Object.create(null);
  const bblSet = new Set();
  const rows = Array.isArray(bblDoc?.rows) ? bblDoc.rows : [];
  for (const row of rows) {
    const projectId = String(row?.project_id || "").trim();
    if (!projectId || (wanted.size && !wanted.has(projectId))) continue;
    const list = [];
    for (const value of Array.isArray(row?.bbls) ? row.bbls : []) {
      const bbl = normalizeBbl(value);
      if (!bbl) continue;
      list.push(bbl);
      bblSet.add(bbl);
    }
    if (list.length) byProject[projectId] = list;
  }
  const canaryBbls = [];
  if (includeCanaries) {
    for (const bbl of Object.keys(BBL_MAPPLUTO_CENTROID_CANARIES)) {
      const normalized = normalizeBbl(bbl);
      if (!normalized) continue;
      canaryBbls.push(normalized);
      bblSet.add(normalized);
    }
  }
  return {
    bbls: [...bblSet].sort(),
    by_project: byProject,
    canary_bbls: canaryBbls,
  };
}

/**
 * @param {string} bbl
 * @param {{ lat: number, lon: number }} point
 * @returns {{ lat: number, lon: number }|null}
 */
export function centroidEntry(bbl, point) {
  const id = normalizeBbl(bbl);
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 40.4 || lat > 41.0 || lon < -74.4 || lon > -73.6) return null;
  return { lat, lon };
}

/**
 * Look up the first centroid hit for a list of BBLs.
 * @param {object|null|undefined} doc
 * @param {Iterable<string>} bbls
 * @returns {{ bbl: string, lat: number, lon: number }|null}
 */
export function lookupBblCentroid(doc, bbls) {
  const byBbl = doc?.by_bbl && typeof doc.by_bbl === "object" ? doc.by_bbl : null;
  if (!byBbl) return null;
  for (const value of bbls || []) {
    const bbl = normalizeBbl(value);
    if (!bbl) continue;
    const hit = byBbl[bbl];
    const lat = Number(hit?.lat);
    const lon = Number(hit?.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { bbl, lat, lon };
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {Record<string,{lat:number,lon:number}>} opts.byBbl
 * @param {string[]} opts.sellFacingBbls universe used for coverage denominator
 * @param {string} opts.mode
 * @param {string} [opts.materializedAt]
 * @param {object} [opts.source]
 * @returns {object}
 */
export function buildBblMapplutoCentroidsDoc(opts = {}) {
  const byBblIn = opts.byBbl && typeof opts.byBbl === "object" ? opts.byBbl : {};
  const by_bbl = Object.create(null);
  for (const [raw, point] of Object.entries(byBblIn)) {
    const entry = centroidEntry(raw, point);
    const bbl = normalizeBbl(raw);
    if (!entry || !bbl) continue;
    by_bbl[bbl] = entry;
  }
  const sellFacing = [...new Set((opts.sellFacingBbls || []).map(normalizeBbl).filter(Boolean))].sort();
  let matched = 0;
  for (const bbl of sellFacing) {
    if (by_bbl[bbl]) matched += 1;
  }
  const rate = sellFacing.length ? matched / sellFacing.length : 0;
  const canaries = Object.create(null);
  for (const [bbl, projectId] of Object.entries(BBL_MAPPLUTO_CENTROID_CANARIES)) {
    canaries[bbl] = {
      project_id: projectId,
      status: by_bbl[bbl] ? "matched" : "missing",
    };
  }
  return {
    schema_version: BBL_MAPPLUTO_CENTROIDS_SCHEMA_VERSION,
    source: BBL_MAPPLUTO_CENTROIDS_SOURCE,
    mode: String(opts.mode || ""),
    materialized_at: String(opts.materializedAt || new Date().toISOString()),
    max_age_days: BBL_MAPPLUTO_CENTROIDS_MAX_AGE_DAYS,
    replaces_live_fetch: {
      resident: "site/app/land.mjs#resolveLandMapLocation",
      description:
        "Committed MapPLUTO centroids for Land exact pins; no live ArcGIS on resident reads",
    },
    source_receipt: opts.source && typeof opts.source === "object" ? opts.source : null,
    coverage: {
      sell_facing_bbl_count: sellFacing.length,
      matched,
      rate: Number(rate.toFixed(6)),
      min_rate: BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE,
      canaries,
    },
    bbl_count: Object.keys(by_bbl).length,
    by_bbl,
  };
}

/**
 * Age + coverage + canary gate for the committed centroid serve.
 * @param {object} doc
 * @param {{ now?: Date|string|number }} [opts]
 * @returns {string[]}
 */
export function bblMapplutoCentroidsServeGateFindings(doc, opts = {}) {
  const findings = [];
  if (!doc || typeof doc !== "object") {
    findings.push("BBL MapPLUTO centroids serve document missing");
    return findings;
  }
  if (Number(doc.schema_version) !== BBL_MAPPLUTO_CENTROIDS_SCHEMA_VERSION) {
    findings.push(
      `BBL MapPLUTO centroids schema_version ${doc.schema_version} != ${BBL_MAPPLUTO_CENTROIDS_SCHEMA_VERSION}`,
    );
  }
  if (String(doc.source || "") !== BBL_MAPPLUTO_CENTROIDS_SOURCE) {
    findings.push(`BBL MapPLUTO centroids source ${JSON.stringify(doc.source)} != mappluto`);
  }
  const mode = String(doc.mode || "");
  if (!BBL_MAPPLUTO_CENTROIDS_MODES.includes(mode)) {
    findings.push(
      `BBL MapPLUTO centroids mode ${JSON.stringify(mode)} is not a retained MapPLUTO extract (${BBL_MAPPLUTO_CENTROIDS_MODES.join("|")})`,
    );
  }
  const byBbl = doc.by_bbl && typeof doc.by_bbl === "object" ? doc.by_bbl : null;
  const bblCount = byBbl ? Object.keys(byBbl).length : 0;
  if (!byBbl || bblCount === 0) {
    findings.push("BBL MapPLUTO centroids by_bbl is empty");
  }
  const coverage = doc.coverage || {};
  const rate = Number(coverage.rate);
  const sellFacingCount = Number(coverage.sell_facing_bbl_count);
  if (!Number.isFinite(sellFacingCount) || sellFacingCount <= 0) {
    findings.push("BBL MapPLUTO centroids coverage.sell_facing_bbl_count missing");
  }
  if (!Number.isFinite(rate) || rate < BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE) {
    findings.push(
      `BBL MapPLUTO centroids coverage rate ${rate} below floor ${BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE}`,
    );
  }
  for (const bbl of Object.keys(BBL_MAPPLUTO_CENTROID_CANARIES)) {
    const hit = byBbl?.[bbl];
    if (!hit || !Number.isFinite(Number(hit.lat)) || !Number.isFinite(Number(hit.lon))) {
      findings.push(`BBL MapPLUTO centroids missing canary BBL ${bbl}`);
    }
  }
  const stamped = doc.materialized_at ? Date.parse(String(doc.materialized_at)) : NaN;
  const nowMs = Date.parse(String(opts.now || new Date().toISOString()));
  const maxAge = Number.isFinite(Number(doc.max_age_days))
    ? Number(doc.max_age_days)
    : BBL_MAPPLUTO_CENTROIDS_MAX_AGE_DAYS;
  if (!Number.isFinite(stamped)) {
    findings.push("BBL MapPLUTO centroids missing materialized_at");
  } else if (Number.isFinite(nowMs)) {
    const ageDays = (nowMs - stamped) / 86_400_000;
    if (ageDays > maxAge) {
      findings.push(
        `BBL MapPLUTO centroids age ${ageDays.toFixed(1)}d exceeds max ${maxAge}d — refresh and republish`,
      );
    }
    if (ageDays < -1) {
      findings.push("BBL MapPLUTO centroids materialized_at is in the future");
    }
  }
  return findings;
}

export function assertBblMapplutoCentroidsServeGate(doc, opts = {}) {
  const findings = bblMapplutoCentroidsServeGateFindings(doc, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}
