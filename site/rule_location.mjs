// Rules are citywide unless their scope text says otherwise. Hearing venues never
// narrow a rule; Agency Rules hearing rows receive their affected area from the
// hearing extractor through the explicit hearingArea option.
//
// Human-derivation (site owner): also read borough / district phrases in the title
// and rule text the way a location-interested reader would — not only the narrow
// "scope sentence" gate — before defaulting to citywide.

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
  const title = plainText(row.short_title);
  const scoped = plainText([
    title,
    ...scopeSentences(text),
  ].join(" "));
  const districts = namedDistricts(scoped);
  // Title + scope-sentence borough words only. Never scan the full body for bare
  // borough names — that turns a comment-drop venue ("comments at 280 Broadway in
  // Manhattan") into a local rule pin.
  const boroughs = unique([
    ...boroughsIn(scoped),
    ...boroughsIn(title),
  ]);
  // Explicit "applies only within the Borough of X" / "Borough of X" limitation language.
  for (const match of text.matchAll(
    /\b(?:appl(?:y|ies|icable)|limited|restricted|only|within)\b[^.]{0,80}?\bBorough\s+of\s+(?:the\s+)?(Bronx|Manhattan|Brooklyn|Queens|Staten\s+Island)\b/gi,
  )) {
    boroughs.push(plainText(match[1]).replace(/\s+/g, " "));
  }
  for (const match of text.matchAll(
    /\bBorough\s+of\s+(?:the\s+)?(Bronx|Manhattan|Brooklyn|Queens|Staten\s+Island)\b/gi,
  )) {
    // Require a limiting verb nearby so venue addresses don't count.
    const start = Math.max(0, match.index - 60);
    const window = text.slice(start, match.index + match[0].length);
    if (/\b(?:appl(?:y|ies|icable)|limited|restricted|only|within|effective|boundar)/i.test(window)) {
      boroughs.push(plainText(match[1]).replace(/\s+/g, " "));
    }
  }
  const boroughsFinal = unique(boroughs);
  const local = districts.length || boroughsFinal.length;
  if (local) {
    return {
      scope: "local",
      boroughs: boroughsFinal,
      neighborhoods: [],
      districts,
      addresses: [],
      tax_lots: [],
      source: "rule-scope",
      derivation: {
        methods: ["matter_title_place"],
        confidence: 0.88,
        role: "matter",
        evidence: [title.slice(0, 160) || scoped.slice(0, 160)],
      },
      confidence_tier: "strong",
    };
  }

  // Citywide default when no local pin — never promote venue/comment addresses.
  return {
    scope: "citywide",
    boroughs: [],
    neighborhoods: [],
    districts: [],
    addresses: [],
    tax_lots: [],
    source: "rule-scope",
    derivation: {
      methods: ["rule_default_citywide"],
      confidence: 0.8,
      role: "citywide",
      evidence: ["Agency Rules with no local scope phrase"],
    },
    confidence_tier: "strong",
  };
}
