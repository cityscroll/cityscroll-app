/** Exact retained NYCEDC development/procurement specimen keys. */

export const NYCEDC_CANONICAL_ID = "economic-development-corporation";
export const SBS_CANONICAL_ID = "small-business-services";
export const WILLETS_POINT_PROJECT_ID = "2024Q0135";
export const NYCEDC_ZAP_APPLICANT_SPELLING = "EDC - Economic Development Corporation for NYC";
export const SBS_MASTER_EPIN = "80125S0021001";
export const SBS_MASTER_SOURCE_REF = "passport_public_contracts:contract:80125S0021001:5503551";
export const SBS_MASTER_PROCUREMENT_ID = "procurement:contract:MMA180120268802442";
export const BOROUGH_BOARD_NOTICE_ID = "20260518003";
export const WILLETS_POINT_PARCEL_BBL = "4018200001";

export function isNycEdcApplicantSpelling(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim() === NYCEDC_ZAP_APPLICANT_SPELLING;
}
