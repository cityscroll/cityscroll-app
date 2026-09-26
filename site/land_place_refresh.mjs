/**
 * Land place-membership refresh and coherent generation publication.
 *
 * Builds on the L01 catalog and L02 membership join: hash catalog rows,
 * project-BBL rows, referenced parcel shards, and boundary vintages; rebuild
 * when those inputs change; ignore text-address-only updates; stage immutable
 * generation assets (compact index + evidence shards + reverse geography);
 * validate them against one generation; then flip the active pointer. Failed
 * promotion retains the last-good generation. Refresh timestamps never replace
 * publisher or boundary dates on the membership document.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  LAND_PLACE_ASSOCIATION_KIND,
  LAND_PLACE_BBL_INDEX_PATH,
  LAND_PLACE_EVIDENCE_DIR,
  LAND_PLACE_EVIDENCE_SHARD_COUNT,
  LAND_PLACE_EVIDENCE_SHARD_SCHEMA,
  LAND_PLACE_LAYERS,
  LAND_PLACE_MEMBERSHIP_PATH,
  LAND_PLACE_MEMBERSHIP_SCHEMA,
  buildLandPlaceMembership,
  indexProjectBblAssociations,
  landPlaceEvidenceShardKey,
} from "./land_place_membership.mjs";
import {
  LAND_PROJECT_CATALOG_SCHEMA,
  landProjectRowsFromPayload,
} from "./land_project_catalog.mjs";
import { tryBootstrapCommittedRefresh } from "./generation_refresh_bootstrap.mjs";
import { parcelShardKey } from "./parcel_geography.mjs";

export const LAND_PLACE_REFRESH_SCHEMA = "cityscroll.land_place_refresh.v1";
export const LAND_PLACE_REFRESH_RECEIPT_SCHEMA = "cityscroll.land_place_refresh_receipt.v1";
export const LAND_PLACE_REFRESH_PLAN_SCHEMA = "cityscroll.land_place_refresh_plan.v1";
export const LAND_PLACE_GENERATION_MANIFEST_SCHEMA =
  "cityscroll.land_place_generation_manifest.v1";
export const LAND_PLACE_CONSUMER_SCHEMA = "cityscroll.land_place_consumer.v1";

export const LAND_PLACE_PUBLIC_DIR = "site/data/land-place-generations";
export const LAND_PLACE_ACTIVE_POINTER = "ACTIVE";
export const LAND_PLACE_STAGING_DIRNAME = ".staging";
export const LAND_PLACE_REFRESH_RECEIPT_NAME = "refresh-receipt.json";

export const LAND_PLACE_CONSUMERS = Object.freeze([
  "index",
  "evidence",
  "reverse",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function atomicWriteFile(filePath, contents, { nowMs = null } = {}) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  // determinism-lint: allow clock temp-file uniqueness for atomic rename; the
  // written payload itself stays a pure function of the caller-supplied contents.
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${stamp}.tmp`,
  );
  writeFileSync(tempPath, contents);
  renameSync(tempPath, filePath);
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function serializeLandPlaceMembership(indexDoc) {
  return `${JSON.stringify(indexDoc, null, 2)}\n`;
}

export function serializeLandPlaceEvidenceShard(shard) {
  return `${JSON.stringify(shard, null, 2)}\n`;
}

export function landPlaceRefreshReceiptPath(publicDir) {
  return path.join(publicDir, LAND_PLACE_REFRESH_RECEIPT_NAME);
}

export function loadLandPlaceRefreshReceipt(publicDir) {
  return readJsonIfExists(landPlaceRefreshReceiptPath(publicDir));
}

export function writeLandPlaceRefreshReceipt(publicDir, receipt) {
  mkdirSync(publicDir, { recursive: true });
  atomicWriteFile(
    landPlaceRefreshReceiptPath(publicDir),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return landPlaceRefreshReceiptPath(publicDir);
}

function layerVintagesFromManifest(parcelManifest) {
  const layers = parcelManifest?.membership?.layers || {};
  const out = {};
  for (const type of LAND_PLACE_LAYERS) {
    const vintage = layers[type]?.vintage;
    if (vintage != null && String(vintage).trim()) out[type] = String(vintage).trim();
  }
  return out;
}

/**
 * Hash the inputs that invalidate Land place joins.
 * Address-index identity is recorded for diagnostics but excluded from the
 * aggregate so text-address-only updates do not rebuild BBL memberships.
 */
export function computeLandPlaceInputHashes({
  catalog = null,
  bblIndex = null,
  parcelManifest = null,
  loadParcelShard = null,
  addressIndexManifest = null,
} = {}) {
  const catalogRows = {};
  for (const row of landProjectRowsFromPayload(catalog)) {
    const id = clean(row?.project_id);
    if (!id) continue;
    catalogRows[id] = sha256Text(stableStringify(row));
  }

  const bblByProject = bblIndex == null ? new Map() : indexProjectBblAssociations(bblIndex);
  const bblRows = {};
  const referencedShards = new Set();
  for (const [projectId, assoc] of bblByProject.entries()) {
    bblRows[projectId] = sha256Text(stableStringify({
      valid: assoc.valid,
      invalid: assoc.invalid,
    }));
    for (const bbl of assoc.valid) referencedShards.add(parcelShardKey(bbl));
  }

  const parcelShards = {};
  if (typeof loadParcelShard === "function") {
    for (const key of [...referencedShards].sort()) {
      let doc = null;
      try {
        doc = loadParcelShard(key) || null;
      } catch {
        doc = null;
      }
      parcelShards[key] = doc == null ? null : sha256Text(stableStringify(doc));
    }
  }

  const boundaryVintages = layerVintagesFromManifest(parcelManifest);
  const parcelVintage = parcelManifest?.coordinate_vintage ?? null;
  const addressIdentity = addressIndexManifest
    ? sha256Text(stableStringify({
      schema: addressIndexManifest.schema || null,
      content_sha256: addressIndexManifest.content_sha256
        || addressIndexManifest.source?.sha256
        || null,
      generated_at: addressIndexManifest.generated_at || null,
    }))
    : null;

  const aggregate = sha256Text(stableStringify({
    catalogRows,
    bblRows,
    parcelShards,
    boundaryVintages,
    parcelVintage,
    bblSourceMissing: bblIndex == null,
  }));

  return Object.freeze({
    schema: LAND_PLACE_REFRESH_SCHEMA,
    catalog_rows: Object.freeze(catalogRows),
    bbl_rows: Object.freeze(bblRows),
    parcel_shards: Object.freeze(parcelShards),
    boundary_vintages: Object.freeze(boundaryVintages),
    parcel_coordinate_vintage: parcelVintage,
    address_index_identity: addressIdentity,
    bbl_source_missing: bblIndex == null,
    aggregate,
  });
}

function changedKeys(prior = {}, current = {}) {
  const keys = new Set([...Object.keys(prior || {}), ...Object.keys(current || {})]);
  const changed = [];
  for (const key of keys) {
    if ((prior?.[key] || null) !== (current?.[key] || null)) changed.push(key);
  }
  return changed.sort();
}

/**
 * Decide which projects must rebuild given prior and current fingerprints.
 * Address-index identity never forces a BBL-join rebuild on its own.
 */
export function planLandPlaceRefresh({
  previousHashes = null,
  currentHashes = null,
  force = false,
  activeGeneration = null,
} = {}) {
  const reasons = [];
  const changedInputs = [];
  const rebuildProjectIds = new Set();

  if (force) reasons.push("force");
  if (!activeGeneration) reasons.push("missing_active_generation");
  if (!previousHashes) reasons.push("missing_previous_hashes");
  if (!currentHashes?.aggregate) reasons.push("missing_current_hashes");

  let rebuildAll = Boolean(force || !activeGeneration || !previousHashes || !currentHashes);

  if (previousHashes && currentHashes) {
    const catalogChanged = changedKeys(previousHashes.catalog_rows, currentHashes.catalog_rows);
    const bblChanged = changedKeys(previousHashes.bbl_rows, currentHashes.bbl_rows);
    // Only digest flips on still-referenced shard keys force a geography-wide
    // rebuild. Keys that appear or disappear solely because BBL rows changed are
    // already covered by bbl_rows selective invalidation.
    const priorShards = previousHashes.parcel_shards || {};
    const currentShards = currentHashes.parcel_shards || {};
    const shardDigestChanged = [];
    for (const key of Object.keys(currentShards)) {
      if (!(key in priorShards)) continue;
      if ((priorShards[key] || null) !== (currentShards[key] || null)) {
        shardDigestChanged.push(key);
      }
    }
    const boundaryChanged = stableStringify(previousHashes.boundary_vintages || {})
      !== stableStringify(currentHashes.boundary_vintages || {})
      || (previousHashes.parcel_coordinate_vintage || null)
        !== (currentHashes.parcel_coordinate_vintage || null)
      || Boolean(previousHashes.bbl_source_missing) !== Boolean(currentHashes.bbl_source_missing);

    if (catalogChanged.length) {
      changedInputs.push("catalog_rows");
      for (const id of catalogChanged) rebuildProjectIds.add(id);
    }
    if (bblChanged.length) {
      changedInputs.push("bbl_rows");
      for (const id of bblChanged) rebuildProjectIds.add(id);
    }
    if (shardDigestChanged.length) {
      changedInputs.push("parcel_shards");
      rebuildAll = true;
    }
    if (boundaryChanged) {
      changedInputs.push("boundary_vintages");
      rebuildAll = true;
    }

    // Address-only drift is observed but never invalidates BBL joins.
    if (
      (previousHashes.address_index_identity || null)
      !== (currentHashes.address_index_identity || null)
    ) {
      reasons.push("address_index_changed_ignored");
    }

    if (changedInputs.length) reasons.push(`changed:${changedInputs.join(",")}`);
    if (previousHashes.aggregate !== currentHashes.aggregate) {
      // Aggregate already excludes address identity.
      if (!changedInputs.length && !force) {
        rebuildAll = true;
        reasons.push("aggregate_changed");
      }
    }
  }

  const workRequired = rebuildAll
    || rebuildProjectIds.size > 0
    || force
    || !activeGeneration
    || !previousHashes
    || !currentHashes
    || (previousHashes && currentHashes && previousHashes.aggregate !== currentHashes.aggregate);

  if (!workRequired) reasons.push("inputs_unchanged");

  return Object.freeze({
    schema: LAND_PLACE_REFRESH_PLAN_SCHEMA,
    work_required: Boolean(workRequired),
    rebuild_all: Boolean(rebuildAll || force || !activeGeneration),
    rebuild_project_ids: Object.freeze([...rebuildProjectIds].sort()),
    changed_inputs: Object.freeze([...changedInputs]),
    reasons: Object.freeze([...reasons]),
  });
}

/**
 * Build the three public consumers that must agree on one generation before
 * promotion: compact index, evidence shard set, and reverse geography map.
 */
export function buildLandPlaceConsumers(indexDoc, evidenceShards = {}) {
  if (!indexDoc || indexDoc.schema !== LAND_PLACE_MEMBERSHIP_SCHEMA) {
    throw new Error("land place consumers require a land_place_membership document");
  }
  const generationId = clean(indexDoc.generation?.id || indexDoc.generation?.content_id);
  if (!generationId) throw new Error("land place membership is missing generation.id");

  const indexConsumer = Object.freeze({
    schema: LAND_PLACE_CONSUMER_SCHEMA,
    consumer: "index",
    generation_id: generationId,
    association_kind: LAND_PLACE_ASSOCIATION_KIND,
    project_count: indexDoc.project_count,
    content_sha256: sha256Text(serializeLandPlaceMembership({
      ...indexDoc,
      // Exclude activation-only built_at drift from the consumer hash when the
      // membership body and source dates are otherwise identical.
      generation: {
        ...indexDoc.generation,
        built_at: null,
      },
    })),
  });

  const shardDigests = {};
  let projectCount = 0;
  for (const key of Object.keys(evidenceShards || {}).sort()) {
    const shard = evidenceShards[key];
    const stamped = {
      ...shard,
      generation_id: generationId,
    };
    shardDigests[key] = sha256Text(serializeLandPlaceEvidenceShard(stamped));
    projectCount += Number(shard?.project_count) || 0;
  }
  const evidenceConsumer = Object.freeze({
    schema: LAND_PLACE_CONSUMER_SCHEMA,
    consumer: "evidence",
    generation_id: generationId,
    shard_count: LAND_PLACE_EVIDENCE_SHARD_COUNT,
    project_count: projectCount,
    shard_digests: Object.freeze(shardDigests),
    content_sha256: sha256Text(stableStringify(shardDigests)),
  });

  const reverseConsumer = Object.freeze({
    schema: LAND_PLACE_CONSUMER_SCHEMA,
    consumer: "reverse",
    generation_id: generationId,
    by_geography: indexDoc.by_geography,
    content_sha256: sha256Text(stableStringify(indexDoc.by_geography || {})),
  });

  return Object.freeze({
    index: indexConsumer,
    evidence: evidenceConsumer,
    reverse: reverseConsumer,
    generation_id: generationId,
  });
}

export function serializeLandPlaceConsumer(consumer) {
  return `${JSON.stringify(consumer, null, 2)}\n`;
}

/**
 * Refuse promotion unless every public consumer pins the same generation and
 * the compact index covers a non-empty admitted catalog.
 */
export function validateLandPlaceConsumers(consumers, generationId, {
  requireProjects = true,
} = {}) {
  const errors = [];
  const expected = clean(generationId);
  if (!expected) errors.push("missing_generation_id");
  for (const name of LAND_PLACE_CONSUMERS) {
    const consumer = consumers?.[name];
    if (!consumer) {
      errors.push(`missing_consumer:${name}`);
      continue;
    }
    if (consumer.schema !== LAND_PLACE_CONSUMER_SCHEMA) {
      errors.push(`invalid_consumer_schema:${name}`);
    }
    if (clean(consumer.generation_id) !== expected) {
      errors.push(`generation_mismatch:${name}`);
    }
    if (!clean(consumer.content_sha256)) {
      errors.push(`missing_content_hash:${name}`);
    }
  }
  const projectCount = Number(consumers?.index?.project_count);
  if (requireProjects && !(projectCount > 0)) {
    errors.push("empty_project_index");
  }
  const evidenceShards = Number(consumers?.evidence?.shard_count);
  if (evidenceShards !== LAND_PLACE_EVIDENCE_SHARD_COUNT) {
    errors.push("evidence_shard_count_mismatch");
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    generation_id: expected || null,
  });
}

function listGenerationDirs(publicDir) {
  if (!existsSync(publicDir)) return [];
  return readdirSync(publicDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== LAND_PLACE_STAGING_DIRNAME && !name.startsWith("."));
}

function expectedEvidenceKeys() {
  const keys = [];
  for (let i = 0; i < LAND_PLACE_EVIDENCE_SHARD_COUNT; i += 1) {
    keys.push(i.toString(16).padStart(2, "0"));
  }
  return keys;
}

/**
 * Publish immutable generation assets, then switch the active reference.
 * Retains the immediately preceding complete generation for in-flight readers.
 * Mirrors the active compact index and evidence shards into the live Paths.
 */
export function activateLandPlaceGeneration({
  publicDir,
  generation,
  indexDoc,
  evidenceShards = {},
  consumers = null,
  inputHashes = null,
  builtAt = null,
  failBeforeActivate = false,
  failAfterImmutablePublish = false,
  injectMixedGeneration = false,
  activeIndexPath = null,
  activeEvidenceDir = null,
} = {}) {
  if (!publicDir) throw new Error("activateLandPlaceGeneration requires publicDir");
  const generationId = clean(generation || indexDoc?.generation?.id || indexDoc?.generation?.content_id);
  if (!generationId) throw new Error("activateLandPlaceGeneration requires generation");
  if (!indexDoc) throw new Error("activateLandPlaceGeneration requires indexDoc");

  const stampedIndex = {
    ...indexDoc,
    generation: {
      ...indexDoc.generation,
      id: generationId,
      content_id: indexDoc.generation?.content_id || generationId,
      built_at: clean(builtAt || indexDoc.generation?.built_at) || null,
    },
  };

  const stampedEvidence = {};
  for (const key of expectedEvidenceKeys()) {
    const shard = evidenceShards[key] || {
      schema: LAND_PLACE_EVIDENCE_SHARD_SCHEMA,
      key,
      association_kind: LAND_PLACE_ASSOCIATION_KIND,
      project_count: 0,
      projects: {},
    };
    stampedEvidence[key] = {
      ...shard,
      generation_id: generationId,
    };
  }

  const baseConsumers = consumers || buildLandPlaceConsumers(stampedIndex, stampedEvidence);
  const builtConsumers = injectMixedGeneration
    ? Object.freeze({
      ...baseConsumers,
      reverse: Object.freeze({
        ...baseConsumers.reverse,
        generation_id: `mixed-${generationId}`,
      }),
    })
    : baseConsumers;

  const validation = validateLandPlaceConsumers(builtConsumers, generationId, {
    requireProjects: true,
  });
  if (!validation.ok) {
    const error = new Error(
      `land place generation validation failed: ${validation.errors.join(",")}`,
    );
    error.validation = validation;
    error.activation = {
      activated: false,
      active_generation: loadActiveLandPlacePointer(publicDir)?.active_generation || null,
      previous_generation: loadActiveLandPlacePointer(publicDir)?.previous_generation || null,
    };
    throw error;
  }

  mkdirSync(publicDir, { recursive: true });
  const stagingDir = path.join(publicDir, LAND_PLACE_STAGING_DIRNAME);
  const generationDir = path.join(publicDir, generationId);
  const previousActive = loadActiveLandPlacePointer(publicDir);

  try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(path.join(stagingDir, "land-place-evidence"), { recursive: true });

    const manifest = {
      schema: LAND_PLACE_GENERATION_MANIFEST_SCHEMA,
      generation_id: generationId,
      built_at: stampedIndex.generation.built_at,
      input_hashes: inputHashes
        ? {
          aggregate: inputHashes.aggregate,
          boundary_vintages: inputHashes.boundary_vintages,
          parcel_coordinate_vintage: inputHashes.parcel_coordinate_vintage,
          address_index_identity: inputHashes.address_index_identity,
        }
        : null,
      source_dates: stampedIndex.source_dates || null,
      project_count: stampedIndex.project_count,
      consumers: Object.fromEntries(
        LAND_PLACE_CONSUMERS.map((name) => [name, {
          generation_id: builtConsumers[name].generation_id,
          content_sha256: builtConsumers[name].content_sha256,
        }]),
      ),
    };

    atomicWriteFile(
      path.join(stagingDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    atomicWriteFile(
      path.join(stagingDir, "index.json"),
      serializeLandPlaceMembership(stampedIndex),
    );
    atomicWriteFile(
      path.join(stagingDir, "reverse.json"),
      serializeLandPlaceConsumer(builtConsumers.reverse),
    );
    atomicWriteFile(
      path.join(stagingDir, "evidence.json"),
      serializeLandPlaceConsumer(builtConsumers.evidence),
    );
    for (const key of expectedEvidenceKeys()) {
      atomicWriteFile(
        path.join(stagingDir, "land-place-evidence", `${key}.json`),
        serializeLandPlaceEvidenceShard(stampedEvidence[key]),
      );
    }

    if (failBeforeActivate) {
      throw new Error("land place refresh forced failure before activation");
    }

    // Immutable assets land under the generation id before the active pointer moves.
    rmSync(generationDir, { recursive: true, force: true });
    renameSync(stagingDir, generationDir);

    // Injection point between the immutable move and the active-pointer write.
    // Callers that observe here can pin the new generation while ACTIVE still
    // names the previous one.
    if (failAfterImmutablePublish) {
      const error = new Error(
        "land place refresh forced failure after immutable publish before active pointer",
      );
      error.published_generation = generationId;
      throw error;
    }

    const pointer = {
      schema: LAND_PLACE_GENERATION_MANIFEST_SCHEMA,
      active_generation: generationId,
      activated_at: manifest.built_at,
      previous_generation: previousActive?.active_generation || null,
    };
    if (!pointer.activated_at) {
      throw new Error("activateLandPlaceGeneration requires built_at");
    }
    atomicWriteFile(
      path.join(publicDir, LAND_PLACE_ACTIVE_POINTER),
      `${JSON.stringify(pointer, null, 2)}\n`,
    );

    atomicWriteFile(
      path.join(publicDir, "manifest.json"),
      `${JSON.stringify({ ...manifest, active_generation: generationId }, null, 2)}\n`,
    );

    // Convenience live copies for Pages/static readers that do not pin a generation.
    if (activeIndexPath) {
      atomicWriteFile(activeIndexPath, serializeLandPlaceMembership(stampedIndex));
    }
    if (activeEvidenceDir) {
      mkdirSync(activeEvidenceDir, { recursive: true });
      for (const key of expectedEvidenceKeys()) {
        atomicWriteFile(
          path.join(activeEvidenceDir, `${key}.json`),
          serializeLandPlaceEvidenceShard(stampedEvidence[key]),
        );
      }
    }

    const retain = new Set(
      [generationId, pointer.previous_generation].filter(Boolean),
    );
    for (const name of listGenerationDirs(publicDir)) {
      if (retain.has(name)) continue;
      rmSync(path.join(publicDir, name), { recursive: true, force: true });
    }

    return {
      activated: true,
      generation: generationId,
      previous_generation: pointer.previous_generation,
      public_dir: publicDir,
      generation_dir: generationDir,
      consumers: builtConsumers,
      manifest,
      pointer,
      index: stampedIndex,
      evidenceShards: stampedEvidence,
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    const stillActive = loadActiveLandPlacePointer(publicDir);
    error.activation = {
      activated: false,
      active_generation: stillActive?.active_generation || previousActive?.active_generation || null,
      previous_generation: previousActive?.active_generation || null,
    };
    throw error;
  }
}

export function loadActiveLandPlacePointer(publicDir) {
  return readJsonIfExists(path.join(publicDir, LAND_PLACE_ACTIVE_POINTER));
}

export function loadLandPlaceGenerationAssets(publicDir, generationId) {
  const id = clean(generationId);
  if (!id) return null;
  const generationDir = path.join(publicDir, id);
  if (!existsSync(generationDir)) return null;
  const evidenceDir = path.join(generationDir, "land-place-evidence");
  const evidenceShards = {};
  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir)) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -5);
      evidenceShards[key] = readJsonIfExists(path.join(evidenceDir, name));
    }
  }
  return {
    generation_id: id,
    generation_dir: generationDir,
    manifest: readJsonIfExists(path.join(generationDir, "manifest.json")),
    index: readJsonIfExists(path.join(generationDir, "index.json")),
    reverse: readJsonIfExists(path.join(generationDir, "reverse.json")),
    evidence: readJsonIfExists(path.join(generationDir, "evidence.json")),
    evidenceShards,
  };
}

export function loadActiveLandPlaceGeneration(publicDir) {
  const pointer = loadActiveLandPlacePointer(publicDir);
  if (!pointer?.active_generation) return null;
  const assets = loadLandPlaceGenerationAssets(publicDir, pointer.active_generation);
  if (!assets) return null;
  return { pointer, ...assets };
}

/**
 * Pin one generation for a request. Returns that generation's assets, or a
 * retry signal when the pin is no longer retained. Never mixes assets across
 * independently cached generations.
 */
export function loadPinnedLandPlaceGeneration(publicDir, generationId) {
  const requested = clean(generationId);
  if (!requested) {
    return { ok: false, reason: "missing_pin", retry: true, assets: null };
  }
  const assets = loadLandPlaceGenerationAssets(publicDir, requested);
  if (!assets?.index || !assets?.evidence || !assets?.reverse) {
    return { ok: false, reason: "generation_unavailable", retry: true, assets: null };
  }
  const ids = [
    assets.index?.generation?.id,
    assets.evidence?.generation_id,
    assets.reverse?.generation_id,
    assets.manifest?.generation_id,
  ].map(clean).filter(Boolean);
  if (ids.some((id) => id !== requested)) {
    return { ok: false, reason: "mixed_generation_assets", retry: true, assets: null };
  }
  for (const shard of Object.values(assets.evidenceShards || {})) {
    if (shard?.generation_id && clean(shard.generation_id) !== requested) {
      return { ok: false, reason: "mixed_generation_assets", retry: true, assets: null };
    }
  }
  return { ok: true, reason: null, retry: false, assets };
}

/**
 * Build membership + fingerprints from catalog/BBL/parcel sources.
 */
export function buildLandPlaceMembershipFromSources({
  catalog,
  bblIndex = null,
  parcelManifest = null,
  loadParcelShard = null,
  artifactHashes = null,
  addressIndexManifest = null,
  builtAt = null,
} = {}) {
  if (!catalog || catalog.schema !== LAND_PROJECT_CATALOG_SCHEMA) {
    throw new Error("land place refresh requires an admitted land_project_catalog document");
  }

  const inputHashes = computeLandPlaceInputHashes({
    catalog,
    bblIndex,
    parcelManifest,
    loadParcelShard,
    addressIndexManifest,
  });

  // Generation identity follows the invalidation aggregate (catalog rows, BBL
  // associations, parcel shards, boundary vintages). The L02 content_id alone
  // does not move when BBL lists change under a stable materialized_at stamp.
  const built = buildLandPlaceMembership({
    catalog,
    bblIndex,
    loadParcelShard,
    parcelManifest,
    artifactHashes: artifactHashes || {},
    builtAt: builtAt || catalog.source_dates?.warehouse_materialized_at || null,
  });
  const generationId = sha256Text([
    inputHashes.aggregate,
    built.index.generation?.content_id || "",
  ].join("|"));
  built.index = {
    ...built.index,
    generation: {
      ...built.index.generation,
      id: generationId,
      built_at: built.index.generation?.built_at
        || builtAt
        || catalog.source_dates?.warehouse_materialized_at
        || null,
    },
  };
  for (const key of Object.keys(built.evidenceShards || {})) {
    built.evidenceShards[key] = {
      ...built.evidenceShards[key],
      generation_id: generationId,
    };
  }

  return {
    indexDoc: built.index,
    evidenceShards: built.evidenceShards,
    inputHashes,
  };
}

/**
 * Injectable refresh runner used by the CLI and acceptance tests.
 */
export function createLandPlaceRefresh(adapters = {}) {
  const {
    loadSources,
    loadPreviousReceipt = null,
    saveReceipt = null,
    loadActiveGeneration = null,
    activateGeneration = null,
    activeIndexPath = null,
    activeEvidenceDir = null,
  } = adapters;

  if (typeof loadSources !== "function") {
    throw new Error("createLandPlaceRefresh requires loadSources()");
  }
  if (typeof activateGeneration !== "function") {
    throw new Error("createLandPlaceRefresh requires activateGeneration()");
  }

  function run({
    force = false,
    now = new Date().toISOString(),
    previousReceipt = null,
    injectFailure = null,
    injectMixedGeneration = false,
    builtAt = null,
    bootstrapCommitted = true,
  } = {}) {
    const prior = previousReceipt
      || (typeof loadPreviousReceipt === "function" ? loadPreviousReceipt() : null)
      || null;
    const activeBefore = typeof loadActiveGeneration === "function"
      ? loadActiveGeneration()
      : (prior?.active_generation || null);

    let sources;
    try {
      if (injectFailure === "partial_download") {
        throw Object.assign(new Error("partial parcel shard download"), {
          failure_kind: "partial_download",
        });
      }
      sources = loadSources();
      if (injectFailure === "mismatched_boundary") {
        const parcelManifest = {
          ...(sources.parcelManifest || {}),
          membership: {
            ...(sources.parcelManifest?.membership || {}),
            layers: {
              ...(sources.parcelManifest?.membership?.layers || {}),
              nta2020: {
                ...(sources.parcelManifest?.membership?.layers?.nta2020 || {}),
                vintage: "mismatched-boundary-vintage",
              },
            },
          },
        };
        // Keep the staged shards on the prior vintage so the join sees a mismatch.
        sources = { ...sources, parcelManifest };
      }
    } catch (error) {
      const receipt = {
        schema: LAND_PLACE_REFRESH_RECEIPT_SCHEMA,
        status: "failed",
        started_at: now,
        completed_at: now,
        failed_at: now,
        activated_at: prior?.activated_at || null,
        active_generation: activeBefore,
        previous_active_generation: activeBefore,
        source_dates: prior?.source_dates || null,
        failure: {
          kind: error.failure_kind || "source_load_failed",
          message: error.message,
        },
        last_good_preserved: Boolean(activeBefore),
        message: "land place refresh failed while loading sources; retained last-good generation",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: false,
        status: "failed",
        receipt,
        active_generation: activeBefore,
        previous_active_generation: activeBefore,
      };
    }

    const { indexDoc, evidenceShards, inputHashes } = buildLandPlaceMembershipFromSources({
      ...sources,
      builtAt: builtAt
        || sources.catalog?.source_dates?.warehouse_materialized_at
        || indexDocBuiltAt(sources, now),
    });

    // CI / materialization checkouts keep ACTIVE committed but gitignore the
    // receipt. Without a prior receipt, hash planning would rebuild and rewrite
    // ACTIVE under time-travel. Seed the receipt and leave bytes alone when the
    // active generation already matches current inputs.
    const bootstrapped = tryBootstrapCommittedRefresh({
      prior,
      activeBefore,
      force,
      injectFailure,
      injectMixedGeneration,
      bootstrapCommitted,
      activeMatches: clean(indexDoc.generation?.id) === clean(activeBefore),
      saveReceipt,
      receiptSchema: LAND_PLACE_REFRESH_RECEIPT_SCHEMA,
      planSchema: LAND_PLACE_REFRESH_PLAN_SCHEMA,
      now,
      activatedAt: prior?.activated_at || null,
      planFields: {
        rebuild_all: false,
        rebuild_project_ids: Object.freeze([]),
        changed_inputs: Object.freeze([]),
      },
      receiptFields: {
        failed_at: null,
        input_hashes: inputHashes,
        source_dates: indexDoc.source_dates,
        project_count: indexDoc.project_count,
        last_good_preserved: false,
      },
      resultFields: { index: indexDoc, evidenceShards },
    });
    if (bootstrapped) return bootstrapped;

    const forceRun = Boolean(force || injectFailure || injectMixedGeneration);
    const plan = planLandPlaceRefresh({
      previousHashes: prior?.input_hashes || null,
      currentHashes: inputHashes,
      force: forceRun,
      activeGeneration: activeBefore,
    });

    const receiptBase = {
      schema: LAND_PLACE_REFRESH_RECEIPT_SCHEMA,
      started_at: now,
      plan,
      input_hashes: inputHashes,
      source_dates: indexDoc.source_dates,
      project_count: indexDoc.project_count,
      active_generation: activeBefore,
      previous_active_generation: activeBefore,
    };

    if (!plan.work_required) {
      const receipt = {
        ...receiptBase,
        status: "unchanged",
        completed_at: now,
        failed_at: null,
        activated_at: prior?.activated_at || null,
        last_good_preserved: false,
        message: "land place input hashes reused; generation bytes unchanged",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: true,
        status: "unchanged",
        plan,
        receipt,
        active_generation: activeBefore,
        index: indexDoc,
        evidenceShards,
      };
    }

    if (!(indexDoc.project_count > 0)) {
      const receipt = {
        ...receiptBase,
        status: "failed",
        completed_at: now,
        failed_at: now,
        activated_at: prior?.activated_at || null,
        failure: {
          kind: "empty_project_index",
          message: "refusing to publish an empty land place membership index",
        },
        last_good_preserved: Boolean(activeBefore),
        message: "empty project index blocked promotion; retained last-good generation",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: false,
        status: "failed",
        plan,
        receipt,
        active_generation: activeBefore,
      };
    }

    try {
      const activationArgs = {
        indexDoc,
        evidenceShards,
        inputHashes,
        generation: indexDoc.generation.id,
        builtAt: indexDoc.generation.built_at,
        activeIndexPath,
        activeEvidenceDir,
      };
      if (injectFailure === "mismatched_boundary") {
        throw Object.assign(new Error("mismatched boundary vintage refused promotion"), {
          failure_kind: "mismatched_boundary",
          activation: {
            activated: false,
            active_generation: activeBefore,
            previous_generation: activeBefore,
          },
        });
      }
      if (injectFailure === "before_activate") {
        activateGeneration({ ...activationArgs, failBeforeActivate: true });
      } else if (injectFailure === "before_active_pointer") {
        activateGeneration({ ...activationArgs, failAfterImmutablePublish: true });
      } else if (injectFailure === "mixed_generation" || injectMixedGeneration) {
        activateGeneration({ ...activationArgs, injectMixedGeneration: true });
      } else {
        const activation = activateGeneration(activationArgs);
        const receipt = {
          ...receiptBase,
          status: "activated",
          completed_at: now,
          failed_at: null,
          activated_at: now,
          active_generation: activation.generation,
          previous_active_generation: activation.previous_generation,
          last_good_preserved: false,
          // Refresh clock lives only on the receipt; source_dates stay from inputs.
          message: activeBefore
            ? "land place generation rebuilt and activated"
            : "land place generation backfilled and activated",
        };
        if (typeof saveReceipt === "function") saveReceipt(receipt);
        return {
          ok: true,
          status: "activated",
          plan,
          receipt,
          active_generation: activation.generation,
          previous_active_generation: activation.previous_generation,
          index: activation.index || indexDoc,
          evidenceShards: activation.evidenceShards || evidenceShards,
          activation,
        };
      }
      throw new Error("land place refresh injection did not throw");
    } catch (error) {
      const kept = error.activation?.active_generation || activeBefore;
      const receipt = {
        ...receiptBase,
        status: "failed",
        completed_at: now,
        failed_at: now,
        activated_at: prior?.activated_at || null,
        active_generation: kept,
        previous_active_generation: activeBefore,
        // Preserve prior source dates on failure evidence; never overwrite with now.
        source_dates: prior?.source_dates || indexDoc.source_dates,
        failure: {
          kind: error.validation
            ? "consumer_validation_failed"
            : (error.failure_kind || injectFailure || "activation_failed"),
          message: error.message,
          validation_errors: error.validation?.errors || null,
        },
        last_good_preserved: Boolean(kept),
        message: "land place refresh failed; retained last-good generation",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: false,
        status: "failed",
        plan,
        receipt,
        active_generation: kept,
        previous_active_generation: activeBefore,
        error,
      };
    }
  }

  return { run };
}

function indexDocBuiltAt(sources, now) {
  return clean(sources?.catalog?.source_dates?.warehouse_materialized_at)
    || clean(sources?.bblIndex?.materialized_at)
    || clean(now)
    || null;
}

export {
  LAND_PLACE_MEMBERSHIP_PATH,
  LAND_PLACE_EVIDENCE_DIR,
  LAND_PLACE_BBL_INDEX_PATH,
  landPlaceEvidenceShardKey,
};
