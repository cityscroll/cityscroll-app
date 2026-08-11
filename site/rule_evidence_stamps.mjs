/**
 * Pure, bounded rule-evidence extraction for offline City Record snapshots.
 *
 * Source prose is accepted only as ephemeral input. The returned stamp contains
 * compact tokens, canonical legal keys, ISO dates, and closed enums.
 */

export const RULE_EVIDENCE_STAMP_SCHEMA = "cityscroll.rule_evidence_stamp.v1";
export const RULE_EVIDENCE_STAMP_LIMITS = Object.freeze({
  topic_keys: 32,
  body_topic_keys: 32,
  citation_keys: 16,
  negative_evidence: 8,
});

export const RULE_LIFECYCLE_STATUSES = Object.freeze([
  "proposal",
  "hearing",
  "adopted",
  "emergency",
  "withdrawn",
  "repealed",
  "rescinded",
  "superseded",
  "cancelled",
  "rejected",
  "not_adopted",
  "notice",
  "unknown",
]);

export const RULE_NEGATIVE_EVIDENCE = Object.freeze([
  "rule_withdrawn",
  "rule_repealed",
  "rule_rescinded",
  "rule_superseded",
  "rule_cancelled",
  "rule_rejected",
  "rule_not_adopted",
]);

const TOPIC_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "by", "with", "from",
  "as", "at", "is", "are", "be", "been", "was", "were", "will", "shall", "must", "may",
  "that", "this", "these", "those", "such", "each", "any", "all", "other", "into", "its",
  "their", "them", "they", "his", "her", "under", "over", "within", "without", "upon",
  "department", "commissioner", "agency", "city", "new", "york", "nyc", "mayor",
  "council", "speaker", "submit", "submitted", "regarding", "necessary", "including",
  "pursuant", "section", "sections", "code", "administrative", "local", "law", "rules",
  "rule", "promulgate", "implement", "carry", "out", "develop", "ensure", "provide",
  "prepare", "post", "website", "public", "number", "date", "year", "years", "days",
  "after", "before", "later", "than", "no", "not", "more", "less", "least", "most",
  "report", "reports", "study", "plan", "plans", "program", "programs", "notice",
  "hearing", "comment", "comments", "testify", "testimony", "email", "phone", "contact", "call",
  "proposed", "proposal", "adoption", "adopted", "amendment", "amendments", "relating",
  "charter", "rcny", "secs", "authority", "granted", "hereby", "gives", "given", "title",
]);

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const MONTH_NAME = Object.keys(MONTHS).join("|");
const NAMED_DATE = `(?:${MONTH_NAME})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,)?\\s+\\d{4}`;
const NUMERIC_DATE = `\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}`;
const ISO_DATE = `\\d{4}-\\d{2}-\\d{2}`;
const DATE_FRAGMENT = `(${NAMED_DATE}|${NUMERIC_DATE}|${ISO_DATE})`;

function compactText(value, max = 60_000) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&sect;/gi, "§")
    .replace(/&#167;/gi, "§")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function withoutContacts(value) {
  return compactText(value)
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, " ");
}

export function compactEvidenceTokens(value, { limit = Number.POSITIVE_INFINITY } = {}) {
  const words = withoutContacts(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && token.length <= 40)
    .filter((token) => !TOPIC_STOPWORDS.has(token) && !/^\d+$/.test(token));
  return [...new Set(words)].slice(0, limit);
}

function normalizeSection(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^section/, "§")
    .replace(/[.,;:]+$/g, "");
}

/**
 * Emit parent citation keys so § 753(e)(2) also matches a densified
 * “Section 753 of the Charter” stamp without inventing a new relation.
 * Only expands when the source key already carries a parenthetical subsection.
 */
export function expandCitationKeyParents(keys = [], { limit = RULE_EVIDENCE_STAMP_LIMITS.citation_keys } = {}) {
  const out = [];
  const seen = new Set();
  const add = (key) => {
    const clean = String(key || "").toLowerCase().trim();
    if (!clean || seen.has(clean) || out.length >= limit) return;
    seen.add(clean);
    out.push(clean);
  };
  for (const key of Array.isArray(keys) ? keys : []) {
    add(key);
    const match = String(key || "").toLowerCase().match(
      /^(nyc-charter|nyc-admin-code|section):([0-9]+[a-z]?)(?:[().].+)$/,
    );
    if (!match) continue;
    add(`${match[1]}:${match[2]}`);
    // Prefer scheme-qualified parent forms for charter / admin-code so a bare
    // section:1 from PDF prose cannot satisfy a specific mandate alone.
    if (match[1] === "nyc-charter" || match[1] === "nyc-admin-code") {
      add(`${match[1]}:${match[2]}`);
    }
  }
  return out;
}

/**
 * Strong citation keys may alone establish citation_law_match.
 * Bare `section:N` tokens are too generic in densified PDF prose.
 */
export function isStrongCitationKey(key) {
  const value = String(key || "").toLowerCase().trim();
  if (!value) return false;
  if (/^(nyc-charter|nyc-admin-code|local-law|rcny):/.test(value)) return true;
  // section with real subsection / multi-part identifier (16-306, 753(e)(2))
  if (/^section:[0-9]+[a-z0-9]*[()-]/.test(value)) return true;
  if (/^section:[0-9]+-[0-9]/.test(value)) return true;
  return false;
}

function isPlausibleSectionToken(value) {
  const token = normalizeSection(value).replace(/^§/, "");
  // Reject OCR/prose fragments (“section:and”, “section:by”).
  return /^[0-9]+[a-z0-9().-]*$/i.test(token);
}

/** Canonical legal references shared by the snapshot and mandate evaluator. */
export function compactCitationLawKeys(value, { limit = RULE_EVIDENCE_STAMP_LIMITS.citation_keys } = {}) {
  const text = compactText(value).toLowerCase();
  if (!text) return [];
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key) && keys.length < limit) keys.push(key);
  };
  const addCharter = (raw) => {
    if (!isPlausibleSectionToken(raw)) return;
    const section = normalizeSection(raw).replace(/^§/, "");
    add(`nyc-charter:${section}`);
    // Parent form for subsection matches against densified “Section N” stamps.
    const parent = section.match(/^([0-9]+[a-z]?)/i);
    if (parent) add(`nyc-charter:${parent[1].toLowerCase()}`);
  };
  const addAdmin = (raw) => {
    if (!isPlausibleSectionToken(raw)) return;
    const section = normalizeSection(raw).replace(/^§/, "");
    add(`nyc-admin-code:${section}`);
    const parent = section.match(/^([0-9]+[a-z]?)/i);
    if (parent) add(`nyc-admin-code:${parent[1].toLowerCase()}`);
  };
  const addSection = (raw) => {
    if (!isPlausibleSectionToken(raw)) return;
    const section = normalizeSection(raw).replace(/^§/, "");
    add(`section:${section}`);
    const parent = section.match(/^([0-9]+[a-z]?)/i);
    if (parent && parent[1].toLowerCase() !== section) add(`section:${parent[1].toLowerCase()}`);
  };

  // “Charter § 753” / “NYC Charter section 1043”
  for (const match of text.matchAll(/(?:new york city|nyc|city)?\s*charter\s*(?:§{1,2}|section)?\s*(\d[a-z0-9().-]*)/g)) {
    addCharter(match[1]);
  }
  // Inverted City Record PDF form: “Section 753 and Section 1043(g) of the Charter”
  for (const match of text.matchAll(
    /sections?\s+((?:[0-9][a-z0-9().-]*|\s+|,|and|&|sections?)+?)\s+of\s+(?:the\s+)?(?:new york city|nyc|city)?\s*charter/g,
  )) {
    for (const part of match[1].match(/[0-9][a-z0-9().-]*/g) || []) addCharter(part);
  }
  for (const match of text.matchAll(/(?:new york city|nyc|city)?\s*administrative\s+code\s*(?:§{1,2}|section)?\s*(\d[a-z0-9().-]*)/g)) {
    addAdmin(match[1]);
  }
  for (const match of text.matchAll(
    /sections?\s+((?:[0-9][a-z0-9().-]*|\s+|,|and|&|sections?)+?)\s+of\s+(?:the\s+)?(?:new york city|nyc|city)?\s*administrative\s+code/g,
  )) {
    for (const part of match[1].match(/[0-9][a-z0-9().-]*/g) || []) addAdmin(part);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s+rcny\s*(?:§{1,2}|section)?\s*([a-z0-9][a-z0-9().-]*)/g)) {
    add(`rcny:${match[1]}:${normalizeSection(match[2]).replace(/^§/, "")}`);
  }
  for (const match of text.matchAll(/\blocal\s+law(?:\s+(?:no\.?|number))?\s*([a-z0-9.-]+)(?:\s+of\s+(\d{4}))?/g)) {
    add(match[2] ? `local-law:${match[2]}:${match[1]}` : `local-law:${match[1]}`);
  }
  for (const match of text.matchAll(/(?:§{1,2}|section)\s*([0-9][a-z0-9().-]*)/g)) {
    addSection(match[1]);
  }
  return expandCitationKeyParents(keys, { limit });
}

function validIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDateToken(value) {
  const text = compactText(value, 80).toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g, "$1");
  let match = text.match(new RegExp(`^(${MONTH_NAME})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i"));
  if (match) return validIsoDate(match[3], MONTHS[match[1].toLowerCase()], match[2]);
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) return validIsoDate(match[3], match[1], match[2]);
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? validIsoDate(match[1], match[2], match[3]) : null;
}

function extractContextDate(text, patterns) {
  for (const source of patterns) {
    const match = text.match(new RegExp(source.replace("{DATE}", DATE_FRAGMENT), "i"));
    const parsed = match ? parseDateToken(match[1]) : null;
    if (parsed) return parsed;
  }
  return null;
}

function lifecycleAndNegative(text, type) {
  const negative = [];
  const checks = [
    ["withdrawn", /\bwithdrawal\s+of\s+(?:the\s+)?(?:proposed\s+)?(?:rules?|proposal)\b|\b(?:rules?|proposal)\b[^.]{0,60}\bwithdrawn\b/i, "rule_withdrawn"],
    ["repealed", /\brepeal\s+of\b[^.]{0,80}\b(?:rules?|provisions?)\b|\b(?:rules?|provisions?)\b[^.]{0,60}\brepealed\b/i, "rule_repealed"],
    ["rescinded", /\brescission\s+of\b[^.]{0,60}\b(?:rules?|proposal)\b|\b(?:rules?|proposal)\b[^.]{0,60}\brescinded\b/i, "rule_rescinded"],
    ["superseded", /\b(?:rules?|proposal)\b[^.]{0,60}\bsuperseded\b/i, "rule_superseded"],
    ["cancelled", /\b(?:rulemaking|hearing|rules?|proposal|notice)\b[^.]{0,60}\bcancel(?:led|ed)\b|\bcancellation\s+of\s+(?:the\s+)?(?:rulemaking|hearing|proposed\s+rules?)\b/i, "rule_cancelled"],
    ["rejected", /\b(?:rules?|proposal)\b[^.]{0,60}\brejected\b/i, "rule_rejected"],
    ["not_adopted", /\bnot(?:\s+[a-z]+){0,3}\s+adopted\b/i, "rule_not_adopted"],
  ];
  let adverseStatus = null;
  for (const [status, pattern, evidence] of checks) {
    if (!pattern.test(text)) continue;
    if (!adverseStatus) adverseStatus = status;
    negative.push(evidence);
  }
  if (adverseStatus) return { lifecycle_status: adverseStatus, negative_evidence: negative };
  if (/\bnotice\s+of\s+adoption\b|\badoption\s+of\b|\badopted\b|\bfinal\s+rule\b/i.test(text)) {
    return { lifecycle_status: "adopted", negative_evidence: [] };
  }
  if (/\bpublic\s+hearing\b|\bhearing\b/i.test(`${text} ${type}`)) {
    return { lifecycle_status: "hearing", negative_evidence: [] };
  }
  if (/\bproposed\b|\bproposal\b|\bopportunity\s+to\s+comment\b|\bcomment\s+period\b/i.test(text)) {
    return { lifecycle_status: "proposal", negative_evidence: [] };
  }
  if (/\bemergency\s+rule\b|\bemergency\s+adoption\b/i.test(text)) {
    return { lifecycle_status: "emergency", negative_evidence: [] };
  }
  if (/\bnotice\b/i.test(text)) return { lifecycle_status: "notice", negative_evidence: [] };
  return { lifecycle_status: "unknown", negative_evidence: [] };
}

function sourceBody(row) {
  return [
    row?.additional_description_1,
    row?.additional_description_2,
    row?.additional_description_3,
    row?.other_info_1,
    row?.printout_1,
  ].filter(Boolean).join(" ");
}

function sourceTopicBody(row) {
  return [
    row?.additional_description_1,
    row?.additional_description_2,
    row?.additional_description_3,
  ].filter(Boolean).join(" ");
}

/**
 * Derive one compact stamp without mutating the source row or retaining prose.
 */
export function extractRuleEvidenceStamp(row = {}) {
  const title = compactText(row.short_title || row.title, 1000);
  const type = compactText(row.type_of_notice_description || row.notice_type, 200);
  const body = compactText(sourceBody(row));
  const topicBody = compactText(sourceTopicBody(row));
  const text = `${title} ${type} ${body}`.trim();
  const lifecycle = lifecycleAndNegative(text, type);
  const effectiveDate = extractContextDate(text, [
    `(?:effective\\s+date(?:\\s+(?:is|will\\s+be|shall\\s+be))?|effective\\s+(?:on|as\\s+of)|(?:shall\\s+)?take\\s+effect)(?:\\s+on)?[\\s:,-]*{DATE}`,
  ]);
  const adoptionDate = extractContextDate(text, [
    `(?:date\\s+of\\s+adoption|adoption\\s+date)(?:\\s+(?:is|was))?[\\s:,-]*{DATE}`,
    `\\badopted\\s+on[\\s:,-]*{DATE}`,
  ]);

  return {
    schema: RULE_EVIDENCE_STAMP_SCHEMA,
    topic_keys: compactEvidenceTokens(`${title} ${topicBody}`, {
      limit: RULE_EVIDENCE_STAMP_LIMITS.topic_keys,
    }),
    body_topic_keys: compactEvidenceTokens(topicBody, {
      limit: RULE_EVIDENCE_STAMP_LIMITS.body_topic_keys,
    }),
    citation_keys: compactCitationLawKeys(text),
    lifecycle_status: lifecycle.lifecycle_status,
    effective_date: effectiveDate,
    adoption_date: adoptionDate,
    negative_evidence: lifecycle.negative_evidence.slice(
      0,
      RULE_EVIDENCE_STAMP_LIMITS.negative_evidence,
    ),
  };
}
