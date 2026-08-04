// Pure, evidence-carrying extraction of facts that City Record publishers sometimes
// place only in notice prose. Patterns are deliberately label-bound: an arbitrary
// date, number, or organization name is not a structured fact.
//
// Solicitation procurement-method markers (Admin Code §6-129 goals, M/WBE
// Noncompetitive Small Purchase, accelerated timing) and the derived response
// floor live under `procurement_method` — see solicitation_procurement_method.mjs.

import { plainText } from "../../../site/text_clean.mjs";
import { extractSolicitationProcurementMethod } from "./solicitation_procurement_method.mjs";

const MONTHS = new Map([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4],
  ["may", 5], ["june", 6], ["july", 7], ["august", 8],
  ["september", 9], ["october", 10], ["november", 11], ["december", 12],
]);
const MAX_FACTS_PER_KIND = 32;

function noticeBody(row) {
  return plainText([
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.printout_1,
    row.printout_2,
    row.printout_3,
    // D1 mirror names for the same source fields.
    row.description,
    row.other_info,
    row.printout,
  ].filter(Boolean).join(" "));
}

function evidence(value) {
  return plainText(value).replace(/\s+/g, " ").trim().slice(0, 280);
}

function two(n) {
  return String(n).padStart(2, "0");
}

function parseDate(value) {
  const s = String(value || "").trim();
  let year;
  let month;
  let day;
  let match = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})\b/.exec(s);
  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
    if (year < 100) year += 2000;
  } else {
    match = /\b(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
    if (!match) return null;
    month = MONTHS.get(match[1].toLowerCase());
    day = Number(match[2]);
    year = Number(match[3]);
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${two(month)}-${two(day)}`;
}

function parseTime(value) {
  const match = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i.exec(String(value || ""));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = match[3].toLowerCase().startsWith("p");
  if (hour === 12) hour = 0;
  if (pm) hour += 12;
  return `${two(hour)}:${two(minute)}:00`;
}

function deadline(kind, dateText, timeText, matchedText) {
  const date = parseDate(dateText);
  const time = parseTime(timeText);
  if (!date || !time) return null;
  return {
    kind,
    at: `${date} ${time}`,
    source: "notice_body",
    evidence: evidence(matchedText),
  };
}

function uniqueFacts(facts, key) {
  const seen = new Set();
  return facts.filter((fact) => {
    const value = key(fact);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractIdentifiers(text) {
  const facts = [];
  const pattern = /\b(e-?pin|pin)\s*(?:number|no\.?)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,30})\b/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[2].toUpperCase().replace(/-+$/, "");
    if (!/\d/.test(value)) continue;
    facts.push({
      kind: /^e/i.test(match[1]) ? "epin" : "pin",
      value,
      source: "notice_body",
      evidence: evidence(match[0]),
    });
  }
  return uniqueFacts(facts, (fact) => `${fact.kind}:${fact.value}`).slice(0, MAX_FACTS_PER_KIND);
}

function extractDeadlines(text) {
  const facts = [];
  const longDate = "(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}";
  const numericDate = "\\d{1,2}[-/]\\d{1,2}[-/](?:\\d{2}|\\d{4})";
  const date = `(?:${longDate}|${numericDate})`;
  const time = "\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)";

  const submissionPatterns = [
    new RegExp(`\\b(?:responses|proposals|bids)\\s+(?:are\\s+)?due(?:\\s+no\\s+later\\s+than)?\\s+(${date})\\s+(?:at|by)\\s+(${time})`, "gi"),
    new RegExp(`\\bdue\\s+(${numericDate})\\s+(?:at|by)\\s+(${time})`, "gi"),
  ];
  for (const pattern of submissionPatterns) {
    for (const match of text.matchAll(pattern)) {
      const fact = deadline("submission", match[1], match[2], match[0]);
      if (fact) facts.push(fact);
    }
  }

  const testimonyPattern = new RegExp(`\\ball\\s+written\\s+testimony\\s+must\\s+be\\s+received\\s+by\\s+(${time})\\s+on\\s+(${date})`, "gi");
  for (const match of text.matchAll(testimonyPattern)) {
    const fact = deadline("testimony", match[2], match[1], match[0]);
    if (fact) facts.push(fact);
  }
  return uniqueFacts(facts, (fact) => `${fact.kind}:${fact.at}`).slice(0, MAX_FACTS_PER_KIND);
}

function cleanPartyName(value) {
  return evidence(value).replace(/[.,;:\s]+$/, "").trim();
}

function extractParties(text) {
  const facts = [];
  const pattern = /\bAPPLICANT\s*[-–—:]\s*([^.;]{2,160}?),\s*for\s+([^.;]{2,160}?),\s*owner\b/gi;
  for (const match of text.matchAll(pattern)) {
    const applicant = cleanPartyName(match[1]);
    const owner = cleanPartyName(match[2]);
    const shared = evidence(match[0]);
    if (applicant) facts.push({ role: "applicant", name: applicant, source: "notice_body", evidence: shared });
    if (owner) facts.push({ role: "owner", name: owner, source: "notice_body", evidence: shared });
  }
  return uniqueFacts(facts, (fact) => `${fact.role}:${fact.name.toLowerCase()}`).slice(0, MAX_FACTS_PER_KIND);
}

export function extractNoticeFacts(row = {}) {
  const text = noticeBody(row);
  const procurement_method = extractSolicitationProcurementMethod(row);
  if (!text) {
    return {
      identifiers: [],
      deadlines: [],
      parties: [],
      procurement_method,
    };
  }
  return {
    identifiers: extractIdentifiers(text),
    deadlines: extractDeadlines(text),
    parties: extractParties(text),
    procurement_method,
  };
}

// Existing product columns may use a text-derived value only when the parser found
// one unambiguous labeled fact. Testimony and other deadlines never become bid due dates.
export function noticeFactsFallbacks(facts) {
  const identifiers = facts?.identifiers || [];
  const deadlines = (facts?.deadlines || []).filter((fact) => fact.kind === "submission");
  const ids = [...new Set(identifiers.map((fact) => fact.value))];
  const due = [...new Set(deadlines.map((fact) => fact.at))];
  return {
    pin: ids.length === 1 ? ids[0] : null,
    due_date: due.length === 1 ? due[0] : null,
  };
}
