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

const COMMUNITY_DISTRICT_BOROUGHS = Object.freeze({
  X: "Bronx",
  K: "Brooklyn",
  M: "Manhattan",
  Q: "Queens",
  R: "Staten Island",
});

const GENERAL_LOCATION_SOURCES = new Set([
  "geoip",
  "ip",
  "ip_guess",
  "network",
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

function normalizedBodyId(value) {
  const id = clean(value).toLocaleLowerCase().replace(/^community-board:/, "");
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(id) ? id : null;
}

export function communityBoardShortLabel(value) {
  const id = normalizedBodyId(value);
  const match = id?.match(/^([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/);
  if (!match) return null;
  const borough = COMMUNITY_BOARD_BOROUGHS.find((row) => row.slug === match[1])?.name;
  return borough ? `${borough} CB${Number(match[2])}` : null;
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

/** Resolve an already-published row identity without inferring one from title similarity. */
export function communityBoardIdFromRow(row) {
  const direct = [
    row?.board_id,
    row?.body_id,
    row?.institution_refs?.board_ref,
    ...(Array.isArray(row?.entity_refs_all) ? row.entity_refs_all : []),
  ].map(normalizedBodyId).find(Boolean);
  if (direct) return direct;
  const affected = communityBoardIdsFromRow(row)[0];
  if (affected) return affected;
  const named = parseCommunityBoardQuery(row?.board_name);
  return named?.borough ? communityBoardBodyId(named.number, named.borough) : null;
}

export function rowMatchesCommunityBoardQuery(row, query) {
  if (!query) return false;
  const ids = [...new Set([
    ...communityBoardIdsFromRow(row),
    communityBoardIdFromRow(row),
  ].filter(Boolean))];
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

function selectedCandidate(query, value) {
  const id = normalizedBodyId(value);
  return id && id.endsWith(`-cb-${String(query?.number).padStart(2, "0")}`) ? id : null;
}

/**
 * Turn an ambiguous board query plus explicit civic context into a visible default.
 * Network/IP location is deliberately excluded: it is not a resident-supplied civic identity.
 */
export function communityBoardSearchPresentation(query, context = {}) {
  const choices = communityBoardDisambiguation(query);
  if (!query?.ambiguous || choices.length === 0) {
    return { defaultBodyId: null, defaultLabel: null, defaultSource: null, choices };
  }

  const selectedBodyId = selectedCandidate(query, context.selectedBodyId || context.communityBoard);
  let defaultBodyId = selectedBodyId;
  let defaultSource = selectedBodyId ? "user_choice" : null;
  const source = clean(context.source).toLocaleLowerCase();
  if (!defaultBodyId && !GENERAL_LOCATION_SOURCES.has(source)) {
    const district = clean(context.communityDistrict || context.community_district || context.cd).toUpperCase();
    const match = district.match(/^([XKMQR])(\d{2})$/);
    if (match && Number(match[2]) === query.number) {
      defaultBodyId = communityBoardBodyId(query.number, COMMUNITY_DISTRICT_BOROUGHS[match[1]]);
    }
    if (!defaultBodyId && context.borough) {
      defaultBodyId = communityBoardBodyId(query.number, context.borough);
    }
    if (defaultBodyId) defaultSource = "place_context";
  }

  return {
    defaultBodyId,
    defaultLabel: communityBoardShortLabel(defaultBodyId),
    defaultSource,
    choices: choices.map((choice) => ({
      ...choice,
      shortLabel: communityBoardShortLabel(choice.bodyId),
      preferred: choice.bodyId === defaultBodyId,
    })),
  };
}

function rowTimeBand(row, today) {
  const status = clean(row?.status || row?.lifecycle_stage || row?.process_stage).toLocaleLowerCase();
  if (["open", "upcoming", "scheduled", "agenda"].includes(status)) return 0;
  if (["past", "closed", "archived"].includes(status)) return 2;
  const date = clean(row?.event_date || row?.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 1;
  return date >= today ? 0 : 2;
}

/** Stable board grouping and ranking. It changes presentation order only; no row is removed. */
export function rankCommunityBoardRows(rows = [], {
  query = null,
  context = {},
  selectedBodyId = null,
  today = new Date().toISOString().slice(0, 10),
  rowForIdentity = (row) => row,
} = {}) {
  const presentation = communityBoardSearchPresentation(query, {
    ...context,
    selectedBodyId: selectedBodyId || context.selectedBodyId,
  });
  const boroughOrder = new Map(COMMUNITY_BOARD_BOROUGHS.map((borough, index) => [borough.slug, index]));
  const prepared = (Array.isArray(rows) ? rows : []).map((value, index) => {
    const row = rowForIdentity(value) || {};
    const bodyId = communityBoardIdFromRow(row);
    const slug = bodyId?.replace(/-cb-\d{2}$/, "") || "";
    const band = rowTimeBand(row, today);
    const date = clean(row?.event_date || row?.date).slice(0, 10);
    return { value, row, bodyId, band, date, index, boroughOrder: boroughOrder.get(slug) ?? 99 };
  });
  const groupFacts = new Map();
  for (const item of prepared) {
    const key = item.bodyId || "unresolved";
    const existing = groupFacts.get(key) || { bestBand: 99, boroughOrder: item.boroughOrder };
    existing.bestBand = Math.min(existing.bestBand, item.band);
    groupFacts.set(key, existing);
  }
  const groupOrder = [...groupFacts.entries()].sort(([leftId, left], [rightId, right]) => {
    const leftPreferred = leftId === presentation.defaultBodyId ? 0 : 1;
    const rightPreferred = rightId === presentation.defaultBodyId ? 0 : 1;
    return leftPreferred - rightPreferred
      || left.bestBand - right.bestBand
      || left.boroughOrder - right.boroughOrder
      || leftId.localeCompare(rightId);
  }).map(([id]) => id);
  const groupIndex = new Map(groupOrder.map((id, index) => [id, index]));
  prepared.sort((left, right) => {
    const leftGroup = left.bodyId || "unresolved";
    const rightGroup = right.bodyId || "unresolved";
    const groupDifference = groupIndex.get(leftGroup) - groupIndex.get(rightGroup);
    if (groupDifference) return groupDifference;
    if (left.band !== right.band) return left.band - right.band;
    if (left.date !== right.date) {
      return left.band === 2 ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date);
    }
    return left.index - right.index;
  });
  const groups = groupOrder.map((bodyId) => ({
    bodyId: bodyId === "unresolved" ? null : bodyId,
    label: bodyId === "unresolved"
      ? `CB${query?.number || ""} · borough not specified`
      : communityBoardShortLabel(bodyId),
    preferred: bodyId === presentation.defaultBodyId,
    rows: prepared.filter((item) => (item.bodyId || "unresolved") === bodyId).map((item) => item.value),
  }));
  return {
    ...presentation,
    rows: prepared.map((item) => item.value),
    groups,
  };
}
