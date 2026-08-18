/**
 * Normalize ZAP land-use action codes into reader-facing families.
 *
 * The /browse/zoning/ route hosts acquisitions, special permits, map changes,
 * and rezonings alike — participation copy must follow the record's actions,
 * never the pathname.
 */

const cleanActionText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** DCP action-code → family (exact publisher codes only). */
export const LAND_USE_ACTION_CODE_FAMILY = Object.freeze({
  ZM: "rezoning",
  ZR: "rezoning",
  ZS: "special_permit",
  ZA: "authorization",
  ZC: "certification",
  PQ: "acquisition",
  PC: "acquisition",
  PS: "site_selection",
  MM: "mapping",
  DM: "demapping",
  HA: "disposition",
  PP: "disposition",
  HG: "urban_renewal",
  HI: "landmark",
  LD: "landmark",
});

export const LAND_USE_FAMILY_LABEL_KEY = Object.freeze({
  rezoning: "land_use_family_rezoning",
  special_permit: "land_use_family_special_permit",
  authorization: "land_use_family_authorization",
  certification: "land_use_family_certification",
  acquisition: "land_use_family_acquisition",
  site_selection: "land_use_family_site_selection",
  mapping: "land_use_family_mapping",
  demapping: "land_use_family_demapping",
  disposition: "land_use_family_disposition",
  urban_renewal: "land_use_family_urban_renewal",
  landmark: "land_use_family_landmark",
  land_use: "land_use_family_generic",
});

/**
 * Extract uppercase action codes from a ZAP row / outcome record.
 * Accepts `actions` as a string ("ZM,ZR"), array of strings, or array of
 * `{ action: "PQ" }` objects from /zap-outcomes.
 */
export function landUseActionCodes(record = {}) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const code = cleanActionText(raw).toUpperCase();
    if (!code || seen.has(code)) return;
    if (!/^[A-Z0-9]{1,4}$/.test(code)) return;
    seen.add(code);
    out.push(code);
  };

  const actions = record.actions;
  if (typeof actions === "string") {
    for (const part of actions.split(/[^A-Za-z0-9]+/)) push(part);
  } else if (Array.isArray(actions)) {
    for (const row of actions) {
      if (typeof row === "string") push(row);
      else if (row && typeof row === "object") push(row.action || row.code || row.action_code);
    }
  }

  // Open Data often stamps a parallel actions string on open_data.
  const od = record.open_data?.actions;
  if (typeof od === "string") {
    for (const part of od.split(/[^A-Za-z0-9]+/)) push(part);
  }

  return out;
}

/**
 * Normalize publisher action codes into the public family set.
 *
 * families[] is the first-class ontology. primary / is_rezoning are
 * single-label conveniences only — a sole mapped family, never a
 * rezoning-wins collapse that erases disposition, acquisition, or
 * other siblings. Unmapped codes stay on codes[] and never invent a family.
 */
export function normalizeLandUseActionType(record = {}) {
  const codes = landUseActionCodes(record);
  const families = [];
  const seen = new Set();
  for (const code of codes) {
    const family = LAND_USE_ACTION_CODE_FAMILY[code] || null;
    if (!family || seen.has(family)) continue;
    seen.add(family);
    families.push(family);
  }

  const sole = families.length === 1 ? families[0] : null;
  const primary = sole || "land_use";

  return {
    schema_version: 1,
    codes,
    families,
    primary,
    is_rezoning: sole === "rezoning",
    label_key: LAND_USE_FAMILY_LABEL_KEY[primary] || LAND_USE_FAMILY_LABEL_KEY.land_use,
    label_keys: families.map((family) => LAND_USE_FAMILY_LABEL_KEY[family]).filter(Boolean),
  };
}

function usesRezoningOnlyCopy(type) {
  return type.primary === "rezoning" && type.families.length === 1;
}

/**
 * i18n key for the participation-guide heading.
 * Rezoning wording only when rezoning is the sole mapped family.
 */
export function landParticipationGuideHeadingKey(record = {}) {
  const type = normalizeLandUseActionType(record);
  return usesRezoningOnlyCopy(type) ? "land_guide_heading_rezoning" : "land_guide_heading";
}

/**
 * i18n key when no participation steps are published.
 */
export function landParticipationStepsMissingKey(record = {}) {
  const type = normalizeLandUseActionType(record);
  return usesRezoningOnlyCopy(type)
    ? "next_action_land_steps_missing_rezoning"
    : "next_action_land_steps_missing";
}
