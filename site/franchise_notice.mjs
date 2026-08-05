// Route-independent franchise classification used by the home Money action rail and the
// route-lazy Property renderer. Keep this narrow: rendering and lifecycle fetches stay in
// app/property.mjs.
function cleanNoticeText(value){
  return String(value||"")
    .replace(/<br\s*\/?>|<\/p\s*>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/\s+/g," ")
    .trim();
}

export function isFranchiseConcessionNoticeEligible(record){
  if(!record) return false;
  const agency=String(record.agency_name||"");
  const title=cleanNoticeText(record.short_title||"");
  const body=cleanNoticeText(record.additional_description_1||"");
  const hay=`${title} ${body}`;
  if(/city council/i.test(agency) && /zoning and franchises/i.test(hay)) return false;
  if(/^franchise and concession review committee$/i.test(agency)) return true;
  if(/^mayor'?s office of contract services$/i.test(agency) && /\bFCRC\b|franchise and concession/i.test(hay)) return true;
  if(/\bFCRC\b/i.test(hay)) return true;
  if(/franchise and concession review committee/i.test(hay)) return true;
  return /proposed (?:information services )?franchise agreement/i.test(hay);
}

export function inferFranchiseStageFromNotice(record){
  if(!record) return null;
  if(record.franchise_stage) return record.franchise_stage;
  const type=String(record.type_of_notice_description||"");
  const title=cleanNoticeText(record.short_title||"");
  const body=cleanNoticeText(record.additional_description_1||"");
  const hay=`${title} ${body}`;
  if(/^Award$/i.test(type) || /\b(?:has been awarded|award of (?:the )?(?:franchise|concession)|franchise has been granted)\b/i.test(hay)) return "award";
  if(/^Solicitation$/i.test(type) || (/\b(?:request for proposals?|\brfp\b|solicitation)\b/i.test(hay) && !/\bpublic hearing\b/i.test(hay))) return "solicitation";
  if(/^Meeting$/i.test(type) || /\bpublic meeting\b/i.test(title) || /\bFCRC\b.*\bmeeting\b/i.test(title)) return "committee_meeting";
  if(/^Public Hearings$/i.test(type) || /\bpublic hearing\b/i.test(hay) || /\bFCRC\b.*\bhearing\b/i.test(hay)) return "public_hearing";
  return null;
}
