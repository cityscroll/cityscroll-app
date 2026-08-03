/**
 * Map exploration surface — pure helpers for district choropleth browse.
 *
 * Precompute-first: paints from committed district_activity + district_boundaries.
 * No live GIS, no proprietary map SDK. SVG paths + viewBox pan/zoom only.
 *
 * Levels: borough → community_district → council_district.
 * Zip is a locate-me entry point only (not a choropleth level) unless a
 * contracted zip boundary layer exists.
 */

export const MAP_EXPLORATION_SCHEMA = "cityscroll.map_exploration.v1";
export const DISTRICT_ACTIVITY_SCHEMA = "cityscroll.district_activity.v1";

export const MAP_LENSES = Object.freeze([
  "all",
  "land",
  "property",
  "rules",
  "meetings",
  "money",
]);

export const MAP_LEVELS = Object.freeze([
  "borough",
  "community_district",
  "council_district",
]);

/** NYC WGS84 extent used for the default SVG viewBox (lon/lat degrees). */
export const NYC_BOUNDS = Object.freeze({
  minLon: -74.26,
  minLat: 40.49,
  maxLon: -73.70,
  maxLat: 40.92,
});

export const BOROUGH_META = Object.freeze({
  Manhattan: { id: "Manhattan", prefix: "M", label: "Manhattan" },
  Bronx: { id: "Bronx", prefix: "X", label: "Bronx" },
  Brooklyn: { id: "Brooklyn", prefix: "K", label: "Brooklyn" },
  Queens: { id: "Queens", prefix: "Q", label: "Queens" },
  "Staten Island": { id: "Staten Island", prefix: "R", label: "Staten Island" },
});

const PREFIX_TO_BOROUGH = Object.freeze({
  M: "Manhattan",
  X: "Bronx",
  K: "Brooklyn",
  Q: "Queens",
  R: "Staten Island",
});

/** Schematic borough overview outlines for the top level (lon/lat rings). Not cadastral; district polygons below use the contracted boundary layer. */
export const BOROUGH_HULLS = Object.freeze({
  Manhattan: {
    bbox: [-74.047, 40.68, -73.907, 40.882],
    rings: [[
      [-74.047, 40.68], [-74.02, 40.7], [-73.97, 40.74], [-73.93, 40.8],
      [-73.91, 40.87], [-73.93, 40.88], [-73.95, 40.85], [-73.98, 40.8],
      [-74.01, 40.76], [-74.02, 40.71], [-74.047, 40.68],
    ]],
  },
  Bronx: {
    bbox: [-73.933, 40.785, -73.765, 40.915],
    rings: [[
      [-73.933, 40.785], [-73.91, 40.8], [-73.87, 40.82], [-73.83, 40.85],
      [-73.78, 40.88], [-73.77, 40.91], [-73.82, 40.915], [-73.88, 40.9],
      [-73.92, 40.87], [-73.93, 40.82], [-73.933, 40.785],
    ]],
  },
  Brooklyn: {
    bbox: [-74.042, 40.57, -73.833, 40.74],
    rings: [[
      [-74.042, 40.61], [-74.0, 40.57], [-73.9, 40.58], [-73.85, 40.62],
      [-73.83, 40.68], [-73.86, 40.72], [-73.93, 40.74], [-74.0, 40.7],
      [-74.04, 40.65], [-74.042, 40.61],
    ]],
  },
  Queens: {
    bbox: [-73.962, 40.54, -73.7, 40.8],
    rings: [[
      [-73.962, 40.74], [-73.94, 40.7], [-73.9, 40.6], [-73.85, 40.56],
      [-73.75, 40.54], [-73.7, 40.6], [-73.72, 40.75], [-73.78, 40.8],
      [-73.88, 40.79], [-73.94, 40.77], [-73.962, 40.74],
    ]],
  },
  "Staten Island": {
    bbox: [-74.26, 40.49, -74.05, 40.65],
    rings: [[
      [-74.26, 40.5], [-74.15, 40.49], [-74.06, 40.52], [-74.05, 40.6],
      [-74.1, 40.65], [-74.2, 40.64], [-74.25, 40.58], [-74.26, 40.5],
    ]],
  },
});

export function boroughFromCommunityId(id) {
  if (!id || typeof id !== "string") return null;
  return PREFIX_TO_BOROUGH[id.charAt(0).toUpperCase()] || null;
}

export function emptyLensCounts() {
  return { land: 0, property: 0, rules: 0, meetings: 0, money: 0 };
}

export function totalForLens(counts, lens) {
  if (!counts || typeof counts !== "object") return 0;
  if (!lens || lens === "all") {
    return MAP_LENSES.filter((k) => k !== "all")
      .reduce((sum, k) => sum + (Number(counts[k]) || 0), 0);
  }
  return Number(counts[lens]) || 0;
}

/**
 * Choropleth fill from activity density. Zero stays a paper tone; higher → oxblood.
 * @param {number} count
 * @param {number} max
 */
export function choroplethFill(count, max) {
  const n = Number(count) || 0;
  const m = Number(max) || 0;
  if (n <= 0 || m <= 0) return "#f4efe6";
  const t = Math.min(1, Math.max(0, n / m));
  // Paper → amber → oxblood
  const stops = [
    [244, 239, 230],
    [214, 170, 90],
    [122, 31, 31],
  ];
  const scaled = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

/** Project WGS84 lon/lat into SVG y-down space using NYC_BOUNDS. */
export function projectLonLat(lon, lat, bounds = NYC_BOUNDS) {
  const x = ((Number(lon) - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 1000;
  const y = (1 - (Number(lat) - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 1000;
  return [x, y];
}

/** Ring [[lon,lat],...] → SVG path subcommand string (absolute coords). */
export function ringToSvgPath(ring, bounds = NYC_BOUNDS) {
  if (!Array.isArray(ring) || ring.length < 3) return "";
  const pts = ring.map(([lon, lat]) => projectLonLat(lon, lat, bounds));
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)}`;
  }
  return d + "Z";
}

/**
 * District polygons ({rings:[outer,...holes]}) → SVG path `d`.
 * Holes use evenodd fill-rule (caller should set fill-rule="evenodd").
 */
export function polygonsToSvgPath(polygons, bounds = NYC_BOUNDS) {
  if (!Array.isArray(polygons)) return "";
  const parts = [];
  for (const poly of polygons) {
    const rings = poly && Array.isArray(poly.rings) ? poly.rings : null;
    if (!rings) continue;
    for (const ring of rings) {
      const d = ringToSvgPath(ring, bounds);
      if (d) parts.push(d);
    }
  }
  return parts.join("");
}

export function bboxToViewBox(bbox, pad = 0.02) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return viewBoxForBounds(NYC_BOUNDS);
  }
  const [minLon, minLat, maxLon, maxLat] = bbox.map(Number);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    return viewBoxForBounds(NYC_BOUNDS);
  }
  const lonPad = (maxLon - minLon) * pad + 0.005;
  const latPad = (maxLat - minLat) * pad + 0.005;
  return viewBoxForBounds({
    minLon: minLon - lonPad,
    minLat: minLat - latPad,
    maxLon: maxLon + lonPad,
    maxLat: maxLat + latPad,
  });
}

export function viewBoxForBounds(bounds) {
  const [x0, y1] = projectLonLat(bounds.minLon, bounds.minLat, NYC_BOUNDS);
  const [x1, y0] = projectLonLat(bounds.maxLon, bounds.maxLat, NYC_BOUNDS);
  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  const w = Math.abs(x1 - x0) || 1;
  const h = Math.abs(y1 - y0) || 1;
  return `${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
}

export function defaultViewBox() {
  return viewBoxForBounds(NYC_BOUNDS);
}

/**
 * Zoom viewBox around its center by factor (<1 zooms in).
 */
export function zoomViewBox(viewBox, factor) {
  const parts = String(viewBox || "").split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return defaultViewBox();
  const [x, y, w, h] = parts;
  const f = Math.min(4, Math.max(0.25, Number(factor) || 1));
  const nw = w * f;
  const nh = h * f;
  return `${(x + (w - nw) / 2).toFixed(2)} ${(y + (h - nh) / 2).toFixed(2)} ${nw.toFixed(2)} ${nh.toFixed(2)}`;
}

/**
 * Pan viewBox by fraction of width/height (dx, dy in SVG space direction).
 */
export function panViewBox(viewBox, dxFrac, dyFrac) {
  const parts = String(viewBox || "").split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return defaultViewBox();
  const [x, y, w, h] = parts;
  return `${(x + w * (Number(dxFrac) || 0)).toFixed(2)} ${(y + h * (Number(dyFrac) || 0)).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
}

/**
 * Live-feed filter hashes for a selected area (existing URL grammar).
 * Coordinates never ride share links.
 */
export function areaFeedLinks(level, id) {
  const links = [];
  if (level === "borough" && BOROUGH_META[id]) {
    const boro = id;
    links.push({ lens: "land", hash: `#land?boro=${encodeURIComponent(boro)}`, label_key: "tab_land" });
    links.push({ lens: "property", hash: `#property?boro=${encodeURIComponent(boro)}`, label_key: "tab_property" });
    links.push({ lens: "meetings", hash: `#meetings?boro=${encodeURIComponent(boro)}`, label_key: "tab_meetings" });
    links.push({ lens: "rules", hash: `#rules`, label_key: "tab_rules" });
    links.push({ lens: "money", hash: `#money`, label_key: "tab_money" });
    return links;
  }
  if (level === "community_district" && /^(?:M|X|K|Q|R)\d{2}$/.test(id || "")) {
    const boro = boroughFromCommunityId(id);
    const landQ = new URLSearchParams();
    if (boro) landQ.set("boro", boro);
    landQ.set("cd", id);
    links.push({ lens: "land", hash: `#land?${landQ.toString()}`, label_key: "tab_land" });
    if (boro) {
      links.push({ lens: "property", hash: `#property?boro=${encodeURIComponent(boro)}`, label_key: "tab_property" });
      links.push({ lens: "meetings", hash: `#meetings?boro=${encodeURIComponent(boro)}`, label_key: "tab_meetings" });
    }
    links.push({ lens: "rules", hash: `#rules`, label_key: "tab_rules" });
    links.push({ lens: "money", hash: `#money`, label_key: "tab_money" });
    return links;
  }
  if (level === "council_district" && /^(?:[1-9]|[1-4]\d|5[01])$/.test(String(id || ""))) {
    const landQ = new URLSearchParams();
    landQ.set("council", String(id));
    links.push({ lens: "land", hash: `#land?${landQ.toString()}`, label_key: "tab_land" });
    links.push({ lens: "property", hash: `#property`, label_key: "tab_property" });
    links.push({ lens: "meetings", hash: `#meetings`, label_key: "tab_meetings" });
    links.push({ lens: "rules", hash: `#rules`, label_key: "tab_rules" });
    links.push({ lens: "money", hash: `#money`, label_key: "tab_money" });
    return links;
  }
  return links;
}

/**
 * Drill hash for the map surface itself.
 * @param {{level?:string,id?:string|null,lens?:string,parent?:string|null}} state
 */
export function serializeMapHash(state = {}) {
  const q = new URLSearchParams();
  const level = MAP_LEVELS.includes(state.level) ? state.level : "borough";
  if (level !== "borough") q.set("level", level);
  if (state.id) q.set("id", String(state.id));
  if (state.parent) q.set("parent", String(state.parent));
  if (state.lens && state.lens !== "all" && MAP_LENSES.includes(state.lens)) {
    q.set("lens", state.lens);
  }
  const qs = q.toString();
  return "#map" + (qs ? `?${qs}` : "");
}

export function parseMapHashQuery(searchParams) {
  const q = searchParams instanceof URLSearchParams
    ? searchParams
    : new URLSearchParams(String(searchParams || ""));
  const levelRaw = q.get("level") || "borough";
  const level = MAP_LEVELS.includes(levelRaw) ? levelRaw : "borough";
  const lensRaw = q.get("lens") || "all";
  const lens = MAP_LENSES.includes(lensRaw) ? lensRaw : "all";
  return {
    level,
    id: q.get("id") || null,
    parent: q.get("parent") || null,
    lens,
  };
}

/**
 * Features for the current map level, merged with precomputed activity.
 *
 * @param {object} boundaries — district_boundaries.v1
 * @param {object} activity — district_activity.v1
 * @param {{level:string, parent?:string|null, lens?:string}} opts
 */
export function mapFeatures(boundaries, activity, opts = {}) {
  const level = MAP_LEVELS.includes(opts.level) ? opts.level : "borough";
  const lens = MAP_LENSES.includes(opts.lens) ? opts.lens : "all";
  const parent = opts.parent || null;
  const activityRoot = activity && typeof activity === "object" ? activity : {};
  const byLevel = activityRoot.by_level || {};

  if (level === "borough") {
    const counts = byLevel.borough || {};
    const features = Object.keys(BOROUGH_META).map((id) => {
      const hull = BOROUGH_HULLS[id];
      const c = counts[id] || emptyLensCounts();
      return {
        id,
        level: "borough",
        label: BOROUGH_META[id].label,
        bbox: hull.bbox,
        path: ringToSvgPath(hull.rings[0]),
        counts: { ...emptyLensCounts(), ...c },
        total: totalForLens(c, lens),
      };
    });
    return stampMax(features, lens);
  }

  if (level === "community_district") {
    const districts = Array.isArray(boundaries?.community_districts)
      ? boundaries.community_districts
      : [];
    const counts = byLevel.community_district || {};
    const features = [];
    for (const d of districts) {
      const id = d && d.id;
      if (!id) continue;
      if (parent && boroughFromCommunityId(id) !== parent) continue;
      // Skip joint-interest areas (ids > 18) for the primary browse surface.
      const num = Number(String(id).slice(1));
      if (Number.isFinite(num) && num > 18) continue;
      const c = counts[id] || emptyLensCounts();
      features.push({
        id,
        level: "community_district",
        label: d.label || id,
        bbox: d.bbox,
        path: polygonsToSvgPath(d.polygons),
        counts: { ...emptyLensCounts(), ...c },
        total: totalForLens(c, lens),
        parent: boroughFromCommunityId(id),
      });
    }
    return stampMax(features, lens);
  }

  // council_district
  const districts = Array.isArray(boundaries?.council_districts)
    ? boundaries.council_districts
    : [];
  const counts = byLevel.council_district || {};
  const features = [];
  for (const d of districts) {
    const id = d && d.id != null ? String(d.id) : null;
    if (!id) continue;
    const c = counts[id] || emptyLensCounts();
    features.push({
      id,
      level: "council_district",
      label: d.label || `City Council District ${id}`,
      bbox: d.bbox,
      path: polygonsToSvgPath(d.polygons),
      counts: { ...emptyLensCounts(), ...c },
      total: totalForLens(c, lens),
    });
  }
  return stampMax(features, lens);
}

function stampMax(features, lens) {
  let max = 0;
  for (const f of features) {
    if (f.total > max) max = f.total;
  }
  return {
    features: features.map((f) => ({
      ...f,
      fill: choroplethFill(f.total, max),
    })),
    max,
    lens,
  };
}

/**
 * Breadcrumb crumbs for expand/contract navigation.
 */
export function mapBreadcrumb(state = {}) {
  const crumbs = [{ level: "borough", id: null, parent: null, label_key: "map_crumb_city" }];
  if (state.level === "community_district" || state.level === "council_district") {
    if (state.parent && BOROUGH_META[state.parent]) {
      crumbs.push({
        level: "community_district",
        id: null,
        parent: state.parent,
        label: state.parent,
        label_key: null,
      });
    }
  }
  if (state.level === "community_district" && state.id) {
    crumbs.push({
      level: "community_district",
      id: state.id,
      parent: state.parent || boroughFromCommunityId(state.id),
      label: state.id,
      label_key: null,
    });
  }
  if (state.level === "council_district") {
    crumbs.push({
      level: "council_district",
      id: state.id || null,
      parent: null,
      label: state.id ? `Council ${state.id}` : null,
      label_key: state.id ? null : "map_crumb_council",
    });
  }
  return crumbs;
}

/**
 * Next drill state when tapping a feature.
 */
export function drillInto(feature, current = {}) {
  if (!feature) return { level: "borough", id: null, parent: null, lens: current.lens || "all" };
  if (feature.level === "borough") {
    return {
      level: "community_district",
      id: null,
      parent: feature.id,
      lens: current.lens || "all",
    };
  }
  // Stay on the selected district (show detail panel); no deeper polygon level.
  return {
    level: feature.level,
    id: feature.id,
    parent: feature.parent || current.parent || null,
    lens: current.lens || "all",
  };
}

/**
 * Validate a district_activity document shape (lightweight).
 */
export function loadDistrictActivity(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.schema && doc.schema !== DISTRICT_ACTIVITY_SCHEMA) return null;
  if (!doc.boundary_vintage) return null;
  if (!doc.by_level || typeof doc.by_level !== "object") return null;
  return doc;
}

/**
 * Totals across all geographic borough bags (city-scale sum of local density).
 * Does not replace the first-class `activity.citywide` bag (city-scale items);
 * use `nonPolygonBuckets` / `activity.citywide` for that.
 */
export function citywideTotals(activity) {
  const totals = emptyLensCounts();
  const boroughs = activity?.by_level?.borough || {};
  for (const [id, counts] of Object.entries(boroughs)) {
    if (id === "Virtual") continue; // virtual is a non-place bucket
    for (const lens of Object.keys(totals)) {
      totals[lens] += Number(counts?.[lens]) || 0;
    }
  }
  return totals;
}

/** Counts from the first-class citywide bag (rules that apply everywhere, etc.). */
export function citywideBucketCounts(activity) {
  const bag = activity?.citywide || activity?.by_level?.borough?.Citywide || null;
  const totals = emptyLensCounts();
  if (!bag) return totals;
  for (const lens of Object.keys(totals)) {
    totals[lens] = Number(bag[lens]) || 0;
  }
  return totals;
}

/**
 * First-class non-polygon map bags (citywide rules, virtual-only meetings).
 * Shown as labeled list rows / detail chips — never painted onto district polygons.
 */
export function nonPolygonBuckets(activity) {
  const bags = [];
  const citywide = activity?.citywide || activity?.by_level?.borough?.Citywide || null;
  const virtual = activity?.virtual || activity?.by_level?.borough?.Virtual || null;
  if (citywide && totalForLens(citywide, "all") > 0) {
    bags.push({
      id: "Citywide",
      label: "Citywide",
      kind: "citywide",
      counts: { ...emptyLensCounts(), ...citywide },
      total: totalForLens(citywide, "all"),
    });
  }
  if (virtual && totalForLens(virtual, "all") > 0) {
    bags.push({
      id: "Virtual",
      label: "Virtual / online only",
      kind: "virtual",
      counts: { ...emptyLensCounts(), ...virtual },
      total: totalForLens(virtual, "all"),
    });
  }
  return bags;
}

/**
 * Granularity regression: for each place-based lens, detect zero-collapse
 * (borough located > 0 but a finer level is entirely zero). Returns findings.
 *
 * Lenses that are expected to stay city-scale (rules default citywide) skip
 * the community/council collapse check when citywide bag holds them.
 */
export function granularityCollapseFindings(activity, opts = {}) {
  const findings = [];
  if (!activity?.by_level) return findings;
  const lenses = opts.lenses || ["land", "property", "meetings", "money", "rules"];
  const levels = ["borough", "community_district", "council_district"];

  function levelTotal(level, lens) {
    const bag = activity.by_level[level] || {};
    let sum = 0;
    for (const [id, counts] of Object.entries(bag)) {
      // Skip non-polygon borough keys when summing geographic density.
      if (level === "borough" && (id === "Citywide" || id === "Virtual")) continue;
      sum += Number(counts?.[lens]) || 0;
    }
    return sum;
  }

  for (const lens of lenses) {
    const boroughN = levelTotal("borough", lens);
    const cdN = levelTotal("community_district", lens);
    const councilN = levelTotal("council_district", lens);
    const citywideN = Number(activity.citywide?.[lens]) || 0;
    const virtualN = Number(activity.virtual?.[lens]) || 0;
    const located = Number(activity.sources?.[lens]?.located) || 0;
    const counted = Number(activity.sources?.[lens]?.counted) || 0;

    // Land / property / meetings: if borough has density, finer levels must not be all-zero
    // when the corpus is non-empty. Rules may legitimately be almost entirely citywide.
    if (lens === "rules") {
      if (counted > 0 && located > 0 && citywideN === 0 && boroughN === 0 && cdN === 0) {
        findings.push({
          kind: "granularity-zero-collapse",
          lens,
          level: "all",
          message: "rules located but no borough/citywide/CD bag holds them",
          borough: boroughN,
          community_district: cdN,
          council_district: councilN,
          citywide: citywideN,
        });
      }
      continue;
    }

    if (boroughN > 0 && cdN === 0 && lens !== "money") {
      // Money often lacks CD-grade signals; still flag land/meetings/property.
      findings.push({
        kind: "granularity-zero-collapse",
        lens,
        level: "community_district",
        message: `${lens} has borough density (${boroughN}) but community_district is all-zero`,
        borough: boroughN,
        community_district: cdN,
        council_district: councilN,
      });
    }
    if ((boroughN > 0 || cdN > 0) && councilN === 0 && (lens === "land" || lens === "meetings" || lens === "property")) {
      findings.push({
        kind: "granularity-zero-collapse",
        lens,
        level: "council_district",
        message: `${lens} has coarser density but council_district is all-zero`,
        borough: boroughN,
        community_district: cdN,
        council_district: councilN,
      });
    }
    // Silence virtual-only as unlocated without a virtual bag when any virtual_only reasons exist.
    const virtReason = Number(activity.unlocated_reasons?.[lens]?.virtual_only) || 0;
    if (virtReason > 0 && virtualN === 0 && lens === "meetings") {
      findings.push({
        kind: "virtual-bucket-missing",
        lens,
        level: "virtual",
        message: `meetings has virtual_only reasons (${virtReason}) but virtual bag is empty`,
        virtual_reasons: virtReason,
        virtual_bag: virtualN,
      });
    }
  }

  // Unused levels param kept for future multi-level thresholds.
  void levels;
  return findings;
}
