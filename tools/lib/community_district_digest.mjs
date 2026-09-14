import {
  COMMUNITY_DISTRICT_COVERAGE_STATES,
  COMMUNITY_DISTRICT_DIGEST_SCHEMA,
  COMMUNITY_DISTRICT_DIGEST_SECTIONS,
} from "../../site/community_district_digest.mjs";
import {
  communityBoardIdFromCommunityDistrict,
  councilDistrictsIntersectingCommunity,
} from "../../site/community_board_geography.mjs";

const MAX_ITEMS_PER_SECTION = 8;
const CEILING_BYTES = 500_000;
const DISTRICT_RE = /^[MXKQR](?:0[1-9]|1[0-8])$/;

function dateOf(row) { return String(row?.date || row?.event_date || row?.current_milestone_date || "").slice(0, 10); }
function compact(row, lens) {
  if (!row?.id) return null;
  const result = { id: row.id, title: row.title || null, route: row.route || null, date: dateOf(row) || null };
  if (lens === "land") result.project_id = row.id;
  else result.request_id = row.id;
  return result;
}
function coverageFor(activity, lens, overrides) {
  const override = overrides?.[lens];
  if (override) {
    if (!COMMUNITY_DISTRICT_COVERAGE_STATES.includes(override.state)) throw new Error(`invalid coverage state: ${override.state}`);
    return { ...override };
  }
  const source = activity?.sources?.[lens];
  if (!source) return { state: "unavailable", reason: "source_not_materialized" };
  if (source.coverage?.state) {
    if (!COMMUNITY_DISTRICT_COVERAGE_STATES.includes(source.coverage.state)) throw new Error(`invalid coverage state: ${source.coverage.state}`);
    return { ...source.coverage };
  }
  return source.counted === 0 ? { state: "known_zero", counted: 0 } : { state: "supported", counted: source.counted };
}

export function buildCommunityDistrictDigests({ activity, communityBoardGeography = {}, builtAt = activity?.built_at, coverage = {} } = {}) {
  if (activity?.schema !== "cityscroll.district_activity.v1") throw new Error("community digest requires district activity");
  const districts = Object.keys(activity.district_items?.by_level?.community_district || {})
    .filter((id) => DISTRICT_RE.test(id)).sort();
  if (districts.length !== 59) throw new Error(`community digest requires 59 regular districts, got ${districts.length}`);
  const corpora = activity.district_items?.corpora || {};
  const byCommunity = {};
  for (const district of districts) {
    const memberships = activity.district_items.by_level.community_district[district] || {};
    const sections = {};
    for (const { id } of COMMUNITY_DISTRICT_DIGEST_SECTIONS) {
      const state = coverageFor(activity, id, coverage[district]);
      const ids = memberships[id] || [];
      const records = activity.records?.[id] || {};
      const items = ["supported", "known_zero"].includes(state.state) ? ids.map((id) => compact(records[id], id)).filter(Boolean)
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.id.localeCompare(b.id))
        .slice(0, MAX_ITEMS_PER_SECTION) : [];
      sections[id] = { count: state.state === "supported" ? ids.length : state.state === "known_zero" ? 0 : null, items, coverage: state };
    }
    const boardId = communityBoardIdFromCommunityDistrict(district, communityBoardGeography);
    const boardNode = (communityBoardGeography.nodes || []).find((node) => node.id === `community-board:${boardId}`) || null;
    byCommunity[district] = {
      community_district: district,
      borough: ({ M: "Manhattan", X: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island" })[district[0]],
      community_board: boardId,
      community_board_name: boardNode?.name || null,
      council_districts: councilDistrictsIntersectingCommunity(district, communityBoardGeography),
      sections,
      source_vintages: Object.fromEntries(Object.entries(corpora).map(([key, value]) => [key, value.stamp_value || null])),
    };
  }
  const payload = { schema: COMMUNITY_DISTRICT_DIGEST_SCHEMA, boundary_vintage: activity.boundary_vintage, built_at: builtAt, by_community_district: byCommunity,
    sections: COMMUNITY_DISTRICT_DIGEST_SECTIONS, performance: { measured_bytes: 0, ceiling_bytes: CEILING_BYTES, max_items_per_section: MAX_ITEMS_PER_SECTION },
    note: "Bounded references into canonical district activity records; no request-time corpus reads." };
  payload.performance.measured_bytes = Buffer.byteLength(JSON.stringify(payload));
  if (payload.performance.measured_bytes > CEILING_BYTES) throw new Error("community district digest exceeds payload ceiling");
  return payload;
}

export const buildCommunityDistrictDigest = buildCommunityDistrictDigests;
