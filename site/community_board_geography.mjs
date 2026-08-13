// First-class community-board and district geography read model.
//
// This module deliberately uses polygon boundary crossing/containment. A point
// or centroid is not a sufficient representation of a district overlay: one
// community district can intersect several Council districts.

const BOROUGH_PREFIX = Object.freeze({
  Bronx: "X",
  Brooklyn: "K",
  Manhattan: "M",
  Queens: "Q",
  "Staten Island": "R",
});

import { buildLocalConstellation } from "./local_constellation.mjs";

export const COMMUNITY_BOARD_GEOGRAPHY_SCHEMA = "cityscroll.community_board_geography.v1";
export const COMMUNITY_BOARD_GEOGRAPHY_VINTAGE = "2026-05-26";
export const COMMUNITY_BOARD_OVERLAY_EXPECTED_PAIRS = 237;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function communityDistrictIdForBoard(row = {}) {
  const prefix = BOROUGH_PREFIX[clean(row.borough)];
  const district = Number(row.district);
  if (!prefix || !Number.isInteger(district) || district < 1 || district > 18) return null;
  return `${prefix}${String(district).padStart(2, "0")}`;
}

function bboxOverlaps(a, b) {
  return a && b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  const epsilon = 1e-10;
  return Math.abs(orientation(a, b, p)) <= epsilon
    && p[0] >= Math.min(a[0], b[0]) - epsilon
    && p[0] <= Math.max(a[0], b[0]) + epsilon
    && p[1] >= Math.min(a[1], b[1]) - epsilon
    && p[1] <= Math.max(a[1], b[1]) + epsilon;
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  const epsilon = 1e-10;
  if (Math.abs(abC) <= epsilon && onSegment(a, b, c)) return true;
  if (Math.abs(abD) <= epsilon && onSegment(a, b, d)) return true;
  if (Math.abs(cdA) <= epsilon && onSegment(c, d, a)) return true;
  if (Math.abs(cdB) <= epsilon && onSegment(c, d, b)) return true;
  return ((abC > 0) !== (abD > 0)) && ((cdA > 0) !== (cdB > 0));
}

function ringSegments(ring = []) {
  const points = Array.isArray(ring) ? ring.filter((point) => Array.isArray(point) && point.length >= 2) : [];
  if (points.length < 2) return [];
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

function pointInRing(point, ring = []) {
  let inside = false;
  for (const [[x1, y1], [x2, y2]] of ringSegments(ring)) {
    if (onSegment([x1, y1], [x2, y2], point)) return true;
    const crosses = ((y1 > point[1]) !== (y2 > point[1]))
      && point[0] < ((x2 - x1) * (point[1] - y1)) / (y2 - y1) + x1;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon = {}) {
  const rings = Array.isArray(polygon.rings) ? polygon.rings : [];
  if (!pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

function polygonIntersects(left = {}, right = {}) {
  if (left.bbox && right.bbox && !bboxOverlaps(left.bbox, right.bbox)) return false;
  const leftRings = (left.rings || []).flatMap(ringSegments);
  const rightRings = (right.rings || []).flatMap(ringSegments);
  if (leftRings.some(([a, b]) => rightRings.some(([c, d]) => segmentsIntersect(a, b, c, d)))) return true;
  const leftOuter = left.rings?.[0]?.[0];
  const rightOuter = right.rings?.[0]?.[0];
  return (leftOuter && pointInPolygon(leftOuter, right))
    || (rightOuter && pointInPolygon(rightOuter, left));
}

function featurePolygons(feature = {}) {
  return (feature.polygons || []).filter((polygon) => Array.isArray(polygon.rings));
}

export function polygonsIntersect(leftFeature, rightFeature) {
  if (!bboxOverlaps(leftFeature?.bbox, rightFeature?.bbox)) return false;
  return featurePolygons(leftFeature).some((left) => featurePolygons(rightFeature)
    .some((right) => polygonIntersects(left, right)));
}

function regularCommunityDistricts(boundaries = {}) {
  return (boundaries.community_districts || [])
    .filter((feature) => /^\D\d{2}$/.test(clean(feature.id)))
    .filter((feature) => Number(clean(feature.id).slice(1)) <= 18);
}

function councilDistricts(boundaries = {}) {
  return (boundaries.council_districts || [])
    .filter((feature) => /^\d+$/.test(clean(feature.id)))
    .filter((feature) => Number(feature.id) >= 1 && Number(feature.id) <= 51);
}

function source(sourceSystem, id, url) {
  return { system: sourceSystem, id, ...(url ? { url } : {}) };
}

function provenance(sourceValue, observedAt, fields) {
  return { source: sourceValue, source_fields: fields, observed_at: observedAt };
}

function node(id, type, name, properties, sourceValue, observedAt, fields) {
  return {
    id,
    type,
    name,
    properties,
    provenance: provenance(sourceValue, observedAt, fields),
    confidence: { status: "not_scored", basis: "publisher_record" },
  };
}

function graphEdge(type, from, to, properties, sourceValue, observedAt, fields) {
  return {
    id: `edge:${type}:${from}:${to}:${sourceValue.id}`,
    type,
    from,
    to,
    ...properties,
    provenance: provenance(sourceValue, observedAt, fields),
    confidence: { status: "strong", basis: "publisher_geometry" },
  };
}

function placeHref(node) {
  if (node?.type === "community-board") return "/community-boards/";
  if (node?.type === "community-district") return `/near-you/?cd=${encodeURIComponent(String(node.id || "").replace(/^community-district:/, ""))}`;
  if (node?.type === "council-district") return `/near-you/?council=${encodeURIComponent(String(node.id || "").replace(/^council-district:/, ""))}`;
  return null;
}

/** Build the small geometry neighborhood for one published place node. */
export function buildPlaceLocalConstellation(geography = {}, placeId = null) {
  const requested = clean(placeId);
  const nodes = Array.isArray(geography.nodes) ? geography.nodes : [];
  const edges = geography.gate?.publication_allowed && Array.isArray(geography.public_edges)
    ? geography.public_edges
    : [];
  const node = nodes.find((candidate) => candidate?.id === requested) || null;
  const adjacent = requested
    ? edges.filter((edge) => edge?.from === requested || edge?.to === requested)
    : [];
  return buildLocalConstellation({
    kind: "place",
    subject_ref: requested || null,
    subject_id: requested || null,
    subject_name: node?.name || requested || "Near you",
    source: node?.provenance?.source || null,
    provenance: node?.provenance || null,
    availability_state: geography.gate?.publication_allowed ? null : "unknown",
    neighbors: adjacent.map((edge) => {
      const targetId = edge.from === requested ? edge.to : edge.from;
      const target = nodes.find((candidate) => candidate?.id === targetId);
      return {
        edge_type: edge.type,
        relation_label: edge.type === "intersects" ? "intersects" : "covers",
        target_kind: target?.type || "place",
        target_id: targetId || null,
        target_name: target?.name || targetId || null,
        href: placeHref(target),
        state: target && placeHref(target) ? "matched" : "unknown",
        provenance: edge.provenance || null,
      };
    }),
  });
}

export function buildCommunityBoardGeography({
  sourceRegistry = {},
  boundaries = {},
  observedAt = new Date().toISOString(),
  expectedPairCount = COMMUNITY_BOARD_OVERLAY_EXPECTED_PAIRS,
} = {}) {
  const boards = (sourceRegistry.sources || []).filter((row) => row.body_type === "community_board");
  const regular = regularCommunityDistricts(boundaries);
  const councils = councilDistricts(boundaries);
  const regularById = new Map(regular.map((feature) => [clean(feature.id), feature]));
  const councilById = new Map(councils.map((feature) => [clean(feature.id), feature]));
  const boardMappings = boards.map((board) => ({
    board,
    communityDistrictId: communityDistrictIdForBoard(board),
    feature: regularById.get(communityDistrictIdForBoard(board)),
  }));
  const validMappings = boardMappings.filter((mapping) => mapping.feature);
  const pairRows = [];
  for (const community of regular) {
    for (const council of councils) {
      if (polygonsIntersect(community, council)) pairRows.push({ community, council });
    }
  }
  const pairsByCommunity = Object.fromEntries(regular.map((community) => [
    clean(community.id), pairRows.filter((row) => row.community === community).map((row) => clean(row.council.id)),
  ]));
  const boardNodes = boards.map((board) => node(
    `community-board:${clean(board.body_id)}`,
    "community-board",
    clean(board.name),
    {
      body_id: clean(board.body_id),
      borough: clean(board.borough),
      district: Number(board.district),
      directory_url: board.directory_url ?? null,
      source_url: board.source_url ?? null,
      observed_on: board.observed_on ?? null,
    },
    source("community_board_source_registry", clean(board.body_id), board.directory_url),
    observedAt,
    ["body_id", "borough", "district", "name", "directory_url", "observed_on"],
  ));
  const communityNodes = regular.map((feature) => node(
    `community-district:${clean(feature.id)}`,
    "community-district",
    clean(feature.label || feature.id),
    { boundary_vintage: boundaries.boundary_vintage ?? null, boro_cd: feature.boro_cd ?? null },
    source("nyc_dcp_community_districts", "5crt-au7u", "https://data.cityofnewyork.us/d/5crt-au7u"),
    observedAt,
    ["boro_cd", "the_geom", "boundary_vintage"],
  ));
  const councilNodes = councils.map((feature) => node(
    `council-district:${clean(feature.id)}`,
    "council-district",
    clean(feature.label || `City Council District ${feature.id}`),
    { boundary_vintage: boundaries.boundary_vintage ?? null },
    source("nyc_dcp_council_districts", "872g-cjhh", "https://data.cityofnewyork.us/d/872g-cjhh"),
    observedAt,
    ["coundist", "the_geom", "boundary_vintage"],
  ));
  const covers = validMappings.map(({ board, communityDistrictId }) => graphEdge(
    "covers",
    `community-board:${clean(board.body_id)}`,
    `community-district:${communityDistrictId}`,
    {
      boundary_vintage: boundaries.boundary_vintage ?? null,
      mapping_method: "registry_borough_and_district_exact",
    },
    source("community_board_source_registry", clean(board.body_id), board.directory_url),
    observedAt,
    ["body_id", "borough", "district", "boundary_vintage"],
  ));
  const intersects = pairRows.map(({ community, council }) => graphEdge(
    "intersects",
    `community-district:${clean(community.id)}`,
    `council-district:${clean(council.id)}`,
    {
      boundary_vintage: boundaries.boundary_vintage ?? null,
      intersection_method: "polygon_segment_crossing_or_containment",
      intersection_semantics: "boundary_touch_or_containment",
      source_urls: [
        "https://data.cityofnewyork.us/d/5crt-au7u",
        "https://data.cityofnewyork.us/d/872g-cjhh",
      ],
    },
    source("nyc_dcp_boundary_overlay", `${clean(community.id)}:${clean(council.id)}:${boundaries.boundary_vintage || "unknown"}`),
    observedAt,
    ["boro_cd", "coundist", "the_geom", "boundary_vintage"],
  ));
  const pairCount = intersects.length;
  const perCommunityCounts = Object.fromEntries(Object.entries(pairsByCommunity)
    .map(([id, ids]) => [id, ids.length]));
  const allRegularBoardsMapped = boards.length === 59
    && boardMappings.length === 59
    && validMappings.length === 59
    && new Set(validMappings.map((mapping) => mapping.communityDistrictId)).size === 59;
  const pairCountMatches = pairCount === expectedPairCount;
  const gate = {
    expected_pair_count: expectedPairCount,
    observed_pair_count: pairCount,
    pair_count_matches: pairCountMatches,
    regular_community_districts: regular.length,
    council_districts: councils.length,
    regular_boards_inventoried: boards.length,
    regular_board_mappings: validMappings.length,
    all_regular_boards_mapped: allRegularBoardsMapped,
    zero_invalid_geometry_rows: pairRows.every(({ community, council }) => community.polygons?.length && council.polygons?.length),
    publication_allowed: pairCountMatches && allRegularBoardsMapped && pairRows.length === intersects.length,
    publication_status: pairCountMatches && allRegularBoardsMapped ? "published" : "held",
  };
  return {
    schema: COMMUNITY_BOARD_GEOGRAPHY_SCHEMA,
    generated_at: observedAt,
    boundary_vintage: boundaries.boundary_vintage ?? null,
    inventory: {
      boards_inventoried: boards.length,
      collectable_boards: boards.filter((row) => row.status === "collect").length,
      citywide_complete: false,
      note: "The registry inventories 59 boards; source collection is intentionally bounded and not citywide-complete.",
    },
    gate,
    receipt: {
      pair_count: pairCount,
      per_community_district: perCommunityCounts,
      average_council_districts_per_community_district: regular.length
        ? Number((pairCount / regular.length).toFixed(2)) : null,
      relation: "community-district --intersects--> council-district",
      centroid_proxy: "rejected",
    },
    nodes: [...boardNodes, ...communityNodes, ...councilNodes],
    edge_observations: [...covers, ...intersects],
    public_edges: gate.publication_allowed ? [...covers, ...intersects] : [],
    public_graph: {
      nodes: [...boardNodes, ...communityNodes, ...councilNodes],
      edges: gate.publication_allowed ? [...covers, ...intersects] : [],
    },
  };
}
