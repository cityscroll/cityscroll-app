/**
 * Board ↔ neighborhood (NTA 2020) association index.
 *
 * Joins the committed NTA→community-district crosswalk material navigation
 * rows to the published board `covers` ontology. Does not recompute polygon
 * intersections. Special districts and ambiguous or unpublished covers edges
 * stay out of board associations and are recorded for operators.
 */

import { createHash } from "node:crypto";

import { civicGeographyLayer } from "./civic_geography_registry.mjs";

export const BOARD_NEIGHBORHOOD_INDEX_SCHEMA = "cityscroll.board_neighborhood_index.v1";
export const BOARD_NEIGHBORHOOD_INDEX_RECEIPT_SCHEMA =
  "cityscroll.board_neighborhood_index_receipt.v1";
export const BOARD_NEIGHBORHOOD_INDEX_PATH = "site/data/board_neighborhood_index.json";

const DEFAULT_ALLOWED_SUBTYPES = Object.freeze(
  civicGeographyLayer("nta2020")?.subtypes?.allowed
    ? [...civicGeographyLayer("nta2020").subtypes.allowed]
    : ["residential", "rikers_island", "special_use", "cemetery", "airport", "park"],
);

export const BOARD_NEIGHBORHOOD_ALLOWED_NTA_SUBTYPES = Object.freeze([
  ...DEFAULT_ALLOWED_SUBTYPES,
]);

const BOARD_ID_RE = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const DISTRICT_ID_RE = /^[MXKQR]\d{2}$/;
const NTA_ID_RE = /^(?:BK|BX|MN|QN|SI)\d{4}$/;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Deterministic JSON for content hashing (sorted object keys). */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function parseNtaIdFromKey(fromKey) {
  const match = clean(fromKey).match(/^geography:nta2020:((?:BK|BX|MN|QN|SI)\d{4})$/i);
  return match ? match[1].toUpperCase() : null;
}

export function parseDistrictIdFromKey(toKey) {
  const match = clean(toKey).match(/^geography:community_district:([MXKQR]\d{2})$/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Build nta_id → subtype from a geography layer document's features.
 * Geometry is ignored; only id/subtype are retained.
 */
export function ntaSubtypeMapFromLayer(layerDoc = {}) {
  const out = Object.create(null);
  for (const feature of Array.isArray(layerDoc.features) ? layerDoc.features : []) {
    const id = clean(feature?.id || feature?.key?.split(":").pop()).toUpperCase();
    if (!NTA_ID_RE.test(id)) continue;
    const subtype = feature?.subtype == null ? null : clean(feature.subtype);
    out[id] = subtype || null;
  }
  return out;
}

/**
 * Resolve the unique published board that covers a community district.
 * Duplicate or unpublished covers fail closed with an operator-visible status.
 */
export function resolvePublishedBoardForDistrict(districtId, geography = {}) {
  const cd = clean(districtId).match(DISTRICT_ID_RE)?.[0]?.toUpperCase() || null;
  if (!cd) {
    return {
      board_id: null,
      status: "invalid_district",
      reason: "community_district_id_unrecognized",
      candidates: [],
    };
  }
  if (geography?.gate?.publication_allowed !== true) {
    return {
      board_id: null,
      status: "unpublished",
      reason: "geography_publication_not_allowed",
      candidates: [],
    };
  }
  const matches = [
    ...new Set(
      (Array.isArray(geography.public_edges) ? geography.public_edges : [])
        .filter((edge) => edge?.type === "covers" && edge.to === `community-district:${cd}`)
        .map((edge) => clean(edge.from).match(/^community-board:([a-z]+(?:-[a-z]+)*-cb-\d{2})$/)?.[1] || null)
        .filter((id) => id && BOARD_ID_RE.test(id)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (matches.length === 1) {
    return {
      board_id: matches[0],
      status: "associated",
      reason: null,
      candidates: matches,
    };
  }
  if (matches.length === 0) {
    return {
      board_id: null,
      status: "missing_covers",
      reason: "no_published_covers_edge",
      candidates: [],
    };
  }
  return {
    board_id: null,
    status: "duplicate_covers",
    reason: "ambiguous_published_covers_edge",
    candidates: matches,
  };
}

function compareForward(left, right) {
  const pct = (Number(right.pct_from) || 0) - (Number(left.pct_from) || 0);
  if (pct !== 0) return pct;
  const district = clean(left.district_id).localeCompare(clean(right.district_id));
  if (district !== 0) return district;
  return clean(left.board_id).localeCompare(clean(right.board_id));
}

function compareReverse(left, right) {
  const pct = (Number(right.pct_to) || 0) - (Number(left.pct_to) || 0);
  if (pct !== 0) return pct;
  return clean(left.nta_id).localeCompare(clean(right.nta_id));
}

function freezeEdge(edge) {
  return Object.freeze({
    nta_id: edge.nta_id,
    district_id: edge.district_id,
    board_id: edge.board_id,
    pct_from: edge.pct_from,
    pct_to: edge.pct_to,
    subtype: edge.subtype,
  });
}

/**
 * Materialize the bidirectional board↔NTA index from committed crosswalk rows
 * and published covers edges.
 *
 * @param {object} input
 * @param {object} input.crosswalk NTA→CD crosswalk shard document
 * @param {object} input.geography community_board_geography_lookup document
 * @param {Record<string, string|null>|Map} [input.ntaSubtypeById]
 * @param {string[]} [input.allowedSubtypes]
 * @param {Record<string, string>} [input.sourceHashes] sha256 hex of source bytes
 * @param {string} [input.builtAt] ISO stamp recorded on generation
 */
export function buildBoardNeighborhoodIndex({
  crosswalk,
  geography,
  ntaSubtypeById = {},
  allowedSubtypes = BOARD_NEIGHBORHOOD_ALLOWED_NTA_SUBTYPES,
  sourceHashes = {},
  builtAt = null,
} = {}) {
  if (!crosswalk || typeof crosswalk !== "object") {
    throw new Error("board neighborhood index requires a crosswalk document");
  }
  if (!geography || typeof geography !== "object") {
    throw new Error("board neighborhood index requires a community-board geography document");
  }

  const allowed = new Set(
    (Array.isArray(allowedSubtypes) ? allowedSubtypes : BOARD_NEIGHBORHOOD_ALLOWED_NTA_SUBTYPES)
      .map((value) => clean(value))
      .filter(Boolean),
  );
  const subtypeLookup = ntaSubtypeById instanceof Map
    ? Object.fromEntries(ntaSubtypeById.entries())
    : (ntaSubtypeById && typeof ntaSubtypeById === "object" ? ntaSubtypeById : {});

  const materialRows = (Array.isArray(crosswalk.rows) ? crosswalk.rows : [])
    .filter((row) => row?.material_for_navigation === true);

  const boardEdges = [];
  const nonBoardEdges = [];
  const associationFailures = [];
  const boardIds = new Set();

  for (const row of materialRows) {
    const ntaId = parseNtaIdFromKey(row.from_key);
    const districtId = parseDistrictIdFromKey(row.to_key);
    if (!ntaId || !districtId) {
      associationFailures.push(Object.freeze({
        nta_id: ntaId,
        district_id: districtId,
        status: "invalid_keys",
        reason: "crosswalk_keys_unrecognized",
        candidates: [],
      }));
      continue;
    }

    const subtypeRaw = subtypeLookup[ntaId];
    const subtype = subtypeRaw == null ? null : clean(subtypeRaw);
    if (!subtype || !allowed.has(subtype)) {
      associationFailures.push(Object.freeze({
        nta_id: ntaId,
        district_id: districtId,
        status: "unsupported_subtype",
        reason: subtype
          ? "nta_subtype_not_in_allowed_set"
          : "nta_subtype_missing",
        subtype: subtype || null,
        candidates: [],
      }));
      continue;
    }

    const pctFrom = Number(row.pct_from);
    const pctTo = Number(row.pct_to);
    const resolved = resolvePublishedBoardForDistrict(districtId, geography);
    const edge = {
      nta_id: ntaId,
      district_id: districtId,
      board_id: resolved.board_id,
      pct_from: pctFrom,
      pct_to: pctTo,
      subtype,
    };

    if (resolved.status === "associated") {
      boardEdges.push(freezeEdge(edge));
      boardIds.add(resolved.board_id);
      continue;
    }

    nonBoardEdges.push(freezeEdge({ ...edge, board_id: null }));
    // Special districts (missing covers) stay on non_board_overlaps only.
    // Duplicate or unpublished covers fail association and surface on the receipt.
    if (
      resolved.status === "duplicate_covers"
      || resolved.status === "unpublished"
      || resolved.status === "invalid_district"
    ) {
      associationFailures.push(Object.freeze({
        nta_id: ntaId,
        district_id: districtId,
        status: resolved.status,
        reason: resolved.reason,
        candidates: Object.freeze([...resolved.candidates]),
      }));
    }
  }

  boardEdges.sort(compareForward);
  nonBoardEdges.sort(compareForward);

  const byNta = Object.create(null);
  for (const edge of boardEdges) {
    if (!byNta[edge.nta_id]) byNta[edge.nta_id] = [];
    byNta[edge.nta_id].push(edge);
  }
  for (const ntaId of Object.keys(byNta)) {
    byNta[ntaId].sort(compareForward);
    Object.freeze(byNta[ntaId]);
  }

  const byBoard = Object.create(null);
  for (const edge of boardEdges) {
    if (!byBoard[edge.board_id]) byBoard[edge.board_id] = [];
    byBoard[edge.board_id].push(edge);
  }
  for (const boardId of Object.keys(byBoard)) {
    byBoard[boardId].sort(compareReverse);
    Object.freeze(byBoard[boardId]);
  }

  const vintages = Object.freeze({
    nta2020: clean(crosswalk?.source_vintages?.from) || null,
    community_district: clean(crosswalk?.source_vintages?.to) || null,
    board_geography_boundary: clean(geography?.boundary_vintage) || null,
  });

  const inventory = Object.freeze({
    material_row_count: materialRows.length,
    board_associated_row_count: boardEdges.length,
    non_board_row_count: nonBoardEdges.length,
    board_identity_count: boardIds.size,
    association_failure_count: associationFailures.length,
  });

  const receipt = Object.freeze({
    schema: BOARD_NEIGHBORHOOD_INDEX_RECEIPT_SCHEMA,
    inventory,
    geography_publication_allowed: geography?.gate?.publication_allowed === true,
    association_failures: Object.freeze(
      associationFailures
        .slice()
        .sort((left, right) => {
          const nta = clean(left.nta_id).localeCompare(clean(right.nta_id));
          if (nta !== 0) return nta;
          const district = clean(left.district_id).localeCompare(clean(right.district_id));
          if (district !== 0) return district;
          return clean(left.status).localeCompare(clean(right.status));
        }),
    ),
  });

  const sortedSourceHashes = Object.freeze(
    Object.fromEntries(
      Object.entries(sourceHashes || {})
        .map(([key, value]) => [clean(key), clean(value)])
        .filter(([key, value]) => key && value)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );

  const semantic = {
    schema: BOARD_NEIGHBORHOOD_INDEX_SCHEMA,
    vintages,
    inventory,
    by_nta: byNta,
    by_board: byBoard,
    non_board_overlaps: nonBoardEdges,
    source_hashes: sortedSourceHashes,
    receipt: {
      schema: receipt.schema,
      inventory: receipt.inventory,
      geography_publication_allowed: receipt.geography_publication_allowed,
      association_failures: receipt.association_failures,
    },
  };

  const contentSha = sha256Text(stableStringify(semantic));
  const generation = Object.freeze({
    id: contentSha,
    built_at: builtAt ? clean(builtAt) : null,
    content_sha256: contentSha,
  });

  return Object.freeze({
    schema: BOARD_NEIGHBORHOOD_INDEX_SCHEMA,
    generation,
    source_hashes: sortedSourceHashes,
    vintages,
    inventory,
    by_nta: Object.freeze(byNta),
    by_board: Object.freeze(byBoard),
    non_board_overlaps: Object.freeze(nonBoardEdges),
    receipt,
  });
}

/** Serialize the index document with stable key ordering for committed bytes. */
export function serializeBoardNeighborhoodIndex(doc) {
  const byNtaKeys = Object.keys(doc.by_nta || {}).sort((a, b) => a.localeCompare(b));
  const byBoardKeys = Object.keys(doc.by_board || {}).sort((a, b) => a.localeCompare(b));
  const payload = {
    schema: doc.schema,
    generation: doc.generation,
    source_hashes: doc.source_hashes,
    vintages: doc.vintages,
    inventory: doc.inventory,
    by_nta: Object.fromEntries(byNtaKeys.map((key) => [key, doc.by_nta[key]])),
    by_board: Object.fromEntries(byBoardKeys.map((key) => [key, doc.by_board[key]])),
    non_board_overlaps: doc.non_board_overlaps,
    receipt: doc.receipt,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function boardsForNta(index, ntaId) {
  const id = clean(ntaId).toUpperCase();
  return Array.isArray(index?.by_nta?.[id]) ? index.by_nta[id] : [];
}

export function ntasForBoard(index, boardId) {
  const id = clean(boardId).toLowerCase().replace(/^community-board:/, "");
  return Array.isArray(index?.by_board?.[id]) ? index.by_board[id] : [];
}
