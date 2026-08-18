import { landUseActionCodes } from "./land_use_action_codes.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const SOURCES = Object.freeze({
  "ZR 23-21": Object.freeze({
    section: "ZR 23-21",
    title: "Floor Area Regulations for R1 Through R5 Districts",
    url: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-21",
  }),
  "ZR 23-22": Object.freeze({
    section: "ZR 23-22",
    title: "Floor Area Regulations for R6 Through R12 Districts",
    url: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-22",
  }),
  "ZR 33-121": Object.freeze({
    section: "ZR 33-121",
    title: "Bulk governed by Residence District regulations",
    url: "https://zr.planning.nyc.gov/article-iii/chapter-3/33-121",
  }),
  "ZR 33-122": Object.freeze({
    section: "ZR 33-122",
    title: "Commercial buildings in all other Commercial Districts",
    url: "https://zr.planning.nyc.gov/article-iii/chapter-3/33-122",
  }),
});

function districtEntries(ids, maxFar, section) {
  return Object.fromEntries(ids.split(/\s+/).filter(Boolean).map((id) => [id, Object.freeze({
    max_far: maxFar,
    citation: SOURCES[section],
  })]));
}

const RESIDENTIAL_DISTRICTS = {
  ...districtEntries("R1-2A R1-1 R1-2 R2A R2 R3A R3X R3-1 R3-2", 1, "ZR 23-21"),
  ...districtEntries("R2X", 1, "ZR 23-21"),
  ...districtEntries("R4A R4B R4 R4-1", 1.5, "ZR 23-21"),
  ...districtEntries("R5A R5B R5", 2, "ZR 23-21"),
  ...districtEntries("R5D", 2, "ZR 23-21"),
  ...districtEntries("R6A R6 R6-1 R7B", 3.9, "ZR 23-22"),
  ...districtEntries("R6B", 2.4, "ZR 23-22"),
  ...districtEntries("R6D R6-2", 3, "ZR 23-22"),
  ...districtEntries("R7A R7-1 R7-2", 5.01, "ZR 23-22"),
  ...districtEntries("R7D", 5.6, "ZR 23-22"),
  ...districtEntries("R7X R7-3", 6, "ZR 23-22"),
  ...districtEntries("R8A R8X", 7.2, "ZR 23-22"),
  ...districtEntries("R8", 8.64, "ZR 23-22"),
  ...districtEntries("R8B", 4.8, "ZR 23-22"),
  ...districtEntries("R9A R9", 9.02, "ZR 23-22"),
  ...districtEntries("R9D R9X R9-1", 10.8, "ZR 23-22"),
  ...districtEntries("R10A R10X R10", 12, "ZR 23-22"),
  ...districtEntries("R11", 15, "ZR 23-22"),
  ...districtEntries("R12", 18, "ZR 23-22"),
};

const COMMERCIAL_DISTRICTS = {
  ...districtEntries("C3", 0.5, "ZR 33-122"),
  ...districtEntries("C4-1 C8-1", 1, "ZR 33-122"),
  ...districtEntries("C1-6 C1-7 C1-8 C1-9 C2-6 C2-7 C2-8 C7-1 C8-2 C8-3", 2, "ZR 33-122"),
  ...districtEntries("C4-2A C4-3A C7-2", 3, "ZR 33-122"),
  ...districtEntries("C4-2 C4-2F C4-3 C4-4 C4-4D C4-5 C4-6 C4-8 C4-9 C4-11 C4-12", 3.4, "ZR 33-122"),
  ...districtEntries("C4-4A C4-4L C4-5A C4-5X C5-1 C7-3", 4, "ZR 33-122"),
  ...districtEntries("C4-5D", 4.2, "ZR 33-122"),
  ...districtEntries("C7-4 C8-4", 5, "ZR 33-122"),
  ...districtEntries("C6-1 C6-2 C6-3", 6, "ZR 33-122"),
  ...districtEntries("C7-5", 6.5, "ZR 33-122"),
  ...districtEntries("C7-6", 8, "ZR 33-122"),
  ...districtEntries("C6-3D", 9, "ZR 33-122"),
  ...districtEntries("C4-7 C5-2 C5-4 C6-4 C6-5 C6-8 C7-7", 10, "ZR 33-122"),
  ...districtEntries("C6-11 C7-8", 12, "ZR 33-122"),
  ...districtEntries("C5-3 C5-5 C6-6 C6-7 C6-9 C6-12 C7-9", 15, "ZR 33-122"),
};

const COMMERCIAL_OVERLAYS = Object.fromEntries(
  ["C1", "C2"].flatMap((family) => [1, 2, 3, 4, 5].map((suffix) => `${family}-${suffix}`))
    .map((id) => [id, Object.freeze({ kind: "commercial_overlay", citation: SOURCES["ZR 33-121"] })]),
);

/**
 * Closed lookup transcribed from the consolidated Zoning Resolution dated
 * 2025-12-31. For tables with multiple eligibility columns, max_far is the
 * greatest published value; special-purpose-district bonuses are excluded.
 * Manufacturing districts stay outside this density-only comparison because
 * their permitted-use FAR is not equivalent to residential capacity.
 */
export const ZONING_MAX_FAR_TABLE = Object.freeze({
  schema: "cityscroll.zoning_max_far.v1",
  as_of: "2025-12-31",
  method: "maximum_published_residential_or_commercial_far_by_base_district",
  excluded_district_families: Object.freeze(["manufacturing"]),
  sources: Object.freeze(Object.values(SOURCES)),
  districts: Object.freeze({
    ...RESIDENTIAL_DISTRICTS,
    ...COMMERCIAL_DISTRICTS,
  }),
  overlays: Object.freeze(COMMERCIAL_OVERLAYS),
});

export const LAND_REGULATORY_EFFECT_OPTIONS = Object.freeze([
  { id: "any", label_key: "status_all" },
  { id: "upzone", label_key: "land_regulatory_effect_upzone" },
  { id: "downzone", label_key: "land_regulatory_effect_downzone" },
  { id: "mixed", label_key: "land_regulatory_effect_mixed" },
  { id: "no_density_change", label_key: "land_regulatory_effect_no_density_change" },
]);

const EFFECTS = new Set(["upzone", "downzone", "mixed", "no_density_change", "unknown"]);
const PUBLIC_CONFIDENCE = new Set(["high", "medium"]);
const DISTRICT_TOKEN = /\b(?:R(?:1[0-2]|[1-9])(?:-[1-3])?[A-Z]?|C[1-8](?:-\d{1,2}[A-Z]?)?|M[1-3](?:-\d{1,2}[A-Z]?)?)\b/gi;
const SPECIAL_DISTRICT_WRAPPER = /\((?:OP|BR|SHPD)\)/gi;

export function normalizeLandRegulatoryEffect(value, fallback = "any") {
  const raw = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
  const effect = ({ up_zone: "upzone", down_zone: "downzone" })[raw] || raw;
  const options = new Set(LAND_REGULATORY_EFFECT_OPTIONS.map(({ id }) => id));
  return options.has(effect) ? effect : fallback;
}

function districtIds(value) {
  const seen = new Set();
  const out = [];
  for (const match of clean(value).replace(SPECIAL_DISTRICT_WRAPPER, " ").matchAll(DISTRICT_TOKEN)) {
    const id = match[0].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function districtPairKey(pair) {
  return `${pair.existing.join("/")}>${pair.proposed.join("/")}`;
}

export function extractZoningDistrictPairs(projectBrief) {
  const brief = clean(projectBrief).replace(SPECIAL_DISTRICT_WRAPPER, " ");
  if (!brief) return [];
  const candidates = [];
  const collect = (pattern) => {
    for (const match of brief.matchAll(pattern)) {
      const existing = districtIds(match[1]);
      const proposed = districtIds(match[2]);
      if (existing.length || proposed.length) candidates.push({ existing, proposed });
    }
  };
  collect(/\(([^()]{1,100}?)\bto\b([^()]{1,100}?)\)/gi);
  const pairEnd = "(?=;|\\.|\\band\\s+from\\b|\\band\\s+(?:a\\s+)?(?:zoning|text|special)\\b|\\bseparately\\b|$)";
  collect(new RegExp(`\\bfrom\\b(.{1,100}?)\\bto\\b(.{1,240}?)${pairEnd}`, "gi"));
  collect(new RegExp(`\\bchang(?:e|ing)\\s+(?:an?\\s+)?(.{1,100}?)\\s+districts?\\s+to\\b(.{1,240}?)${pairEnd}`, "gi"));
  const seen = new Set();
  return candidates.filter((pair) => {
    const key = districtPairKey(pair);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function explicitOverlayPair(brief) {
  const overlay = "(C[12]-[1-5])";
  const base = "(R(?:1[0-2]|[1-9])(?:-[1-3])?[A-Z]?)";
  const match = clean(brief).match(new RegExp(
    `\\bmap(?:ping)?\\s+(?:an?\\s+)?${overlay}\\s+(?:commercial\\s+)?overlay\\s+(?:within|in)\\s+(?:an?\\s+)?${base}\\b`,
    "i",
  ));
  return match ? { existing: [match[2].toUpperCase()], proposed: [match[2].toUpperCase(), match[1].toUpperCase()] } : null;
}

function resolveSide(ids) {
  if (!ids.length) return null;
  const districts = [];
  let maxFar = -Infinity;
  let overlay = false;
  for (const id of ids) {
    const base = ZONING_MAX_FAR_TABLE.districts[id];
    if (base) {
      districts.push({ id, kind: "base_district", max_far: base.max_far, citation: base.citation });
      maxFar = Math.max(maxFar, base.max_far);
      continue;
    }
    const commercialOverlay = ZONING_MAX_FAR_TABLE.overlays[id];
    if (commercialOverlay) {
      overlay = true;
      districts.push({ id, kind: commercialOverlay.kind, max_far: null, citation: commercialOverlay.citation });
      continue;
    }
    return null;
  }
  if (!Number.isFinite(maxFar)) return null;
  return { districts, max_far: maxFar, has_overlay: overlay };
}

function unknown(reason) {
  return { effect: "unknown", confidence: "unknown", reason };
}

function direction(existingFar, proposedFar) {
  const delta = proposedFar - existingFar;
  if (Math.abs(delta) <= 0.05) return "no_density_change";
  return delta > 0 ? "upzone" : "downzone";
}

function stampedResult(record) {
  const effect = clean(record?.regulatory_effect).toLowerCase();
  if (!EFFECTS.has(effect)) return null;
  const confidence = ["high", "medium", "low", "unknown"].includes(record?.regulatory_effect_confidence)
    ? record.regulatory_effect_confidence
    : effect === "unknown" ? "unknown" : "low";
  const basis = record?.regulatory_effect_basis;
  return {
    effect,
    confidence,
    ...(basis && typeof basis === "object" && !Array.isArray(basis) ? basis : {}),
  };
}

export function deriveLandRegulatoryEffect(record = {}) {
  const stamped = stampedResult(record);
  if (stamped) return stamped;
  const brief = clean(record.project_brief);
  const codes = landUseActionCodes(record);
  const hasZm = codes.includes("ZM");
  if (/\b(?:test project|placeholder|insert (?:text|description)|sample only)\b/i.test(brief)) {
    return unknown("test_stub");
  }
  let pairs = extractZoningDistrictPairs(brief);
  const overlayPair = explicitOverlayPair(brief);
  if (!pairs.length && overlayPair) pairs = [overlayPair];
  if (!hasZm) {
    if (!pairs.length) return unknown("not_map_amendment");
    if (codes.includes("UK")) return unknown("unverified_map_amendment");
  }
  if (!pairs.length) return unknown("district_pair_missing");
  if (pairs.some((pair) => !pair.existing.length || !pair.proposed.length)) return unknown("district_pair_incomplete");

  const byExisting = new Map();
  for (const pair of pairs) {
    const existing = [...pair.existing].sort().join("/");
    const proposed = [...pair.proposed].sort().join("/");
    if (!byExisting.has(existing)) byExisting.set(existing, new Set());
    byExisting.get(existing).add(proposed);
  }
  if ([...byExisting.values()].some((targets) => targets.size > 1)) return unknown("conflicting_district_pairs");

  const evaluated = [];
  for (const pair of pairs) {
    const existing = resolveSide(pair.existing);
    const proposed = resolveSide(pair.proposed);
    if (!existing || !proposed) return unknown("district_not_in_far_table");
    const effect = direction(existing.max_far, proposed.max_far);
    evaluated.push({ existing, proposed, effect });
  }
  const directions = new Set(evaluated.map(({ effect }) => effect));
  if (directions.size > 1) {
    return {
      effect: "mixed",
      confidence: evaluated.some(({ existing, proposed }) => existing.has_overlay || proposed.has_overlay) ? "medium" : "high",
      pairs: evaluated,
      method: "project_brief_district_pair_max_far_v1",
      far_table: { schema: ZONING_MAX_FAR_TABLE.schema, as_of: ZONING_MAX_FAR_TABLE.as_of },
    };
  }
  const [{ existing, proposed, effect }] = evaluated;
  const confidence = effect === "no_density_change" || existing.has_overlay || proposed.has_overlay ? "medium" : "high";
  return {
    effect,
    confidence,
    existing,
    proposed,
    method: overlayPair && pairs.length === 1
      ? "project_brief_overlay_grammar_max_far_v1"
      : "project_brief_district_pair_max_far_v1",
    far_table: { schema: ZONING_MAX_FAR_TABLE.schema, as_of: ZONING_MAX_FAR_TABLE.as_of },
  };
}

export function landRegulatoryEffectForRow(row = {}) {
  return stampedResult(row) || deriveLandRegulatoryEffect(row);
}

export function landRowMatchesRegulatoryEffect(row, effect = "any") {
  const selected = normalizeLandRegulatoryEffect(effect);
  if (selected === "any") return true;
  return landRegulatoryEffectForRow(row).effect === selected;
}

export function landRegulatoryEffectChipHTML(row = {}, { t, escape } = {}) {
  const result = landRegulatoryEffectForRow(row);
  if (!PUBLIC_CONFIDENCE.has(result.confidence) || result.effect === "unknown") return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const label = translate(`land_regulatory_effect_${result.effect}`);
  const basis = translate("land_regulatory_effect_derived");
  return `<span class="tag land-regulatory-effect" data-land-regulatory-effect="${esc(result.effect)}" title="${esc(basis)}">${esc(label)} <span class="sr-only">(${esc(basis)})</span></span>`;
}

export function stampLandRegulatoryEffect(record = {}) {
  const result = deriveLandRegulatoryEffect(record);
  const { effect, confidence, ...basis } = result;
  return {
    ...record,
    regulatory_effect: effect,
    regulatory_effect_confidence: confidence,
    regulatory_effect_basis: basis,
  };
}
