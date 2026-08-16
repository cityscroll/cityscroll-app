/** Canonical community-board identity and institution-page links. */

const BOROUGH_SLUGS = Object.freeze({
  Bronx: "bronx",
  Brooklyn: "brooklyn",
  Manhattan: "manhattan",
  Queens: "queens",
  "Staten Island": "staten-island",
});

const BOROUGH_CODES = Object.freeze({
  BX: "Bronx",
  BK: "Brooklyn",
  M: "Manhattan",
  MN: "Manhattan",
  Q: "Queens",
  QN: "Queens",
  SI: "Staten Island",
});

const COMMUNITY_DISTRICT_CODES = Object.freeze({
  bronx: { borough: "Bronx", prefix: "X" },
  brooklyn: { borough: "Brooklyn", prefix: "K" },
  manhattan: { borough: "Manhattan", prefix: "M" },
  queens: { borough: "Queens", prefix: "Q" },
  "staten-island": { borough: "Staten Island", prefix: "R" },
});

function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function boroughName(value) {
  const text = clean(value).toLowerCase();
  return Object.keys(BOROUGH_SLUGS).find((borough) => borough.toLowerCase() === text)
    || Object.entries(BOROUGH_CODES).find(([code]) => code.toLowerCase() === text)?.[1]
    || null;
}

function canonicalId(value) {
  const id = clean(value).toLowerCase().replace(/^community-board:/, "");
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(id) ? id : null;
}

function idFor(borough, number) {
  const name = boroughName(borough);
  const district = Number(number);
  if (!name || !Number.isInteger(district) || district < 1 || district > 18) return null;
  return `${BOROUGH_SLUGS[name]}-cb-${String(district).padStart(2, "0")}`;
}

/**
 * Resolve a board only from explicit publisher/body evidence. A bare board
 * number is accepted only when the same evidence supplies a borough.
 */
export function communityBoardIdFromEvidence(evidence, { borough = null } = {}) {
  const values = Array.isArray(evidence) ? evidence : [evidence];
  const text = values.map(clean).filter(Boolean).join(" | ");
  const direct = text.match(/(?:^|[\s:])(?:community-board:)?([a-z]+(?:-[a-z]+)*-cb-\d{2})(?:$|[\s|])/i);
  if (direct) return canonicalId(direct[1]);

  const coded = text.match(/(?:^|[^A-Z0-9])(BX|BK|MN|QN|SI)\s*CB\s*0?(\d{1,2})\b/i);
  if (coded) return idFor(BOROUGH_CODES[coded[1].toUpperCase()], coded[2]);

  const named = text.match(/\bcommunity\s+board\s*(?:#|no\.?\s*)?0?(\d{1,2})(?:\s*,?\s*(Bronx|Brooklyn|Manhattan|Queens|Staten\s+Island))?\b/i);
  if (named) return idFor(named[2] || borough, named[1]);

  const reverseNamed = text.match(/\bcommunity\s+board\s+(Bronx|Brooklyn|Manhattan|Queens|Staten\s+Island)\s*0?(\d{1,2})\b/i);
  if (reverseNamed) return idFor(reverseNamed[1], reverseNamed[2]);

  const compact = text.match(/\bCB\s*0?(\d{1,2})\b/i);
  return compact ? idFor(borough, compact[1]) : null;
}

/** Return the one canonical institution-page route, or null when unresolved. */
export function communityBoardPageHref(value, options = {}) {
  const id = canonicalId(value) || communityBoardIdFromEvidence(value, options);
  return id ? `/community-boards/${encodeURIComponent(id)}/` : null;
}

/** Resolve an exact board id to its community-district place route. */
export function communityBoardPlaceHref(value) {
  const id = canonicalId(value);
  const match = id?.match(/^(.+)-cb-(\d{2})$/);
  const district = match ? COMMUNITY_DISTRICT_CODES[match[1]] : null;
  if (!district) return null;
  const communityDistrict = `${district.prefix}${match[2]}`;
  return `/near-you/#map?level=community_district&parent=${encodeURIComponent(district.borough)}&id=${encodeURIComponent(communityDistrict)}&lens=meetings`;
}

export function resolvedCommunityBoardId(value, options = {}) {
  return canonicalId(value) || communityBoardIdFromEvidence(value, options);
}

export function communityBoardCommitteePageHref(board, committee) {
  const base = communityBoardPageHref(board);
  const slug = clean(committee).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base && slug ? `${base}#committee-${encodeURIComponent(slug)}` : null;
}
