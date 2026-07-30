// Rules are citywide unless their scope text says otherwise. Hearing venues never
// narrow a rule; Agency Rules hearing rows receive their affected area from the
// hearing extractor through the explicit hearingArea option.

import { boroughsIn, plainText, unique } from "./location_extract.mjs";

const BODY_FIELDS = [
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3", "printout_1", "printout_2", "printout_3",
];

function ruleText(row) {
  return plainText([
    row.short_title,
    ...BODY_FIELDS.map((field) => row[field]),
  ].filter(Boolean).join(" "));
}

function scopeSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) =>
    /\b(?:appl(?:y|ies|icable)|effective|limited|restricted|only|boundar(?:y|ies)|district charge|establish(?:ment)?|extension|modification)\b/i.test(sentence)
    && /\b(?:borough|district|Times Square area)\b/i.test(sentence));
}

function namedDistricts(text) {
  const districts = [];
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9.'’&-]*(?:\s+[A-Z][A-Za-z0-9.'’&-]*){0,5}\s+business improvement district)\b/g)) {
    districts.push(plainText(match[1]));
  }
  for (const match of text.matchAll(/\b(Times Square area)\b/gi)) {
    districts.push("Times Square area");
  }
  return unique(districts);
}

export function isRuleHearing(row) {
  return row.type_of_notice_description === "Public Hearings" && !!row.event_date;
}

export function ruleLocationFromRow(row, options = {}) {
  if (isRuleHearing(row) && options.hearingArea) {
    return {
      ...structuredClone(options.hearingArea),
      source: "hearing",
    };
  }

  const text = ruleText(row);
  const scoped = plainText([
    plainText(row.short_title),
    ...scopeSentences(text),
  ].join(" "));
  const districts = namedDistricts(scoped);
  const boroughs = unique(boroughsIn(scoped));
  const local = districts.length || boroughs.length;
  return {
    scope: local ? "local" : "citywide",
    boroughs,
    neighborhoods: [],
    districts,
    addresses: [],
    tax_lots: [],
    source: "rule-scope",
  };
}
