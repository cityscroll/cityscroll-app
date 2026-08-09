/**
 * Pure, bounded matter-subject extraction for offline City Record meetings.
 *
 * Source prose is ephemeral input. The returned stamp contains only compact
 * subject tokens and publisher-shaped opaque identifiers.
 */

import { extractUlurpKeys } from "./ulurp_tokens.mjs";

export const MEETING_MATTER_STAMP_SCHEMA = "cityscroll.meeting_matter_stamp.v1";
export const MEETING_MATTER_STAMP_LIMITS = Object.freeze({
  subject_tokens: 32,
  matter_ids: 24,
});

const SUBJECT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "before", "being", "by",
  "city", "commission", "committee", "department", "each", "for", "from", "has",
  "have", "held", "hereby", "in", "into", "is", "it", "its", "may", "members",
  "meeting", "meetings", "new", "notice", "nyc", "of", "on", "or", "other", "public",
  "pursuant", "regarding", "scheduled", "section", "shall", "that", "the", "their",
  "this", "those", "to", "under", "upon", "was", "were", "will", "with", "within",
  "york", "agency", "agenda", "applicant", "application", "applications", "board",
  "calendar", "conduct", "concerning", "consider", "following", "given", "matter",
  "matters", "order", "proposed", "relative", "subject", "take", "time", "whereas",
  "attend", "attendance", "accessible", "accessibility", "accommodation", "call", "email",
  "hearing", "hearings", "information", "instructions", "person", "phone", "remote",
  "presentation", "remotely", "testify", "testimony", "website", "january", "february", "march", "april",
  "june", "july", "august", "september", "october", "november", "december",
]);

const SUBJECT_SIGNAL = /\b(?:appeal|budget|broadband|cafe|construction|discuss|disposition|historic\s+district|installation|jail\s+system|landmark|lease|maintenance|management\s+report|modification|nomination|operation|petition|plan|project|proposal|reconstruction|repair|rule|sale|sidewalk|variance|zoning)\b/i;
const BSA_ID = /\b(\d{4}-\d{1,4}-(?:BZII|BZ|A))\b/gi;
const PDC_ID = /\b(\d{5}):(?=\s|$)/g;
const ZAP_PROJECT_URL = /(?:zap\.planning\.nyc\.gov|zap-api-production\.herokuapp\.com)\/projects\/([0-9]{4}[A-Z][0-9]{3,6})\b/gi;

function compactText(value, max = 60_000) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:mdash|ndash);/gi, "-")
    .replace(/&#(?:8211|8212);/gi, "-")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sourceBody(row) {
  return compactText([
    row?.additional_description_1,
    row?.additional_description_2,
    row?.additional_description_3,
    row?.other_info_1,
    row?.printout_1,
  ].filter(Boolean).join(" "));
}

function withoutContacts(value) {
  return compactText(value)
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(/(?:(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-])?\d{3}[\s.-]\d{4}\b/g, " ")
    .replace(/\b(?:meeting|conference)\s+id\s*[:#]?\s*[0-9\s-]{4,}\b/gi, " ")
    .replace(/\b(?:access|pass)code\s*[:#]?\s*[A-Z0-9\s-]{4,}\b/gi, " ");
}

function addSegment(segments, value) {
  const clean = compactText(value, 1200);
  if (clean && !segments.includes(clean)) segments.push(clean);
}

function subjectSegments(body) {
  const text = withoutContacts(body);
  const segments = [];

  for (const match of text.matchAll(/\bSUBJECT\s*[-:–—]*\s*([\s\S]{1,800}?)(?=\s+(?:PREMISES\s+AFFECTED|APPLICANT|SPECIAL\s+ORDER\s+CALENDAR|APPEALS\s+CALENDAR|ZONING\s+CALENDAR|\d{4}-\d{1,4}-(?:BZII|BZ|A))\b|$)/gi)) {
    addSegment(segments, match[1]);
  }
  for (const match of text.matchAll(/\b\d{5}:\s*([\s\S]{1,600}?)(?=\s+\d{5}:|\s+PUBLIC\s+HEARING\b|$)/g)) {
    addSegment(segments, match[1]);
  }
  for (const sentence of text.split(/(?<=[.!?])\s+|[\r\n]+/)) {
    if (SUBJECT_SIGNAL.test(sentence)) addSegment(segments, sentence);
  }
  return segments;
}

function subjectTokens(body) {
  const candidateWords = subjectSegments(body).join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim());
  const words = candidateWords
    .filter((token, index) => !(token.endsWith("ly") && /^\d+$/.test(candidateWords[index + 1] || "")))
    .filter((token, index) => !(token.length <= 5 && candidateWords[index + 1] === "presentation"))
    .filter((token) => token.length >= 4 && token.length <= 40)
    .filter((token) => !SUBJECT_STOPWORDS.has(token) && !/^\d+$/.test(token));
  return [...new Set(words)].slice(0, MEETING_MATTER_STAMP_LIMITS.subject_tokens);
}

function exactMatterIds(body) {
  const ids = [];
  const add = (kind, value) => {
    const clean = compactText(value, 80).toUpperCase().replace(/\s+/g, "");
    const stamped = clean ? `${kind}:${clean}` : null;
    if (stamped && !ids.includes(stamped) && ids.length < MEETING_MATTER_STAMP_LIMITS.matter_ids) {
      ids.push(stamped);
    }
  };
  for (const match of body.matchAll(BSA_ID)) add("bsa", match[1]);
  for (const match of body.matchAll(PDC_ID)) add("pdc", match[1]);
  for (const key of extractUlurpKeys(body)) add("ulurp", key);
  for (const match of body.matchAll(ZAP_PROJECT_URL)) add("zap", match[1]);
  return ids;
}

/** Derive one compact stamp without mutating the source row or retaining prose. */
export function extractMeetingMatterStamp(row = {}) {
  const body = sourceBody(row);
  return {
    schema: MEETING_MATTER_STAMP_SCHEMA,
    subject_tokens: subjectTokens(body),
    matter_ids: exactMatterIds(body),
  };
}
