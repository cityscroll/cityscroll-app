/**
 * Land project → place membership from published lots.
 *
 * Joins each admitted catalog project's distinct normalized BBLs to the
 * existing parcel-geography membership shards. Publisher-declared districts
 * stay separately attributed; they never enter the physical place index.
 */

import { normalizeBbl } from "./bbl_mappluto_centroids.mjs";
import { civicGeographyKey } from "./civic_geography_registry.mjs";
import {
  LAND_PROJECT_CATALOG_SCHEMA,
  landProjectRowsFromPayload,
} from "./land_project_catalog.mjs";
import {
  PARCEL_GEOGRAPHY_SHARD_COUNT,
  PARCEL_MEMBERSHIP_LAYERS,
  lookupParcelMemberships,
  normalizeParcelMembership,
  parcelShardKey,
} from "./parcel_geography.mjs";

export const LAND_PLACE_MEMBERSHIP_SCHEMA = "cityscroll.land_place_membership.v1";
export const LAND_PLACE_EVIDENCE_SHARD_SCHEMA = "cityscroll.land_place_evidence_shard.v1";
export const LAND_PLACE_MEMBERSHIP_PATH = "site/data/land_place_membership.json";
export const LAND_PLACE_EVIDENCE_DIR = "site/data/land-place-evidence";
export const LAND_PLACE_BBL_INDEX_PATH = "site/data/zap_bbl_warehouse_lookup.json";
export const LAND_PLACE_ASSOCIATION_KIND = "published_project_lot";
export const LAND_PLACE_EVIDENCE_SHARD_COUNT = PARCEL_GEOGRAPHY_SHARD_COUNT;

export const LAND_PLACE_BBL_ASSOCIATION_STATES = Object.freeze({
  PRESENT: "present",
  EMPTY: "empty",
  ABSENT_FROM_INDEX: "absent_from_index",
  SOURCE_MISSING: "source_missing",
});

export const LAND_PLACE_LAYERS = PARCEL_MEMBERSHIP_LAYERS;

function cleanProjectId(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Unsigned UTF-8 FNV-1a 32-bit. */
export function fnv1a32Utf8(value) {
  const text = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Evidence shard key for a project id: FNV1a-32(project_id) mod 256 as
 * two-digit lowercase hex.
 */
export function landPlaceEvidenceShardKey(
  projectId,
  shardCount = LAND_PLACE_EVIDENCE_SHARD_COUNT,
) {
  const id = cleanProjectId(projectId);
  const count = Number.isInteger(shardCount) && shardCount > 0
    ? shardCount
    : LAND_PLACE_EVIDENCE_SHARD_COUNT;
  return (fnv1a32Utf8(id) % count).toString(16).padStart(2, "0");
}

export function landPlaceEvidenceShardPath(shardKey) {
  return `${LAND_PLACE_EVIDENCE_DIR}/${String(shardKey)}.json`;
}

function emptyLayerCounts() {
  return {
    total_bbls: 0,
    matched_bbls: 0,
    uncovered_bbls: 0,
    ambiguous_bbls: 0,
    unavailable_bbls: 0,
    places: [],
  };
}

function publisherGeographyFromProject(project) {
  const row = asObject(project) || {};
  return {
    borough: row.borough ?? null,
    community_district: row.community_district ?? null,
    council_district: row.cc_district ?? row.council_district ?? null,
  };
}

/**
 * Index BBL warehouse rows by project_id.
 * Preserves empty arrays when a project row exists with no BBLs.
 * @returns {Map<string, { present: boolean, raw: unknown[], valid: string[], invalid: string[] }>}
 */
export function indexProjectBblAssociations(bblIndex) {
  const byProject = new Map();
  if (bblIndex == null) return byProject;
  const rows = Array.isArray(bblIndex?.rows) ? bblIndex.rows : [];
  for (const row of rows) {
    const projectId = cleanProjectId(row?.project_id);
    if (!projectId) continue;
    const rawList = Array.isArray(row?.bbls) ? row.bbls : [];
    const existing = byProject.get(projectId) || {
      present: true,
      raw: [],
      valid: [],
      invalid: [],
    };
    existing.present = true;
    for (const value of rawList) {
      existing.raw.push(value);
      const normalized = normalizeBbl(value);
      if (!normalized) {
        const token = String(value ?? "").trim();
        if (token) existing.invalid.push(token);
        else existing.invalid.push("");
        continue;
      }
      existing.valid.push(normalized);
    }
    byProject.set(projectId, existing);
  }
  for (const entry of byProject.values()) {
    entry.valid = [...new Set(entry.valid)].sort();
    // Preserve first-seen invalid tokens; dedupe while keeping empty string once.
    const seenInvalid = new Set();
    const invalid = [];
    for (const token of entry.invalid) {
      if (seenInvalid.has(token)) continue;
      seenInvalid.add(token);
      invalid.push(token);
    }
    entry.invalid = invalid;
  }
  return byProject;
}

function classifyLayerMembership(type, stored) {
  if (stored == null) {
    return { status: "unavailable", ids: [] };
  }
  const normalized = normalizeParcelMembership(type, stored);
  if (!normalized) {
    return { status: "unavailable", ids: [] };
  }
  if (normalized.status === "matched") {
    return { status: "matched", ids: [...normalized.ids] };
  }
  if (normalized.status === "not_covered") {
    return { status: "uncovered", ids: [] };
  }
  if (normalized.status === "ambiguous_boundary") {
    return { status: "ambiguous", ids: [...normalized.ids] };
  }
  if (normalized.status === "source_unavailable") {
    return { status: "unavailable", ids: [] };
  }
  return { status: "unavailable", ids: [] };
}

/**
 * Resolve one BBL against a parcel shard document (or null when missing).
 */
export function resolveBblLayerMemberships(shardDoc, bbl) {
  const id = normalizeBbl(bbl);
  if (!id) return null;
  const bundle = lookupParcelMemberships(shardDoc, id);
  if (!bundle) {
    const layers = {};
    for (const type of LAND_PLACE_LAYERS) {
      layers[type] = { status: "unavailable", ids: [] };
    }
    return { bbl: id, layers, parcel_found: false };
  }
  const layers = {};
  for (const type of LAND_PLACE_LAYERS) {
    const stored = bundle.memberships?.[type];
    // lookupParcelMemberships already normalized; prefer status/ids from it.
    if (stored && typeof stored === "object" && Array.isArray(stored.ids)) {
      if (stored.status === "matched") {
        layers[type] = { status: "matched", ids: [...stored.ids].sort() };
      } else if (stored.status === "not_covered") {
        layers[type] = { status: "uncovered", ids: [] };
      } else if (stored.status === "ambiguous_boundary") {
        layers[type] = { status: "ambiguous", ids: [...stored.ids].sort() };
      } else {
        layers[type] = { status: "unavailable", ids: [] };
      }
    } else {
      layers[type] = classifyLayerMembership(type, stored);
    }
  }
  return { bbl: id, layers, parcel_found: true };
}

function layerVintagesFromManifest(parcelManifest) {
  const layers = asObject(parcelManifest?.membership?.layers) || {};
  const out = {};
  for (const type of LAND_PLACE_LAYERS) {
    out[type] = layers[type]?.vintage ?? null;
  }
  return out;
}

/**
 * Build the compact membership index and evidence shards for one catalog generation.
 *
 * @param {object} inputs
 * @param {object} inputs.catalog — admitted land_project_catalog document
 * @param {object|null|undefined} inputs.bblIndex — zap_bbl warehouse lookup; null = source missing
 * @param {(shardKey: string) => object|null|undefined} inputs.loadParcelShard
 * @param {object|null} [inputs.parcelManifest]
 * @param {object} [inputs.artifactHashes]
 * @param {object} [inputs.sourceDates]
 */
export function buildLandPlaceMembership(inputs = {}) {
  const catalog = inputs.catalog;
  if (!catalog || catalog.schema !== LAND_PROJECT_CATALOG_SCHEMA) {
    const error = new Error("land_place_membership requires an admitted land_project_catalog document");
    error.code = "LAND_PLACE_CATALOG_MISSING";
    throw error;
  }

  const bblSourceMissing = inputs.bblIndex == null;
  const bblByProject = bblSourceMissing ? new Map() : indexProjectBblAssociations(inputs.bblIndex);
  const loadParcelShard = typeof inputs.loadParcelShard === "function"
    ? inputs.loadParcelShard
    : () => null;
  const shardCache = new Map();
  const loadShardCached = (key) => {
    if (shardCache.has(key)) return shardCache.get(key);
    let doc = null;
    try {
      doc = loadParcelShard(key) || null;
    } catch {
      doc = null;
    }
    shardCache.set(key, doc);
    return doc;
  };

  const projects = landProjectRowsFromPayload(catalog)
    .map((row) => ({ ...row, project_id: cleanProjectId(row?.project_id) }))
    .filter((row) => row.project_id)
    .sort((left, right) => left.project_id.localeCompare(right.project_id));

  const byProject = {};
  const byGeography = {};
  for (const type of LAND_PLACE_LAYERS) {
    byGeography[type] = {};
  }
  const evidenceByShard = new Map();
  for (let i = 0; i < LAND_PLACE_EVIDENCE_SHARD_COUNT; i += 1) {
    const key = i.toString(16).padStart(2, "0");
    evidenceByShard.set(key, {
      schema: LAND_PLACE_EVIDENCE_SHARD_SCHEMA,
      key,
      association_kind: LAND_PLACE_ASSOCIATION_KIND,
      projects: {},
    });
  }

  const boundaryVintages = layerVintagesFromManifest(inputs.parcelManifest);
  const parcelVintage = inputs.parcelManifest?.coordinate_vintage ?? null;
  const hashes = asObject(inputs.artifactHashes) || {};

  for (const project of projects) {
    const projectId = project.project_id;
    const evidenceKey = landPlaceEvidenceShardKey(projectId);
    const publisherGeography = publisherGeographyFromProject(project);

    let associationState;
    let validBbls = [];
    let invalidBbls = [];

    if (bblSourceMissing) {
      associationState = LAND_PLACE_BBL_ASSOCIATION_STATES.SOURCE_MISSING;
    } else if (!bblByProject.has(projectId)) {
      associationState = LAND_PLACE_BBL_ASSOCIATION_STATES.ABSENT_FROM_INDEX;
    } else {
      const assoc = bblByProject.get(projectId);
      validBbls = assoc.valid;
      invalidBbls = assoc.invalid;
      associationState = validBbls.length === 0
        ? LAND_PLACE_BBL_ASSOCIATION_STATES.EMPTY
        : LAND_PLACE_BBL_ASSOCIATION_STATES.PRESENT;
    }

    const layerState = {};
    for (const type of LAND_PLACE_LAYERS) {
      layerState[type] = {
        total_bbls: validBbls.length,
        matched_bbls: 0,
        uncovered_bbls: 0,
        ambiguous_bbls: 0,
        unavailable_bbls: 0,
        placeBbls: new Map(), // placeId -> Set(bbl)
      };
    }

    const bblEvidence = {};
    for (const bbl of validBbls) {
      const parcelKey = parcelShardKey(bbl);
      const shardDoc = loadShardCached(parcelKey);
      const resolved = resolveBblLayerMemberships(shardDoc, bbl);
      const layerEvidence = {};
      for (const type of LAND_PLACE_LAYERS) {
        const result = resolved?.layers?.[type] || { status: "unavailable", ids: [] };
        const bucket = layerState[type];
        if (result.status === "matched") {
          bucket.matched_bbls += 1;
          for (const placeId of result.ids) {
            if (!civicGeographyKey(type, placeId)) continue;
            if (!bucket.placeBbls.has(placeId)) bucket.placeBbls.set(placeId, new Set());
            bucket.placeBbls.get(placeId).add(bbl);
          }
        } else if (result.status === "uncovered") {
          bucket.uncovered_bbls += 1;
        } else if (result.status === "ambiguous") {
          bucket.ambiguous_bbls += 1;
        } else {
          bucket.unavailable_bbls += 1;
        }
        layerEvidence[type] = {
          status: result.status,
          ids: result.status === "matched" || result.status === "ambiguous"
            ? [...result.ids].sort()
            : [],
        };
      }
      bblEvidence[bbl] = { layers: layerEvidence };
    }

    const compactLayers = {};
    const evidencePlaces = {};
    for (const type of LAND_PLACE_LAYERS) {
      const bucket = layerState[type];
      const places = [...bucket.placeBbls.keys()].sort();
      compactLayers[type] = {
        total_bbls: bucket.total_bbls,
        matched_bbls: bucket.matched_bbls,
        uncovered_bbls: bucket.uncovered_bbls,
        ambiguous_bbls: bucket.ambiguous_bbls,
        unavailable_bbls: bucket.unavailable_bbls,
        places,
      };
      const placeMap = {};
      for (const placeId of places) {
        const bbls = [...bucket.placeBbls.get(placeId)].sort();
        placeMap[placeId] = bbls;
        if (!byGeography[type][placeId]) byGeography[type][placeId] = new Set();
        byGeography[type][placeId].add(projectId);
      }
      evidencePlaces[type] = placeMap;
    }

    byProject[projectId] = {
      association_kind: LAND_PLACE_ASSOCIATION_KIND,
      bbl_association_state: associationState,
      valid_bbl_count: validBbls.length,
      invalid_bbl_count: invalidBbls.length,
      evidence_shard: evidenceKey,
      layers: compactLayers,
      publisher_geography: publisherGeography,
    };

    evidenceByShard.get(evidenceKey).projects[projectId] = {
      association_kind: LAND_PLACE_ASSOCIATION_KIND,
      bbl_association_state: associationState,
      valid_bbls: validBbls,
      invalid_bbls: invalidBbls,
      bbls: bblEvidence,
      places: evidencePlaces,
      publisher_geography: publisherGeography,
    };
  }

  const byGeographyOut = {};
  for (const type of LAND_PLACE_LAYERS) {
    const places = byGeography[type];
    const sortedPlaces = {};
    for (const placeId of Object.keys(places).sort()) {
      sortedPlaces[placeId] = [...places[placeId]].sort();
    }
    byGeographyOut[type] = sortedPlaces;
  }

  // Stable evidence shard project ordering.
  const evidenceShards = {};
  for (const [key, shard] of [...evidenceByShard.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const projectIds = Object.keys(shard.projects).sort();
    const projectsOut = {};
    for (const projectId of projectIds) {
      projectsOut[projectId] = shard.projects[projectId];
    }
    evidenceShards[key] = {
      schema: shard.schema,
      key: shard.key,
      association_kind: shard.association_kind,
      project_count: projectIds.length,
      projects: projectsOut,
    };
  }

  const catalogContentId = catalog.generation?.content_id ?? null;
  const sourceDates = {
    catalog_content_id: catalogContentId,
    catalog_materialized_at: catalog.source_dates?.warehouse_materialized_at
      ?? catalog.materialized_at
      ?? null,
    catalog_generated_at: catalog.source_dates?.defaults_generated_at
      ?? catalog.generated_at
      ?? null,
    bbl_materialized_at: bblSourceMissing ? null : (inputs.bblIndex?.materialized_at ?? null),
    parcel_coordinate_vintage: parcelVintage,
    boundary_vintages: boundaryVintages,
  };

  const contentId = landPlaceMembershipContentId({
    catalogContentId,
    projectIds: projects.map((row) => row.project_id),
    sourceDates,
    bblSourceMissing,
  });

  const index = {
    schema: LAND_PLACE_MEMBERSHIP_SCHEMA,
    association_kind: LAND_PLACE_ASSOCIATION_KIND,
    project_count: projects.length,
    layers: [...LAND_PLACE_LAYERS],
    bbl_source: bblSourceMissing
      ? { status: "missing", path: LAND_PLACE_BBL_INDEX_PATH }
      : {
        status: "present",
        path: LAND_PLACE_BBL_INDEX_PATH,
        materialized_at: inputs.bblIndex?.materialized_at ?? null,
        project_count: Number(inputs.bblIndex?.project_count) || null,
        bbl_row_count: Number(inputs.bblIndex?.bbl_row_count) || null,
        sha256: hashes.bbl_index || null,
      },
    by_project: byProject,
    by_geography: byGeographyOut,
    sources: {
      catalog: {
        path: "site/data/land_project_catalog.json",
        content_id: catalogContentId,
        sha256: hashes.catalog || null,
      },
      bbl_index: {
        path: LAND_PLACE_BBL_INDEX_PATH,
        status: bblSourceMissing ? "missing" : "present",
        sha256: bblSourceMissing ? null : (hashes.bbl_index || null),
      },
      parcel_geography: {
        path: "site/data/parcel-geography/manifest.json",
        coordinate_vintage: parcelVintage,
        boundary_vintages: boundaryVintages,
        sha256: hashes.parcel_manifest || null,
      },
    },
    source_dates: sourceDates,
    generation: {
      derivation: "node tools/build_land_place_membership.mjs",
      content_id: contentId,
    },
  };

  return { index, evidenceShards };
}

export function landPlaceMembershipContentId({
  catalogContentId,
  projectIds,
  sourceDates,
  bblSourceMissing,
}) {
  const ids = (Array.isArray(projectIds) ? projectIds : [])
    .map(cleanProjectId)
    .filter(Boolean)
    .slice()
    .sort((left, right) => left.localeCompare(right));
  const stamp = [
    catalogContentId || "",
    sourceDates?.bbl_materialized_at || "",
    sourceDates?.parcel_coordinate_vintage || "",
    JSON.stringify(sourceDates?.boundary_vintages || {}),
    bblSourceMissing ? "bbl_missing" : "bbl_present",
    ids.join("\n"),
  ].join("|");
  return `fnv1a32:${fnv1a32Utf8(stamp).toString(16).padStart(8, "0")}:${ids.length}`;
}

/** Coverage fraction matched/total for one project layer; null when total is 0. */
export function landPlaceLayerCoverage(projectEntry, layerType) {
  const layer = projectEntry?.layers?.[layerType];
  if (!layer) return null;
  const total = Number(layer.total_bbls) || 0;
  if (total <= 0) return null;
  return {
    matched: Number(layer.matched_bbls) || 0,
    total,
    fraction: `${Number(layer.matched_bbls) || 0}/${total}`,
  };
}

/**
 * Assert per-layer count partition: matched + uncovered + ambiguous + unavailable == total.
 * Invalid BBLs are outside this denominator. Optional evidence catches dropped invalids
 * and duplicate valid lots that the compact index alone cannot see.
 *
 * @param {object} projectEntry compact by_project entry
 * @param {object|null} [evidence] optional evidence-shard project record
 */
export function landPlaceLayerCountFindings(projectEntry, evidence = null) {
  const findings = [];
  if (!projectEntry || typeof projectEntry !== "object") {
    return ["project entry missing"];
  }

  const validCount = Number(projectEntry.valid_bbl_count);
  const invalidCount = Number(projectEntry.invalid_bbl_count);
  if (!Number.isFinite(validCount) || validCount < 0 || !Number.isInteger(validCount)) {
    findings.push(`valid_bbl_count missing or invalid (${projectEntry.valid_bbl_count})`);
  }
  if (!Number.isFinite(invalidCount) || invalidCount < 0 || !Number.isInteger(invalidCount)) {
    findings.push(`invalid_bbl_count missing or invalid (${projectEntry.invalid_bbl_count})`);
  }

  for (const type of LAND_PLACE_LAYERS) {
    const layer = projectEntry.layers?.[type];
    if (!layer) {
      findings.push(`layer ${type} missing`);
      continue;
    }
    const matched = Number(layer.matched_bbls || 0);
    const uncovered = Number(layer.uncovered_bbls || 0);
    const ambiguous = Number(layer.ambiguous_bbls || 0);
    const unavailable = Number(layer.unavailable_bbls || 0);
    const total = Number(layer.total_bbls || 0);
    const sum = matched + uncovered + ambiguous + unavailable;
    if (sum !== total) {
      findings.push(
        `layer ${type} counts ${sum} != total_bbls ${layer.total_bbls}`,
      );
    }
    // Invalid inputs stay outside the valid-BBL denominator.
    if (Number.isInteger(validCount) && total !== validCount) {
      findings.push(
        `layer ${type} total_bbls ${layer.total_bbls} != valid_bbl_count ${validCount}`,
      );
    }
    // Absorbing invalids into a complete-coverage claim (matched + invalid == total).
    if (
      Number.isInteger(invalidCount)
      && invalidCount > 0
      && matched + invalidCount === total
      && uncovered === 0
      && ambiguous === 0
      && unavailable === 0
    ) {
      findings.push(
        `layer ${type} matched_bbls + invalid_bbl_count ${matched + invalidCount} == total_bbls ${total}`,
      );
    }
  }

  const evidenceDoc = asObject(evidence);
  if (evidenceDoc) {
    const invalidList = Array.isArray(evidenceDoc.invalid_bbls) ? evidenceDoc.invalid_bbls : null;
    if (invalidList == null) {
      findings.push("evidence invalid_bbls missing");
    } else if (Number.isInteger(invalidCount) && invalidList.length !== invalidCount) {
      findings.push(
        `invalid_bbl_count ${invalidCount} != evidence invalid_bbls ${invalidList.length}`,
      );
    }

    const validList = Array.isArray(evidenceDoc.valid_bbls) ? evidenceDoc.valid_bbls : null;
    if (validList == null) {
      findings.push("evidence valid_bbls missing");
    } else {
      if (Number.isInteger(validCount) && validList.length !== validCount) {
        findings.push(
          `valid_bbl_count ${validCount} != evidence valid_bbls ${validList.length}`,
        );
      }
      if (new Set(validList).size !== validList.length) {
        findings.push("evidence valid_bbls contains duplicates");
      }
    }
  }

  return findings;
}

export function projectsForGeography(index, layerType, placeId) {
  const places = index?.by_geography?.[layerType];
  if (!places) return [];
  const list = places[placeId];
  return Array.isArray(list) ? [...list] : [];
}
