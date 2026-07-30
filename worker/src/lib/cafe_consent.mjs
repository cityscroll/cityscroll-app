// Parse Dining Out NYC revocable-consent petitions out of City Record hearing
// notices. These are place-scoped matters (one or more cafe addresses) that the
// generic hearing address regex often under-captures ("Avenue A", "Av").

import {
  canonicalBorough,
  normalizeAddress,
  plainText,
  unique,
} from "../../../site/location_extract.mjs";

const CAFE_KIND_RE = /\b(roadway|sidewalk)\s+cafe\b/i;
const DINING_OUT_HINT_RE = /\b(?:dining\s*out\s*nyc|revocable\s+consent|roadway\s+cafe|sidewalk\s+cafe)\b/i;
const BOROUGH_NAMES = "Manhattan|Brooklyn|Queens|Bronx|the Bronx|Staten Island";

// Match the fixed cafe phrase + address + borough. Petitioner is recovered from
// the preceding text so flattened multi-item lists still split cleanly.
const CAFE_PHRASE_RE = new RegExp(
  String.raw`to\s+maintain,\s*operate,\s*and\s*use\s+a\s+(roadway|sidewalk)\s+cafe\s+` +
  String.raw`for\s+a\s+term\s+of\s+(?:four|4)\s+years\s+adjacent\s+to\s+` +
  String.raw`(?:the\s+proposed\s+revocable\s+consent\s+is\s+for\s+a\s+term\s+of\s+(?:four|4)\s+years\s+adjacent\s+to\s+)?` +
  String.raw`(\d[A-Za-z0-9.'’\- ]{2,70}?)\s+` +
  String.raw`in\s+the\s+[Bb]orough\s+of\s+(${BOROUGH_NAMES})\b`,
  "gi",
);

const BODY_FIELDS = [
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3", "printout_1", "printout_2", "printout_3",
];

function bodyFromRow(row) {
  return plainText([
    row.short_title,
    ...BODY_FIELDS.map((field) => row[field]),
  ].filter(Boolean).join(" "));
}

function cleanPetitioner(value) {
  return plainText(value)
    .replace(/^(?:a\s+proposed\s+)?modification\s+to\s+an\s+existing\s+revocable\s+consent\s+authorizing\s+/i, "")
    .replace(/^authorizing\s+/i, "")
    .replace(/^the\s+following:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAddress(value) {
  return normalizeAddress(value)
    .replace(/\s+/g, " ")
    .replace(/\bAv\b/gi, "Ave")
    .replace(/\b1\s+Ave\b/gi, "1st Ave")
    .replace(/\b2\s+Ave\b/gi, "2nd Ave")
    .replace(/\b3\s+Ave\b/gi, "3rd Ave")
    .replace(/\b(\d+)\s+Ave\b/gi, "$1th Ave")
    .trim();
}

function petitionerFromPrefix(prefix) {
  let chunk = String(prefix || "");
  // Drop everything through the previous petition's borough close.
  chunk = chunk.replace(
    new RegExp(
      String.raw`^[\s\S]*\bin\s+the\s+borough\s+of\s+(?:${BOROUGH_NAMES})\s*`,
      "i",
    ),
    "",
  );
  chunk = chunk
    .replace(/^[\s\S]*\bauthorizing\s+the\s+following:\s*/i, "")
    .replace(/^[\s\S]*\bMeeting ID:\s*[\d\s]+/i, "")
    .replace(/^[\s\S]*\bPhone:\s*[+\d().\s-]+/i, "")
    .replace(/^[\s\S]*\bpetition for revocable consent:\s*/i, "")
    .replace(/^[\s\S]*?\bauthorizing\s+/i, "")
    .replace(/^(?:a\s+proposed\s+)?modification\s+to\s+an\s+existing\s+revocable\s+consent\s+/i, "")
    .trim();
  // Keep the trailing entity-looking span (names often include LLC/INC/Corp).
  const entity = chunk.match(
    /([A-Z0-9][A-Za-z0-9.'’&() /-]{1,120}(?:\s+\([^)]{1,60}\))?)\s*$/,
  );
  return cleanPetitioner(entity ? entity[1] : chunk);
}

function petitionsFromText(text) {
  const found = [];
  CAFE_PHRASE_RE.lastIndex = 0;
  for (const match of text.matchAll(CAFE_PHRASE_RE)) {
    const cafe_type = String(match[1] || "").toLowerCase();
    const address = cleanAddress(match[2]);
    const borough = canonicalBorough(match[3]);
    const prefix = text.slice(Math.max(0, match.index - 220), match.index);
    const petitioner = petitionerFromPrefix(prefix);
    if (!address || !borough || !CAFE_KIND_RE.test(`${cafe_type} cafe`)) continue;
    if (petitioner.length < 2 || petitioner.length > 160) continue;
    if (/public hearing|notice is hereby|zoom meeting|meeting id|pursuant to law|join the hearing/i.test(petitioner)) {
      continue;
    }
    found.push({
      petitioner,
      cafe_type,
      address: { label: address, borough },
      borough,
    });
  }
  const seen = new Set();
  return found.filter((item) => {
    const key = `${item.petitioner}|${item.cafe_type}|${item.address.label}|${item.borough}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isDiningOutConsentNotice(row) {
  const title = plainText(row?.short_title);
  const body = bodyFromRow(row || {});
  if (/dining\s*out\s*nyc/i.test(title)) return true;
  if (DINING_OUT_HINT_RE.test(body) && CAFE_KIND_RE.test(body) && /\badjacent\s+to\b/i.test(body)) {
    return true;
  }
  return false;
}

export function extractCafeConsentPetitions(row) {
  if (!row) return [];
  return petitionsFromText(bodyFromRow(row));
}

export function cafeConsentPlacesFromRow(row) {
  return extractCafeConsentPetitions(row).map((petition) => ({
    label: petition.address.label,
    borough: petition.borough,
    neighborhood: null,
    latitude: null,
    longitude: null,
    bbl: null,
    community_district: null,
    council_district: null,
    cafe_type: petition.cafe_type,
    petitioner: petition.petitioner,
  }));
}

export function cafeConsentBoroughs(row) {
  return unique(extractCafeConsentPetitions(row).map((petition) => petition.borough));
}
