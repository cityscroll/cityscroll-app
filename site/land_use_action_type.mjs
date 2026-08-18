/**
 * Normalize ZAP land-use action codes into reader-facing families.
 *
 * The /browse/zoning/ route hosts acquisitions, special permits, map changes,
 * and rezonings alike — participation copy must follow the record's actions,
 * never the pathname.
 */

import { landUseActionCodes } from "./land_use_action_codes.mjs";

export { landUseActionCodes };

/**
 * DCP action-code → family (exact publisher codes only).
 *
 * Meanings from the DCP ZAP Projects data dictionary ("Action Types",
 * shared string 252) and the Land Use Application form §§6–13.
 * LD is a legal document (NOC, NOR, RD), not a landmark; HK and HI are
 * the landmark codes. UK (not an action type) and EAS (CEQR document)
 * stay unmapped. South Richmond RA/RC/RS fold into the base families.
 */
export const LAND_USE_ACTION_CODE_FAMILY = Object.freeze({
  ZM: "rezoning",
  ZR: "rezoning",
  ZS: "special_permit",
  RS: "special_permit",
  ZA: "authorization",
  RA: "authorization",
  ZC: "certification",
  RC: "certification",
  PQ: "acquisition",
  PC: "acquisition",
  PS: "site_selection",
  MM: "mapping",
  ME: "mapping",
  MD: "mapping",
  DM: "demapping",
  HA: "disposition",
  PP: "disposition",
  HN: "disposition",
  HD: "disposition",
  HG: "urban_renewal",
  HU: "urban_renewal",
  HC: "urban_renewal",
  HI: "landmark",
  HK: "landmark",
  LD: "legal_document",
  CM: "renewal",
  CS: "follow_up",
  PX: "office_space",
  BD: "bid",
  MC: "major_concession",
  GF: "franchise_consent",
  HO: "housing_plan",
  SG: "pops",
  ML: "landfill",
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
  legal_document: "land_use_family_legal_document",
  renewal: "land_use_family_renewal",
  follow_up: "land_use_family_follow_up",
  office_space: "land_use_family_office_space",
  bid: "land_use_family_bid",
  major_concession: "land_use_family_major_concession",
  franchise_consent: "land_use_family_franchise_consent",
  housing_plan: "land_use_family_housing_plan",
  pops: "land_use_family_pops",
  landfill: "land_use_family_landfill",
  land_use: "land_use_family_generic",
});

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
