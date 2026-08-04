/** Canonical Property Disposition process-stage classifier shared by site and Worker. */

export const STAGE_HEARING = "hearing";
export const STAGE_AUCTION_OR_RFP = "auction_or_rfp";
export const STAGE_AWARD_OR_CONVEYANCE = "award_or_conveyance";
export const DISPOSITION_STAGES = Object.freeze([
  STAGE_HEARING,
  STAGE_AUCTION_OR_RFP,
  STAGE_AWARD_OR_CONVEYANCE,
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function plainText(value) {
  return clean(String(value ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " "));
}

function bodyText(row) {
  return plainText([
    row?.short_title, row?.additional_description_1, row?.additional_description_2,
    row?.additional_description_3, row?.other_info_1, row?.other_info_2,
    row?.other_info_3, row?.printout_1, row?.printout_2, row?.printout_3,
  ].filter(Boolean).join(" "));
}

export function classifyDispositionStage(row) {
  const type = clean(row?.type_of_notice_description);
  const text = bodyText(row);
  if (/\b(?:winning bidder|tentative winning|successful bidder|has been sold|sold for|conveyance|deed of|deed to|closing of the sale|transferred title)\b/i.test(text)) return STAGE_AWARD_OR_CONVEYANCE;
  if (type === "Sale" || /\b(?:request for proposals?|\brfps?\b|public auction|lease auction|online public lease auction|public sale|bid solicitation|sealed bid|notice of project availability|upset price|minimum bid|surplus assets)\b/i.test(text)) return STAGE_AUCTION_OR_RFP;
  if (type === "Public Hearings" || type === "Meeting" || /\b(?:public hearing|voluntary public hearing|cancelled hearing|cancellation of public hearing|proposed disposition)\b/i.test(text)) return STAGE_HEARING;
  return null;
}
