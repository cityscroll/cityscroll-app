/**
 * Bounded venue street-span extraction: lift the one house-number-anchored
 * street span out of a source-qualified venue address line that carries a
 * building-name prefix and/or a trailing room (the "at 515 Malcolm X
 * Boulevard" shape). Not a first-number heuristic — the result still flows
 * through exact address parsing, which requires one unambiguous candidate
 * and a noncontradictory locality. Kept out of meeting_location_assertions.mjs
 * so this venue-specific parsing never rides the Notice route's cold path.
 */
import {
  MLA_SUBJECT_ADDRESS,
  expandPublishedStreetSpan,
  isDateShapedVenueText,
  mlaClean,
  mlaNormalizeStreetKey,
} from "./meeting_location_assertions.mjs";

const LOCALITY_RES = Object.freeze([
  /^\d{5}(?:-\d{4})?$/,
  /^ny$/i,
  /^(?:ny|new york(?: city)?)\s+\d{5}(?:-\d{4})?$/i,
  /^(?:brooklyn|bronx|queens|manhattan|staten island|new york(?: city)?)$/i,
]);
const LOCALITY_SKIP_RES = Object.freeze([
  /^(?:usa|u\.s\.?)$/i,
]);

function isLocalitySegment(segment) {
  return LOCALITY_RES.some((pattern) => pattern.test(segment));
}

function isSkippableLocalitySegment(segment) {
  return LOCALITY_SKIP_RES.some((pattern) => pattern.test(segment));
}

// Ordinal street words (East 16th, 125th) are legitimate; a second bare
// number marks range/competing address content.
function hasCompetingNumber(stem) {
  const withoutOrdinals = String(stem || "").replace(/\b\d{1,3}(?:st|nd|rd|th)\b/gi, "");
  return /\d/.test(withoutOrdinals);
}

export function extractVenueStreetSpan(value) {
  const text = mlaClean(value, 500);
  if (!text || isDateShapedVenueText(text)) return null;
  // Parenthetical cross-street references are display context, not spans.
  const flat = text.replace(/\([^()]*\)/g, ", ");
  const segments = flat.split(",")
    .map((part) => mlaClean(part, 200))
    .filter(Boolean);

  const matches = [];
  for (const segment of segments) {
    for (const match of segment.matchAll(new RegExp(MLA_SUBJECT_ADDRESS, "gi"))) {
      const span = mlaClean(match[1], 200);
      const house = span.match(/^\d{1,5}(?:-\d{1,5})?/)?.[0] || "";
      matches.push({ stem: span.slice(house.length), span });
    }
  }
  if (matches.length === 0) return null;
  if (matches.some((match) => hasCompetingNumber(match.stem))) return null;

  const distinct = new Set(matches.map((match) => mlaNormalizeStreetKey(match.span)));
  if (distinct.size !== 1) return null;

  const span = expandPublishedStreetSpan(matches[0].span) || matches[0].span;
  if (!span || isDateShapedVenueText(span)) return null;

  const localitySegments = [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (isSkippableLocalitySegment(segment)) continue;
    if (!isLocalitySegment(segment)) break;
    localitySegments.unshift(segment);
  }

  return {
    span,
    locality: localitySegments.length ? localitySegments.join(", ") : null,
  };
}
