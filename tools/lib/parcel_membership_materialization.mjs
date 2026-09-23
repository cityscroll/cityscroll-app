/**
 * Parcel-membership materialization: typed per-layer matches computed once
 * from registered full-fidelity polygons and attached to the committed
 * citywide parcel-point shards.
 *
 * Build-time lib behind tools/build_parcel_memberships.mjs and its replay
 * tests. Points come from the committed parcel-geography generation; layers
 * come from the closed registry (site/data/geography/layer_registry.json)
 * full-fidelity artifacts. Rules this lib enforces:
 *
 *  - Only full-fidelity artifacts answer memberships. A layer document whose
 *    declared geometry_fidelity is not "full", or whose bytes are the
 *    registry's simplified artifact, is refused — simplified shapes are
 *    display-only and never make membership decisions.
 *  - A registered layer whose artifact cannot be read is recorded as
 *    source_unavailable for every parcel; healthy layers still resolve.
 *  - The existing exact point-in-polygon predicate decides every match. A
 *    bbox candidate index only prunes rings that cannot touch the query
 *    point; cells crossed by ring segments always run the exact predicate,
 *    so indexed results equal full-scan results.
 *  - Boundary matches are retained: every polygon containing the point is
 *    recorded with its boundary method, and multi-match layers state
 *    ambiguous_boundary instead of picking the first match.
 *  - Memberships attach per layer with independent provenance. When a
 *    layer's content digest and the input point digest are unchanged, the
 *    previous stored values are carried over verbatim; only changed layers
 *    are recomputed.
 */

import { createHash } from "node:crypto";

import {
  pointRelationToRing,
  pointRelationToCivicFeature,
  geoJsonGeometryToPolygons,
  loadCivicGeographyLayer,
} from "../../site/civic_geography.mjs";
import {
  PARCEL_MEMBERSHIP_LAYERS,
  PARCEL_MEMBERSHIP_MANIFEST_SCHEMA,
  PARCEL_MEMBERSHIP_SCHEMA,
} from "../../site/parcel_geography.mjs";

/**
 * Candidate grid resolution per layer axis. Performance-only: results are
 * identical for any value because crossing cells always run the exact
 * predicate. 768 keeps crossing lists small on the registered NYC layers.
 */
export const MEMBERSHIP_GRID_SIZE = 768;

export class SimplifiedGeometryRefusalError extends Error {
  constructor(type, detail) {
    super(`Refusing ${type} membership materialization from non-full geometry: ${detail}`);
    this.name = "SimplifiedGeometryRefusalError";
    this.type = type;
  }
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function ringBoundingBox(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of ring) {
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Build the bbox candidate index for one validated layer document.
 *
 * Every ring of every feature is rasterized on a uniform grid. A cell no
 * ring segment touches resolves uniformly — the ring's relation is constant
 * across the whole cell, decided once via the exact predicate's own crossing
 * rule — while a cell touched by ring segments records a crossing reference
 * and every query inside it runs the existing exact pointRelationToRing
 * predicate on that ring. A query point on a boundary always lies in a cell
 * whose rectangle some segment touches, so boundary classification is never
 * skipped. Query results are therefore identical to a full scan.
 *
 * The uniform fill uses the same half-open crossing expression as
 * pointRelationToRing at each cell center, evaluated once per row.
 * @param {object} layerDoc validated full-fidelity layer document
 */
export function buildLayerResolver(layerDoc) {
  const grid = MEMBERSHIP_GRID_SIZE;
  const features = layerDoc.features;
  const polygonsPerFeature = features.map((feature) => geoJsonGeometryToPolygons(feature.geometry));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  features.forEach((feature, fi) => {
    const b = Array.isArray(feature.bbox) && feature.bbox.length === 4
      ? feature.bbox
      : ringUnionBbox(polygonsPerFeature[fi]);
    if (!b) return;
    minX = Math.min(minX, b[0]);
    minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]);
    maxY = Math.max(maxY, b[3]);
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    throw new Error(`layer ${layerDoc.type} has no finite extent`);
  }
  const dx = (maxX - minX) / grid;
  const dy = (maxY - minY) / grid;
  const cellX = (x) => Math.min(grid - 1, Math.max(0, Math.floor((x - minX) / dx)));
  const cellY = (y) => Math.min(grid - 1, Math.max(0, Math.floor((y - minY) / dy)));

  // cell index -> array of ring references, pushed in feature/polygon/ring
  // order so per-feature runs stay contiguous and deterministic.
  const cells = new Map();
  const cellFor = (index) => {
    let list = cells.get(index);
    if (!list) {
      list = [];
      cells.set(index, list);
    }
    return list;
  };

  features.forEach((feature, fi) => {
    polygonsPerFeature[fi].forEach((polygon, pi) => {
      polygon.rings.forEach((ring, ri) => {
        if (!Array.isArray(ring) || ring.length < 3) return;
        const [rx0, ry0, rx1, ry1] = ringBoundingBox(ring);
        const gx0 = cellX(rx0);
        const gx1 = cellX(rx1);
        const gy0 = cellY(ry0);
        const gy1 = cellY(ry1);

        // Row buckets of segments (same-vertex adjacency), then per-row
        // crossing x's for the parity fill.
        const rows = new Map();
        for (let i = 0; i < ring.length - 1; i += 1) {
          const ax = Number(ring[i][0]);
          const ay = Number(ring[i][1]);
          const bx = Number(ring[i + 1][0]);
          const by = Number(ring[i + 1][1]);
          if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
            continue;
          }
          for (let row = cellY(Math.min(ay, by)); row <= cellY(Math.max(ay, by)); row += 1) {
            let bucket = rows.get(row);
            if (!bucket) {
              bucket = [];
              rows.set(row, bucket);
            }
            bucket.push([ay, by, ax, bx]);
          }
        }

        // Cells whose rectangle any segment bbox touches (inclusive) need
        // the exact predicate for every query inside them.
        const crossed = new Set();
        for (const bucket of rows.values()) {
          for (const [ay, by, ax, bx] of bucket) {
            const sx0 = cellX(Math.min(ax, bx));
            const sx1 = cellX(Math.max(ax, bx));
            const sy0 = cellY(Math.min(ay, by));
            const sy1 = cellY(Math.max(ay, by));
            for (let row = sy0; row <= sy1; row += 1) {
              for (let col = sx0; col <= sx1; col += 1) crossed.add(row * grid + col);
            }
          }
        }

        // Uniform fill: cells in the ring bbox that no segment touches get
        // the cell center's relation, using pointRelationToRing's crossing
        // expression evaluated once per row.
        for (let row = gy0; row <= gy1; row += 1) {
          const centerY = minY + (row + 0.5) * dy;
          const bucket = rows.get(row) || [];
          const crossings = [];
          for (const [ay, by, ax, bx] of bucket) {
            if ((ay > centerY) !== (by > centerY)) {
              crossings.push(((bx - ax) * (centerY - ay)) / (by - ay) + ax);
            }
          }
          crossings.sort((a, b) => a - b);
          let next = 0;
          for (let col = gx0; col <= gx1; col += 1) {
            const cellIndex = row * grid + col;
            if (crossed.has(cellIndex)) {
              cellFor(cellIndex).push({ fi, pi, ri, ring, relation: 2 });
              continue;
            }
            const centerX = minX + (col + 0.5) * dx;
            // A center exactly on the boundary implies its cell is crossed,
            // so consulted centers never equal a crossing x.
            while (next < crossings.length && crossings[next] < centerX) next += 1;
            if ((crossings.length - next) % 2 === 1) {
              cellFor(cellIndex).push({ fi, pi, ri, ring, relation: 1 });
            }
          }
        }
      });
    });
  });

  function relationForRef(ref, lon, lat) {
    if (ref.relation === 1) return "interior";
    return pointRelationToRing(lon, lat, ref.ring);
  }

  /**
   * Resolve one point against the indexed layer. Mirrors the production
   * pointRelationToCivicFeature composition (feature bbox gate, polygon
   * outer rings, holes, boundary precedence, first containing polygon wins)
   * with ring relations served by the index where uniform.
   * @param {number} lon
   * @param {number} lat
   * @returns {{ id: string, boundary: boolean }[]}
   */
  function resolvePoint(lon, lat) {
    const refs = cells.get(cellY(lat) * grid + cellX(lon));
    if (!refs || refs.length === 0) return [];
    const out = [];
    let index = 0;
    while (index < refs.length) {
      const fi = refs[index].fi;
      let end = index;
      while (end < refs.length && refs[end].fi === fi) end += 1;
      // Feature bbox gate, exactly like the production predicate.
      const bbox = features[fi].bbox;
      let skipped = false;
      if (Array.isArray(bbox) && bbox.length === 4) {
        if (lon < Number(bbox[0]) || lat < Number(bbox[1]) || lon > Number(bbox[2]) || lat > Number(bbox[3])) {
          skipped = true;
        }
      }
      if (!skipped) {
        // Group this feature's references by polygon.
        const byPolygon = new Map();
        for (let r = index; r < end; r += 1) {
          const ref = refs[r];
          let ringRefs = byPolygon.get(ref.pi);
          if (!ringRefs) {
            ringRefs = new Map();
            byPolygon.set(ref.pi, ringRefs);
          }
          ringRefs.set(ref.ri, ref);
        }
        let featureResult = null;
        for (const pi of [...byPolygon.keys()].sort((a, b) => a - b)) {
          const ringRefs = byPolygon.get(pi);
          const rings = polygonsPerFeature[fi][pi]?.rings || [];
          const outerRef = ringRefs.get(0);
          const outer = outerRef ? relationForRef(outerRef, lon, lat) : "exterior";
          if (outer === "exterior") continue;
          if (outer === "boundary") {
            featureResult = "boundary";
            break;
          }
          let inHole = false;
          for (let holeIndex = 1; holeIndex < rings.length; holeIndex += 1) {
            const holeRef = ringRefs.get(holeIndex);
            const relation = holeRef ? relationForRef(holeRef, lon, lat) : "exterior";
            if (relation === "boundary") {
              featureResult = "boundary";
              break;
            }
            if (relation === "interior") {
              inHole = true;
              break;
            }
          }
          if (featureResult === "boundary") break;
          if (!inHole) {
            featureResult = "interior";
            break;
          }
        }
        if (featureResult !== null) {
          out.push({ id: String(features[fi].id), boundary: featureResult === "boundary" });
        }
      }
      index = end;
    }
    return out;
  }

  return {
    type: String(layerDoc.type),
    vintage: String(layerDoc.vintage?.id || ""),
    featureCount: features.length,
    resolvePoint,
  };
}

function ringUnionBbox(polygons) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons || []) {
    for (const ring of polygon.rings || []) {
      const [x0, y0, x1, y1] = ringBoundingBox(ring);
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Full-scan resolution of one point against a layer document using the
 * production feature predicate directly. Used to prove the indexed resolver
 * returns identical results (card acceptance: indexed versus full scan).
 * @param {object} layerDoc
 * @param {number} lon
 * @param {number} lat
 * @returns {{ id: string, boundary: boolean }[]}
 */
export function fullScanLayerMatches(layerDoc, lon, lat) {
  const out = [];
  for (const feature of layerDoc.features) {
    const relation = pointRelationToCivicFeature(lon, lat, feature);
    if (relation !== "exterior") {
      out.push({ id: String(feature.id), boundary: relation === "boundary" });
    }
  }
  return out;
}

/**
 * Content digest over a generation's parcel points only: every BBL with its
 * exact coordinate, in deterministic order. Membership payloads never enter
 * this digest, so attaching or changing memberships cannot alter the point
 * identity — point content and every boundary layer content hash stay
 * independent inputs.
 * @param {Map<string, object>} shardDocs shard documents by shard key
 */
export function computeGenerationPointDigest(shardDocs) {
  const hash = createHash("sha256");
  for (const key of [...shardDocs.keys()].sort()) {
    const parcels = shardDocs.get(key)?.parcels || {};
    for (const bbl of Object.keys(parcels).sort()) {
      hash.update(`${key}|${bbl}|${parcels[bbl].lat}|${parcels[bbl].lon}\n`);
    }
  }
  return hash.digest("hex");
}

/**
 * Load one registered layer for materialization. Reads the registry's
 * full-fidelity artifact; refuses simplified or corrupted geometry; an
 * unreadable artifact is reported as source_unavailable, never fabricated.
 * @param {object} registryRow one row of the layer registry
 * @param {string} root repository root for path resolution
 * @param {(path: string) => Promise<Buffer>} readFileImpl
 */
export async function loadMembershipLayer(registryRow, root, readFileImpl) {
  const type = String(registryRow?.type || "");
  const fullPath = registryRow?.artifacts?.full?.path;
  if (!fullPath) {
    return { type, status: "source_unavailable", reason: "registry_has_no_full_artifact" };
  }
  let bytes;
  try {
    bytes = await readFileImpl(`${root}/${fullPath}`);
  } catch {
    return { type, status: "source_unavailable", reason: "artifact_unreadable" };
  }
  const simplifiedSha = String(registryRow?.artifacts?.simplified?.sha256 || "");
  const sha256 = sha256Buffer(bytes);
  if (simplifiedSha && sha256 === simplifiedSha) {
    throw new SimplifiedGeometryRefusalError(
      type,
      "artifact bytes match the registry's simplified digest, not the full-fidelity geometry",
    );
  }
  let doc;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SimplifiedGeometryRefusalError(type, "full artifact is not parseable JSON");
  }
  if (doc?.geometry_fidelity !== "full") {
    throw new SimplifiedGeometryRefusalError(
      type,
      `document declares geometry_fidelity ${JSON.stringify(doc?.geometry_fidelity)}`,
    );
  }
  if (!loadCivicGeographyLayer(doc)) {
    throw new SimplifiedGeometryRefusalError(type, "document fails the registered layer validation");
  }
  if (doc.type !== type) {
    throw new SimplifiedGeometryRefusalError(type, "document type does not match the registry row");
  }
  const actualCount = Number(doc.coverage?.actual_feature_count);
  if (Number.isFinite(actualCount) && doc.features.length !== actualCount) {
    throw new SimplifiedGeometryRefusalError(
      type,
      `feature count ${doc.features.length} != declared ${actualCount}`,
    );
  }
  return {
    type,
    status: "resolved",
    doc,
    sha256,
    artifactPath: fullPath,
    vintage: String(doc.vintage?.id || ""),
    sourceContract: String(doc.source?.contract_id || registryRow.source?.contract_id || ""),
    featureCount: doc.features.length,
  };
}

function storedValueFor(matches) {
  if (matches.length === 1 && !matches[0].boundary) {
    return matches[0].id;
  }
  const ids = matches.map((match) => match.id).sort();
  const value = { ids };
  const boundaryIds = matches.filter((match) => match.boundary).map((match) => match.id).sort();
  if (boundaryIds.length) value.boundary_ids = boundaryIds;
  value.status = matches.length === 0
    ? "not_covered"
    : matches.length > 1
      ? "ambiguous_boundary"
      : "matched";
  return value;
}

function statusOfStoredValue(value) {
  if (typeof value === "string") return "matched";
  const ids = Array.isArray(value?.ids) ? value.ids : [];
  if (value?.status) return String(value.status);
  if (ids.length === 0) return "not_covered";
  if (ids.length > 1) return "ambiguous_boundary";
  return "matched";
}

function unavailableValue() {
  return { ids: [], status: "source_unavailable" };
}

/**
 * Materialize memberships for a whole generation.
 *
 * Reads the input shard documents (which may already carry a previous
 * membership generation), resolves each parcel against every healthy layer,
 * and returns updated shard documents plus the manifest membership block.
 * When the previous generation recorded the same input point digest AND the
 * same per-layer content digest, that layer's stored values are carried over
 * verbatim; only changed layers are recomputed. Points are copied through
 * untouched — membership work never re-geocodes or moves a parcel point.
 *
 * @param {object} opts
 * @param {object} opts.manifest input generation manifest (may carry a previous `membership` block)
 * @param {Map<string, object>} opts.shardDocs input shard documents by shard key
 * @param {Map<string, object>} opts.layers type -> loadMembershipLayer() result (resolved or source_unavailable)
 * @param {{ buildLayerResolver?: typeof buildLayerResolver }} [opts.impl] test seam for the resolver factory
 * @param {{ generatedAt?: string, startedAt?: string, completedAt?: string, durationMs?: number, indexMs?: number, resolveMs?: number }} [opts.timing] wall-clock receipt (callers may pin it)
 */
export async function materializeParcelMemberships(opts) {
  const { manifest, shardDocs, layers } = opts;
  const resolverFactory = opts.impl?.buildLayerResolver || buildLayerResolver;
  const timing = opts.timing || {};

  const indexStarted = Date.now();
  const previous = manifest?.membership?.schema === PARCEL_MEMBERSHIP_MANIFEST_SCHEMA
    ? manifest.membership
    : null;
  const pointsDigest = computeGenerationPointDigest(shardDocs);
  const previousReusable = Boolean(previous && previous.inputs?.points_sha256 === pointsDigest);
  const layerReused = new Map();
  const resolvers = new Map();
  const provenance = new Map();
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const layer = layers.get(type);
    if (!layer) {
      throw new Error(`materialization is missing layer ${type}; pass an explicit source_unavailable result instead`);
    }
    provenance.set(type, layer);
    if (layer.status !== "resolved") continue;
    const previousLayer = previousReusable ? previous?.layers?.[type] : null;
    if (
      previousLayer
      && previousLayer.status === "resolved"
      && previousLayer.sha256 === layer.sha256
      && previousLayer.counts
      && Number(previousLayer.counts.parcels) > 0
    ) {
      // Identical layer content against the identical point population: the
      // previous stored values are still the truth; skip the index entirely.
      layerReused.set(type, true);
      continue;
    }
    resolvers.set(type, resolverFactory(layer.doc));
    layerReused.set(type, false);
  }
  const indexMs = Number.isFinite(timing.indexMs) ? timing.indexMs : Date.now() - indexStarted;

  const counts = new Map(PARCEL_MEMBERSHIP_LAYERS.map((type) => [type, {
    parcels: 0,
    matched: 0,
    not_covered: 0,
    ambiguous_boundary: 0,
    source_unavailable: 0,
    reused: 0,
    computed: 0,
  }]));

  const resolveStarted = Date.now();
  const outShards = new Map();
  for (const [key, shard] of shardDocs) {
    const reusableLayers = new Map();
    if (previousReusable && shard.memberships?.schema === PARCEL_MEMBERSHIP_SCHEMA) {
      for (const type of PARCEL_MEMBERSHIP_LAYERS) {
        if (!layerReused.get(type)) continue;
        const proven = shard.memberships?.layers?.[type];
        const currentLayer = provenance.get(type);
        if (proven?.sha256 === currentLayer.sha256) reusableLayers.set(type, true);
      }
    }
    const newParcels = {};
    for (const [bbl, entry] of Object.entries(shard.parcels || {})) {
      const memberships = {};
      for (const type of PARCEL_MEMBERSHIP_LAYERS) {
        const layerCounts = counts.get(type);
        layerCounts.parcels += 1;
        const previousValue = reusableLayers.has(type)
          && entry.memberships
          && Object.hasOwn(entry.memberships, type)
          ? entry.memberships[type]
          : null;
        if (previousValue !== null) {
          memberships[type] = previousValue;
          const status = statusOfStoredValue(previousValue);
          if (layerCounts[status] !== undefined) layerCounts[status] += 1;
          layerCounts.reused += 1;
          continue;
        }
        const layer = provenance.get(type);
        if (layer.status !== "resolved") {
          memberships[type] = unavailableValue();
          layerCounts.source_unavailable += 1;
          layerCounts.computed += 1;
          continue;
        }
        const matches = resolvers.get(type).resolvePoint(Number(entry.lon), Number(entry.lat));
        memberships[type] = storedValueFor(matches);
        if (matches.length === 0) layerCounts.not_covered += 1;
        else if (matches.length > 1) layerCounts.ambiguous_boundary += 1;
        else layerCounts.matched += 1;
        layerCounts.computed += 1;
      }
      newParcels[bbl] = { lat: entry.lat, lon: entry.lon, memberships };
    }
    const membershipHeader = { schema: PARCEL_MEMBERSHIP_SCHEMA, layers: {} };
    for (const type of PARCEL_MEMBERSHIP_LAYERS) {
      const layer = provenance.get(type);
      membershipHeader.layers[type] = layer.status === "resolved"
        ? {
          status: "resolved",
          vintage: layer.vintage,
          geometry_fidelity: "full",
          sha256: layer.sha256,
          source_contract: layer.sourceContract,
          feature_count: layer.featureCount,
        }
        : {
          status: "source_unavailable",
          vintage: null,
          geometry_fidelity: null,
          sha256: null,
          source_contract: layer.sourceContract || null,
          feature_count: null,
        };
    }
    outShards.set(key, {
      schema: shard.schema,
      key,
      memberships: membershipHeader,
      parcels: newParcels,
    });
  }
  const resolveMs = Number.isFinite(timing.resolveMs) ? timing.resolveMs : Date.now() - resolveStarted;

  let resolvedParcels = 0;
  for (const shard of outShards.values()) resolvedParcels += Object.keys(shard.parcels).length;

  const manifestBlock = {
    schema: PARCEL_MEMBERSHIP_MANIFEST_SCHEMA,
    generated_at: timing.generatedAt || new Date().toISOString(),
    inputs: {
      points_sha256: pointsDigest,
      point_coordinate_vintage: String(manifest?.coordinate_vintage || ""),
    },
    layers: {},
    resolved_parcels: resolvedParcels,
    build: {
      started_at: timing.startedAt || new Date().toISOString(),
      completed_at: timing.completedAt || new Date().toISOString(),
      duration_ms: Number.isFinite(timing.durationMs) ? timing.durationMs : indexMs + resolveMs,
      index_ms: indexMs,
      resolve_ms: resolveMs,
    },
  };
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const layer = provenance.get(type);
    const layerCounts = counts.get(type);
    manifestBlock.layers[type] = layer.status === "resolved"
      ? {
        status: "resolved",
        vintage: layer.vintage,
        geometry_fidelity: "full",
        sha256: layer.sha256,
        artifact_path: layer.artifactPath,
        source_contract: layer.sourceContract,
        feature_count: layer.featureCount,
        computation: layerReused.get(type) && layerCounts.computed === 0 ? "reused" : "computed",
        counts: {
          parcels: layerCounts.parcels,
          matched: layerCounts.matched,
          not_covered: layerCounts.not_covered,
          ambiguous_boundary: layerCounts.ambiguous_boundary,
        },
      }
      : {
        status: "source_unavailable",
        reason: layer.reason || "unavailable",
        vintage: null,
        geometry_fidelity: null,
        sha256: null,
        artifact_path: null,
        source_contract: layer.sourceContract || null,
        feature_count: null,
        counts: {
          parcels: layerCounts.parcels,
          matched: 0,
          not_covered: 0,
          ambiguous_boundary: 0,
          source_unavailable: layerCounts.source_unavailable,
        },
      };
  }
  return { shards: outShards, membership: manifestBlock, counts };
}
