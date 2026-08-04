/**
 * Shared structural patterns for City Record Property Disposition notices.
 *
 * The accessibility census, timed-event extraction, and reader-action extraction
 * must classify the same notice the same way. Keep this module pure and ordered
 * from specific patterns to the disposition catch-all.
 */

import { cleanNoticeText } from "./text_clean.mjs";

export const PROPERTY_PATTERN_LABELS = Object.freeze({
  pending_destruction: "Pending destruction / seized products",
  unclaimed_property: "Unclaimed property / Property Clerk",
  forest_timber_sale: "Forest and timber sale",
  lease_or_real_property_rfp: "Lease auction or real-property RFP",
  surplus_auction: "Surplus, vehicle, or equipment auction",
  direct_property_sale: "Direct real-property sale",
  medallion_auction: "Taxicab-medallion auction",
  udaap: "UDAAP",
  acquisition_or_easement: "Acquisition or easement",
  disposition: "Disposition hearing or conveyance",
  other: "Other property notice",
});

export function propertyPatternText(row = {}) {
  return [
    row.short_title,
    row.additional_description_1, row.additional_description_2, row.additional_description_3,
    row.other_info_1, row.other_info_2, row.other_info_3,
    row.printout_1, row.printout_2, row.printout_3,
  ]
    .map(cleanNoticeText)
    .filter(Boolean)
    .join(" ");
}

/** Mutually exclusive structural pattern, ordered from specific to general. */
export function classifyPropertyPattern(row = {}) {
  const text = propertyPatternText(row);
  if (/pending destruction|unauthorized tobacco|flavored e-cigarette|flavored e-liquid|forfeiture/i.test(text)) {
    return "pending_destruction";
  }
  if (/property clerk|owners are wanted|without claimants|unclaimed property/i.test(text)) {
    return "unclaimed_property";
  }
  if (/forest management|timber|firewood|sawtimber|cordwood/i.test(text)) {
    return "forest_timber_sale";
  }
  if (/online public lease auction|lease auction|request for proposals|\bRFP\b|leasing opportunities|lease offers/i.test(text)) {
    return "lease_or_real_property_rfp";
  }
  if (/auto auction|municipal auto|surplus assets|govdeals|publicsurplus|redbird subway|heavy machinery|auction.{0,40}vehicle/i.test(text)) {
    return "surplus_auction";
  }
  if (/public sale of residential property|real estate public auction|sale\/assignment of mortgage|sale of city mort?gage and note/i.test(text)) {
    return "direct_property_sale";
  }
  if (/medallion (?:auction|sale)|auction.{0,40}medallion|winning bidders.{0,60}medallion/i.test(text)) {
    return "medallion_auction";
  }
  if (/\bUDAAP\b|Urban Development Action Area/i.test(text)) return "udaap";
  if (/\bacquisition\b|\bacquire(?:s|d)?\b|condemnation|eminent domain|vesting|easement/i.test(text)) {
    return "acquisition_or_easement";
  }
  if (
    row.type_of_notice_description === "Public Hearings"
    || /disposition area|proposed (?:sale|disposition)|land disposition agreement|property disposition|public hearing/i.test(text)
  ) {
    return "disposition";
  }
  return "other";
}
