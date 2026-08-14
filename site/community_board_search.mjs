/**
 * Search helpers for the ambiguous NYC community-board shorthand.
 *
 * "Community Board 3" is a valid query but not a unique institution: each
 * borough has a board 3. Keep the distinction between the board number and
 * the borough explicit so a search can offer disambiguation without inventing
 * a meeting or an institutional join.
 */

export const COMMUNITY_BOARD_BOROUGHS = Object.freeze([
  Object.freeze({ name: "Bronx", slug: "bronx" }),
  Object.freeze({ name: "Brooklyn", slug: "brooklyn" }),
  Object.freeze({ name: "Manhattan", slug: "manhattan" }),
  Object.freeze({ name: "Queens", slug: "queens" }),
  Object.freeze({ name: "Staten Island", slug: "staten-island" }),
]);

const BOROUGH_ALIASES = new Map([
  ["bronx", "Bronx"],
  ["bronx county", "Bronx"],
  ["brooklyn", "Brooklyn"],
  ["kings county", "Brooklyn"],
  ["manhattan", "Manhattan"],
  ["new york county", "Manhattan"],
  ["queens", "Queens"],
  ["queens county", "Queens"],
  ["staten island", "Staten Island"],
  ["richmond county", "Staten Island"],
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeBorough(value) {
  return BOROUGH_ALIASES.get(clean(value).toLocaleLowerCase()) || null;
}

export function parseCommunityBoardQuery(value) {
  const query = clean(value);
  const match = query.match(/\bcommunity\s+board\s*(?:no\.?\s*|#\s*)?(\d{1,2})\b/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > 18) return null;
  const borough = [...BOROUGH_ALIASES.keys()]
    .sort((left, right) => right.length - left.length)
    .map((alias) => ({ alias, borough: BOROUGH_ALIASES.get(alias) }))
    .find(({ alias }) => new RegExp(`\\b${alias.replaceAll(" ", "\\s+")}\\b`, "i").test(query))?.borough || null;
  return {
    number,
    borough,
    ambiguous: !borough,
    query,
  };
}

export function communityBoardBodyId(number, borough) {
  const district = Number(number);
  const normalized = normalizeBorough(borough);
  if (!Number.isInteger(district) || district < 1 || district > 18 || !normalized) return null;
  const slug = COMMUNITY_BOARD_BOROUGHS.find((row) => row.name === normalized)?.slug;
  return slug ? `${slug}-cb-${String(district).padStart(2, "0")}` : null;
}

export function communityBoardInstitutionHref(bodyId) {
  const cleanId = clean(bodyId).toLocaleLowerCase();
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(cleanId)
    ? `/browse/people/?board=${encodeURIComponent(cleanId)}#community-boards`
    : "/browse/people/#community-boards";
}

function communityBoardLabels(row) {
  const area = row?.affected_area;
  const values = [
    ...(Array.isArray(area?.community_boards) ? area.community_boards : []),
    ...(Array.isArray(row?.community_boards) ? row.community_boards : []),
  ];
  return values.map(clean).filter(Boolean);
}

export function communityBoardIdsFromRow(row) {
  return [...new Set(communityBoardLabels(row).flatMap((label) => {
    const match = label.match(/\bcommunity\s+board\s+(\d{1,2})\s*,\s*([^,]+)$/i);
    if (!match) return [];
    const id = communityBoardBodyId(Number(match[1]), match[2]);
    return id ? [id] : [];
  }))];
}

export function rowMatchesCommunityBoardQuery(row, query) {
  if (!query) return false;
  const ids = communityBoardIdsFromRow(row);
  const target = query.borough
    ? communityBoardBodyId(query.number, query.borough)
    : null;
  if (ids.length) return target ? ids.includes(target) : ids.some((id) => id.endsWith(`-cb-${String(query.number).padStart(2, "0")}`));
  const haystack = JSON.stringify(row || "");
  const numberPattern = new RegExp(`\\bcommunity\\s+board\\s*(?:no\\.?\\s*|#\\s*)?0?${query.number}\\b`, "i");
  if (!numberPattern.test(haystack)) return false;
  return !query.borough || new RegExp(`\\b${query.borough.replaceAll(" ", "\\s+")}\\b`, "i").test(haystack);
}

export function communityBoardDisambiguation(query) {
  if (!query?.ambiguous) return [];
  return COMMUNITY_BOARD_BOROUGHS.map((borough) => {
    const bodyId = communityBoardBodyId(query.number, borough.name);
    return {
      ...borough,
      bodyId,
      label: `${borough.name} Community Board ${query.number}`,
      institutionHref: communityBoardInstitutionHref(bodyId),
    };
  });
}
