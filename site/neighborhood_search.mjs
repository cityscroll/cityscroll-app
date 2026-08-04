/**
 * Deterministic NYC neighborhood search.
 *
 * The gazetteer is built from NYC Planning's 2020 Neighborhood Tabulation
 * Areas, then enriched with a small, reviewable alias table at build time.
 * This module is pure except for loadNeighborhoodGazetteer(), so Node tests and
 * browser search use exactly the same normalization and fuzzy matching.
 */

const GAZETTEER_URL = "data/neighborhood_gazetteer.json";
let gazetteerPromise = null;

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/\bst[.]?(?=\s+[a-z])/g, "saint")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(value) {
  return [...new Set(normalizeSearchText(value).split(" ").filter(Boolean))].sort();
}

export function sameWords(left, right) {
  const a = searchTokens(left);
  const b = searchTokens(right);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** Bounded Levenshtein distance; returns max + 1 as soon as a row cannot win. */
export function editDistance(left, right, max = Infinity) {
  const a = normalizeSearchText(left);
  const b = normalizeSearchText(right);
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

function candidateStrings(entry) {
  return [entry.name, ...(entry.aliases || [])].filter(Boolean);
}

function queryCandidates(query) {
  const normalized = normalizeSearchText(query);
  const withoutScaffolding = normalized
    .replace(/\b(?:show|find|list|search|current|new|all|notices?|items?|events?)\b/g, " ")
    .replace(/\b(?:in|near|around|within|for|about|from|the|nyc|new york city)\b/g, " ")
    .replace(/\b(?:property|properties|dispositions?|rezonings?|zoning|rules?|regulations?|meetings?|hearings?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...new Set([normalized, withoutScaffolding].filter(Boolean))];
}

/**
 * Resolve a query to an official geography. Exact normalized and word-order
 * matches win; bounded edit distance only runs after those deterministic hits.
 */
export function resolveNeighborhood(query, gazetteer, options = {}) {
  const entries = Array.isArray(gazetteer) ? gazetteer : gazetteer?.neighborhoods;
  if (!Array.isArray(entries) || !entries.length) return null;
  const candidates = queryCandidates(query);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    for (const entry of entries) {
      const hit = candidateStrings(entry).find((name) => normalizeSearchText(name) === candidate);
      if (hit) return { ...entry, matched: hit, match_method: "exact", distance: 0 };
    }
  }
  for (const candidate of candidates) {
    for (const entry of entries) {
      const hit = candidateStrings(entry).find((name) => sameWords(name, candidate));
      if (hit) return { ...entry, matched: hit, match_method: "word_order", distance: 0 };
    }
  }

  if (options.fuzzy === false) return null;
  let best = null;
  for (const candidate of candidates) {
    if (candidate.length < 5) continue;
    const maxDistance = candidate.length >= 7 ? 2 : 1;
    for (const entry of entries) {
      for (const name of candidateStrings(entry)) {
        const normalizedName = normalizeSearchText(name);
        const distance = editDistance(candidate, normalizedName, maxDistance);
        if (distance <= maxDistance && (!best || distance < best.distance)) {
          best = { ...entry, matched: name, match_method: "edit_distance", distance };
        }
      }
    }
  }
  return best;
}

export async function loadNeighborhoodGazetteer(fetchImpl = globalThis.fetch) {
  if (!gazetteerPromise) {
    gazetteerPromise = fetchImpl(GAZETTEER_URL, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`neighborhood gazetteer HTTP ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        gazetteerPromise = null;
        throw error;
      });
  }
  return gazetteerPromise;
}

export async function resolveNeighborhoodQuery(query, fetchImpl = globalThis.fetch) {
  try {
    return resolveNeighborhood(query, await loadNeighborhoodGazetteer(fetchImpl));
  } catch (_error) {
    return null;
  }
}

export async function enrichNeighborhoodFilter(text, lens, filter) {
  const place = await resolveNeighborhoodQuery(text);
  if (!place) return filter;
  const aliases = [place.name, ...(place.aliases || []), ...(place.official_names || [])].map(normalizeSearchText);
  const keywords = (filter.keywords || []).filter((keyword) => {
    const normalized = normalizeSearchText(keyword);
    return normalized && !aliases.some((alias) => alias === normalized || alias.includes(normalized) || normalized.includes(alias));
  });
  const enriched = {
    ...filter,
    keywords,
    borough: place.borough,
    neighborhood: place.name,
    communityDistrict: place.community_districts?.[0] || null,
    neighborhoodMatch: place.match_method,
  };
  if (lens === "land") enriched.boro = place.borough;
  return enriched;
}

export async function resolveFeedNeighborhood(key, query) {
  if (!query || !["property", "rules", "meetings"].includes(key)) return null;
  const place = await resolveNeighborhoodQuery(query);
  if (!place) return null;
  document.querySelector(`#${key}kw`).value = "";
  const borough = document.querySelector(`#${key}boro`);
  if (borough) borough.value = place.borough || "";
  const neighborhood = document.querySelector(`#${key}neighborhood`);
  if (neighborhood) neighborhood.value = place.name;
  if (key === "property") {
    globalThis.propertyResolvedNeighborhood = place;
    globalThis.propertyCommunityDistrict = place.community_districts?.[0] || "";
  }
  return place;
}

let districtToolsPromise = null;

export async function stampPropertyCommunityDistricts(rows, communityDistrict, fetchImpl = globalThis.fetch) {
  if (!communityDistrict || !rows?.length) return;
  if (!districtToolsPromise) {
    districtToolsPromise = Promise.all([
      import("./council_district_lookup.mjs"),
      fetchImpl("data/district_boundaries.json", { cache: "force-cache" }).then((response) => response.ok ? response.json() : null),
    ]).catch(() => null);
  }
  const loaded = await districtToolsPromise;
  if (!loaded) return;
  const [tools, boundaries] = loaded;
  if (!boundaries || typeof tools.resolveCommunityDistrict !== "function") return;
  for (const row of rows) {
    if (row._communityDistrict) continue;
    const location = row._location || row.property_location || {};
    const geometry = location.geometry || (location.addresses || []).find((address) =>
      Number.isFinite(Number(address?.latitude)) && Number.isFinite(Number(address?.longitude)));
    if (!geometry) continue;
    const latitude = Number(geometry.latitude);
    const longitude = Number(geometry.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      row._communityDistrict = tools.resolveCommunityDistrict(latitude, longitude, boundaries) || null;
    }
  }
}

export async function resolvePropertyNeighborhoodState(query, currentPlace, rows) {
  if (!query) return { place: null, communityDistrict: "" };
  const place = currentPlace?.name === query ? currentPlace : await resolveNeighborhoodQuery(query);
  const communityDistrict = place?.community_districts?.[0] || "";
  await stampPropertyCommunityDistricts(rows, communityDistrict);
  return { place, communityDistrict };
}
