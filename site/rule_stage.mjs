/**
 * City Record-only rule-stage classification.
 *
 * The daily /rules view remains the richer source because it carries official
 * NYC Rules dates. This narrow fallback covers City Record rows published after
 * that snapshot and unmatched rows whose notice type/title names a lifecycle
 * stage. It deliberately returns null for regulatory agendas and generic notices.
 */

import { cleanNoticeText } from "./text_clean.mjs";

const PUBLIC_PROCESS_RE = /\bpublic hearings?\b|\bpublic hearing\b|\bnotice of hearing\b|\bNOH\b/i;
const EFFECTIVE_RE = /\bnotice of effectiveness\b|\brule (?:is |becomes? )?effective\b|\btakes? effect\b/i;
const ADOPTION_RE = /\bnotice of adoption\b|\badoption of (?:a |the )?(?:final )?rules?\b|\badopted rules?\b|\bfinal rules?\b|\bNOA\b/i;
const PROPOSAL_RE = /\bproposed rules?\b|\bproposal for (?:a |the )?rules?\b|\bnotice of proposed rulemaking\b/i;

export function classifyCityRecordRuleStage(row) {
  if (!row || typeof row !== "object") return null;
  const noticeType = cleanNoticeText(row.type_of_notice_description || row.notice_type);
  const title = cleanNoticeText(row.short_title || row.title);
  const text = `${noticeType} ${title}`.trim();
  if (!text) return null;

  // Public Hearings is a stronger process signal than a title beginning
  // “Proposed Rule”: the notice is already in its public-process phase.
  if (PUBLIC_PROCESS_RE.test(noticeType) || PUBLIC_PROCESS_RE.test(title)) return "hearing";
  if (EFFECTIVE_RE.test(title)) return "effective";
  if (ADOPTION_RE.test(title)) return "adopted";
  if (PROPOSAL_RE.test(title)) return "proposed";
  return null;
}

export function cityRecordRuleStageRecord(row) {
  const stage = classifyCityRecordRuleStage(row);
  if (!stage) return null;
  return {
    request_id: row.request_id || null,
    stage,
    nyc_rules: null,
    events: [],
    join: {
      matched: false,
      reason: "Classified from City Record notice metadata while NYC Rules enrichment is unavailable",
      classification_source: "city_record_notice",
    },
  };
}
