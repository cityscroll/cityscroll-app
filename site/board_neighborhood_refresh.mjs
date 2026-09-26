/**
 * Board-neighborhood refresh and coherent generation publication.
 *
 * Builds on the B01 association index: hash crosswalk, ontology, label, and
 * boundary inputs; reuse the index when only board-calendar inputs change;
 * stage immutable generation assets (index + directory + profile consumers);
 * validate all three consumers against one generation; then flip the active
 * pointer. Failed promotion retains the last-good generation and records the
 * failed attempt time separately from source vintages.
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
  BOARD_NEIGHBORHOOD_INDEX_PATH,
  BOARD_NEIGHBORHOOD_INDEX_SCHEMA,
  buildBoardNeighborhoodIndex,
  ntaSubtypeMapFromLayer,
  serializeBoardNeighborhoodIndex,
  stableStringify,
} from "./board_neighborhood_index.mjs";
import { tryBootstrapCommittedRefresh } from "./generation_refresh_bootstrap.mjs";

export const BOARD_NEIGHBORHOOD_REFRESH_SCHEMA = "cityscroll.board_neighborhood_refresh.v1";
export const BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_SCHEMA =
  "cityscroll.board_neighborhood_refresh_receipt.v1";
export const BOARD_NEIGHBORHOOD_REFRESH_PLAN_SCHEMA =
  "cityscroll.board_neighborhood_refresh_plan.v1";
export const BOARD_NEIGHBORHOOD_GENERATION_MANIFEST_SCHEMA =
  "cityscroll.board_neighborhood_generation_manifest.v1";
export const BOARD_NEIGHBORHOOD_CONSUMER_SCHEMA =
  "cityscroll.board_neighborhood_consumer.v1";

export const BOARD_NEIGHBORHOOD_PUBLIC_DIR = "site/data/board-neighborhood-generations";
export const BOARD_NEIGHBORHOOD_ACTIVE_POINTER = "ACTIVE";
export const BOARD_NEIGHBORHOOD_STAGING_DIRNAME = ".staging";
export const BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_NAME = "refresh-receipt.json";

export const BOARD_NEIGHBORHOOD_CONSUMERS = Object.freeze([
  "index",
  "directory",
  "profile",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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

export function boardNeighborhoodRefreshReceiptPath(publicDir) {
  return path.join(publicDir, BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_NAME);
}

export function loadBoardNeighborhoodRefreshReceipt(publicDir) {
  return readJsonIfExists(boardNeighborhoodRefreshReceiptPath(publicDir));
}

export function writeBoardNeighborhoodRefreshReceipt(publicDir, receipt) {
  mkdirSync(publicDir, { recursive: true });
  atomicWriteFile(
    boardNeighborhoodRefreshReceiptPath(publicDir),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return boardNeighborhoodRefreshReceiptPath(publicDir);
}

/**
 * Hash the inputs that invalidate the board↔neighborhood join.
 * Meeting-calendar / scorecard-only bytes are intentionally excluded so those
 * changes reuse the current generation.
 */
export function computeBoardNeighborhoodInputHashes({
  crosswalkBytes = null,
  ontologyBytes = null,
  labelBytes = null,
  boundaryGeneration = null,
} = {}) {
  const crosswalk = crosswalkBytes == null ? null : sha256Bytes(crosswalkBytes);
  const ontology = ontologyBytes == null ? null : sha256Bytes(ontologyBytes);
  const labels = labelBytes == null ? null : sha256Bytes(labelBytes);
  const boundary = boundaryGeneration && typeof boundaryGeneration === "object"
    ? Object.freeze(Object.fromEntries(
      Object.entries(boundaryGeneration)
        .map(([key, value]) => [clean(key), clean(value)])
        .filter(([key, value]) => key && value)
        .sort(([left], [right]) => left.localeCompare(right)),
    ))
    : Object.freeze({});
  return Object.freeze({
    crosswalk,
    ontology,
    labels,
    boundary_generation: boundary,
    aggregate: sha256Text(stableStringify({
      crosswalk,
      ontology,
      labels,
      boundary_generation: boundary,
    })),
  });
}

export function planBoardNeighborhoodRefresh({
  previousHashes = null,
  currentHashes = null,
  force = false,
  activeGeneration = null,
} = {}) {
  const reasons = [];
  if (force) reasons.push("force");
  if (!activeGeneration) reasons.push("missing_active_generation");
  if (!previousHashes) reasons.push("missing_previous_hashes");
  if (!currentHashes?.aggregate) reasons.push("missing_current_hashes");

  const changed = [];
  if (previousHashes && currentHashes) {
    for (const key of ["crosswalk", "ontology", "labels"]) {
      if (previousHashes[key] !== currentHashes[key]) changed.push(key);
    }
    const priorBoundary = stableStringify(previousHashes.boundary_generation || {});
    const nextBoundary = stableStringify(currentHashes.boundary_generation || {});
    if (priorBoundary !== nextBoundary) changed.push("boundary_generation");
  }
  if (changed.length) reasons.push(`changed:${changed.join(",")}`);

  const workRequired = force
    || !activeGeneration
    || !previousHashes
    || !currentHashes
    || previousHashes.aggregate !== currentHashes.aggregate
    || changed.length > 0;

  if (!workRequired) reasons.push("inputs_unchanged");

  return Object.freeze({
    schema: BOARD_NEIGHBORHOOD_REFRESH_PLAN_SCHEMA,
    work_required: workRequired,
    reasons: Object.freeze([...reasons]),
    changed_inputs: Object.freeze([...changed]),
  });
}

/**
 * Build the three public consumers that must agree on one generation before
 * promotion: the association index, directory forward projection, and profile
 * reverse projection.
 */
export function buildBoardNeighborhoodConsumers(indexDoc) {
  if (!indexDoc || indexDoc.schema !== BOARD_NEIGHBORHOOD_INDEX_SCHEMA) {
    throw new Error("board neighborhood consumers require a board neighborhood index document");
  }
  const generationId = clean(indexDoc.generation?.id);
  if (!generationId) throw new Error("board neighborhood index is missing generation.id");

  const indexConsumer = Object.freeze({
    schema: BOARD_NEIGHBORHOOD_CONSUMER_SCHEMA,
    consumer: "index",
    generation_id: generationId,
    inventory: indexDoc.inventory,
    content_sha256: clean(indexDoc.generation?.content_sha256) || generationId,
  });

  const directoryPayload = Object.freeze({
    by_nta: indexDoc.by_nta,
    non_board_overlaps: indexDoc.non_board_overlaps,
  });
  const directoryConsumer = Object.freeze({
    schema: BOARD_NEIGHBORHOOD_CONSUMER_SCHEMA,
    consumer: "directory",
    generation_id: generationId,
    inventory: Object.freeze({
      nta_count: Object.keys(indexDoc.by_nta || {}).length,
      board_associated_row_count: indexDoc.inventory?.board_associated_row_count ?? null,
      non_board_row_count: indexDoc.inventory?.non_board_row_count ?? null,
    }),
    by_nta: indexDoc.by_nta,
    non_board_overlaps: indexDoc.non_board_overlaps,
    content_sha256: sha256Text(stableStringify(directoryPayload)),
  });

  const profilePayload = Object.freeze({
    by_board: indexDoc.by_board,
  });
  const profileConsumer = Object.freeze({
    schema: BOARD_NEIGHBORHOOD_CONSUMER_SCHEMA,
    consumer: "profile",
    generation_id: generationId,
    inventory: Object.freeze({
      board_identity_count: indexDoc.inventory?.board_identity_count ?? null,
      board_associated_row_count: indexDoc.inventory?.board_associated_row_count ?? null,
    }),
    by_board: indexDoc.by_board,
    content_sha256: sha256Text(stableStringify(profilePayload)),
  });

  return Object.freeze({
    index: indexConsumer,
    directory: directoryConsumer,
    profile: profileConsumer,
    generation_id: generationId,
  });
}

export function serializeBoardNeighborhoodConsumer(consumer) {
  return `${JSON.stringify(consumer, null, 2)}\n`;
}

/**
 * Refuse promotion unless every public consumer pins the same generation and
 * the association table is non-empty when geography publication is allowed.
 */
export function validateBoardNeighborhoodConsumers(consumers, generationId, {
  requireNonEmptyAssociations = true,
} = {}) {
  const errors = [];
  const expected = clean(generationId);
  if (!expected) errors.push("missing_generation_id");
  for (const name of BOARD_NEIGHBORHOOD_CONSUMERS) {
    const consumer = consumers?.[name];
    if (!consumer) {
      errors.push(`missing_consumer:${name}`);
      continue;
    }
    if (consumer.schema !== BOARD_NEIGHBORHOOD_CONSUMER_SCHEMA) {
      errors.push(`invalid_consumer_schema:${name}`);
    }
    if (clean(consumer.generation_id) !== expected) {
      errors.push(`generation_mismatch:${name}`);
    }
    if (!clean(consumer.content_sha256)) {
      errors.push(`missing_content_hash:${name}`);
    }
  }
  const boardRows = Number(consumers?.index?.inventory?.board_associated_row_count);
  if (requireNonEmptyAssociations && !(boardRows > 0)) {
    errors.push("empty_association_table");
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
    .filter((name) => name !== BOARD_NEIGHBORHOOD_STAGING_DIRNAME && !name.startsWith("."));
}

/**
 * Publish immutable generation assets, then switch the active reference.
 * Retains the immediately preceding complete generation for in-flight readers.
 */
export function activateBoardNeighborhoodGeneration({
  publicDir,
  generation,
  indexDoc,
  consumers = null,
  inputHashes = null,
  builtAt = null,
  failBeforeActivate = false,
  failAfterImmutablePublish = false,
  injectMixedGeneration = false,
  activeIndexPath = null,
} = {}) {
  if (!publicDir) throw new Error("activateBoardNeighborhoodGeneration requires publicDir");
  const generationId = clean(generation || indexDoc?.generation?.id);
  if (!generationId) throw new Error("activateBoardNeighborhoodGeneration requires generation");
  if (!indexDoc) throw new Error("activateBoardNeighborhoodGeneration requires indexDoc");

  const baseConsumers = consumers || buildBoardNeighborhoodConsumers(indexDoc);
  const builtConsumers = injectMixedGeneration
    ? Object.freeze({
      ...baseConsumers,
      // Adversarial fixture: profile consumer disagrees with the staged generation.
      profile: Object.freeze({
        ...baseConsumers.profile,
        generation_id: `mixed-${generationId}`,
      }),
    })
    : baseConsumers;

  const validation = validateBoardNeighborhoodConsumers(builtConsumers, generationId, {
    // Never promote a successful empty association table, including unpublished
    // or invalid ontology inputs that cleared every covers edge.
    requireNonEmptyAssociations: true,
  });
  if (!validation.ok) {
    const error = new Error(
      `board neighborhood generation validation failed: ${validation.errors.join(",")}`,
    );
    error.validation = validation;
    error.activation = {
      activated: false,
      active_generation: loadActiveBoardNeighborhoodPointer(publicDir)?.active_generation || null,
      previous_generation: loadActiveBoardNeighborhoodPointer(publicDir)?.previous_generation || null,
    };
    throw error;
  }

  mkdirSync(publicDir, { recursive: true });
  const stagingDir = path.join(publicDir, BOARD_NEIGHBORHOOD_STAGING_DIRNAME);
  const generationDir = path.join(publicDir, generationId);
  const previousActive = loadActiveBoardNeighborhoodPointer(publicDir);

  try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    const manifest = {
      schema: BOARD_NEIGHBORHOOD_GENERATION_MANIFEST_SCHEMA,
      generation_id: generationId,
      built_at: clean(builtAt || indexDoc.generation?.built_at) || null,
      input_hashes: inputHashes || indexDoc.source_hashes || null,
      vintages: indexDoc.vintages || null,
      inventory: indexDoc.inventory || null,
      consumers: Object.fromEntries(
        BOARD_NEIGHBORHOOD_CONSUMERS.map((name) => [name, {
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
      serializeBoardNeighborhoodIndex(indexDoc),
    );
    atomicWriteFile(
      path.join(stagingDir, "directory.json"),
      serializeBoardNeighborhoodConsumer(builtConsumers.directory),
    );
    atomicWriteFile(
      path.join(stagingDir, "profile.json"),
      serializeBoardNeighborhoodConsumer(builtConsumers.profile),
    );

    if (failBeforeActivate) {
      throw new Error("board neighborhood refresh forced failure before activation");
    }

    // Immutable assets land under the generation id before the active pointer moves.
    rmSync(generationDir, { recursive: true, force: true });
    renameSync(stagingDir, generationDir);

    // Injection point between the immutable move and the active-pointer write.
    // Callers that observe here can pin the new generation while ACTIVE still
    // names the previous one.
    if (failAfterImmutablePublish) {
      const error = new Error(
        "board neighborhood refresh forced failure after immutable publish before active pointer",
      );
      error.published_generation = generationId;
      throw error;
    }

    const pointer = {
      schema: BOARD_NEIGHBORHOOD_GENERATION_MANIFEST_SCHEMA,
      active_generation: generationId,
      activated_at: manifest.built_at,
      previous_generation: previousActive?.active_generation || null,
    };
    if (!pointer.activated_at) {
      throw new Error("activateBoardNeighborhoodGeneration requires built_at");
    }
    atomicWriteFile(
      path.join(publicDir, BOARD_NEIGHBORHOOD_ACTIVE_POINTER),
      `${JSON.stringify(pointer, null, 2)}\n`,
    );

    // Convenience active copies for readers that do not pin a generation id.
    atomicWriteFile(
      path.join(publicDir, "manifest.json"),
      `${JSON.stringify({ ...manifest, active_generation: generationId }, null, 2)}\n`,
    );
    if (activeIndexPath) {
      atomicWriteFile(activeIndexPath, serializeBoardNeighborhoodIndex(indexDoc));
    }

    // Retain only the immediately preceding complete generation.
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
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    const stillActive = loadActiveBoardNeighborhoodPointer(publicDir);
    error.activation = {
      activated: false,
      active_generation: stillActive?.active_generation || previousActive?.active_generation || null,
      previous_generation: previousActive?.active_generation || null,
    };
    throw error;
  }
}

export function loadActiveBoardNeighborhoodPointer(publicDir) {
  return readJsonIfExists(path.join(publicDir, BOARD_NEIGHBORHOOD_ACTIVE_POINTER));
}

export function loadBoardNeighborhoodGenerationAssets(publicDir, generationId) {
  const id = clean(generationId);
  if (!id) return null;
  const generationDir = path.join(publicDir, id);
  if (!existsSync(generationDir)) return null;
  return {
    generation_id: id,
    generation_dir: generationDir,
    manifest: readJsonIfExists(path.join(generationDir, "manifest.json")),
    index: readJsonIfExists(path.join(generationDir, "index.json")),
    directory: readJsonIfExists(path.join(generationDir, "directory.json")),
    profile: readJsonIfExists(path.join(generationDir, "profile.json")),
  };
}

export function loadActiveBoardNeighborhoodGeneration(publicDir) {
  const pointer = loadActiveBoardNeighborhoodPointer(publicDir);
  if (!pointer?.active_generation) return null;
  const assets = loadBoardNeighborhoodGenerationAssets(publicDir, pointer.active_generation);
  if (!assets) return null;
  return { pointer, ...assets };
}

/**
 * Pin one generation for a request. Returns that generation's assets, or a
 * retry signal when the pin is no longer retained. Never mixes assets across
 * independently cached generations.
 */
export function loadPinnedBoardNeighborhoodGeneration(publicDir, generationId) {
  const requested = clean(generationId);
  if (!requested) {
    return { ok: false, reason: "missing_pin", retry: true, assets: null };
  }
  const assets = loadBoardNeighborhoodGenerationAssets(publicDir, requested);
  if (!assets?.index || !assets?.directory || !assets?.profile) {
    return { ok: false, reason: "generation_unavailable", retry: true, assets: null };
  }
  const ids = [
    assets.index?.generation?.id,
    assets.directory?.generation_id,
    assets.profile?.generation_id,
    assets.manifest?.generation_id,
  ].map(clean);
  if (ids.some((id) => id && id !== requested)) {
    return { ok: false, reason: "mixed_generation_assets", retry: true, assets: null };
  }
  return { ok: true, reason: null, retry: false, assets };
}

/**
 * Build an index document from source JSON objects + raw bytes for hashing.
 */
export function buildBoardNeighborhoodIndexFromSources({
  crosswalk,
  geography,
  ntaLayer,
  crosswalkBytes,
  ontologyBytes,
  labelBytes,
  builtAt = null,
} = {}) {
  if (!crosswalk) throw new Error("missing crosswalk");
  if (!geography) throw new Error("missing ontology geography");
  if (!ntaLayer) throw new Error("missing nta label layer");

  const inputHashes = computeBoardNeighborhoodInputHashes({
    crosswalkBytes,
    ontologyBytes,
    labelBytes,
    boundaryGeneration: {
      nta2020: clean(crosswalk?.source_vintages?.from) || clean(ntaLayer?.vintage) || null,
      community_district: clean(crosswalk?.source_vintages?.to)
        || clean(geography?.boundary_vintage)
        || null,
      board_geography_boundary: clean(geography?.boundary_vintage) || null,
    },
  });

  // Source hashes recorded on the committed index keep the B01 relative paths.
  const sourceHashes = {
    "geography/crosswalks/nta2020__community_district/26B__2026-05-26.json": inputHashes.crosswalk,
    "community_board_geography_lookup.json": inputHashes.ontology,
    "geography/layers/nta2020/26B.json": inputHashes.labels,
  };

  const indexDoc = buildBoardNeighborhoodIndex({
    crosswalk,
    geography,
    ntaSubtypeById: ntaSubtypeMapFromLayer(ntaLayer),
    sourceHashes,
    builtAt: builtAt || clean(geography?.generated_at) || null,
  });

  return { indexDoc, inputHashes, sourceHashes };
}

/**
 * Injectable refresh runner used by the CLI and acceptance tests.
 */
export function createBoardNeighborhoodRefresh(adapters = {}) {
  const {
    loadSources,
    loadPreviousReceipt = null,
    saveReceipt = null,
    loadActiveGeneration = null,
    activateGeneration = null,
    activeIndexPath = null,
  } = adapters;

  if (typeof loadSources !== "function") {
    throw new Error("createBoardNeighborhoodRefresh requires loadSources()");
  }
  if (typeof activateGeneration !== "function") {
    throw new Error("createBoardNeighborhoodRefresh requires activateGeneration()");
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
      if (injectFailure === "missing_crosswalk") {
        throw Object.assign(new Error("missing crosswalk input"), {
          failure_kind: "missing_crosswalk",
        });
      }
      sources = loadSources();
      if (injectFailure === "invalid_ontology") {
        const geography = {
          ...(sources.geography || {}),
          gate: { ...(sources.geography?.gate || {}), publication_allowed: false },
          public_edges: [],
        };
        sources = { ...sources, geography, ontologyBytes: Buffer.from(JSON.stringify(geography)) };
      }
    } catch (error) {
      const receipt = {
        schema: BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_SCHEMA,
        status: "failed",
        started_at: now,
        completed_at: now,
        failed_at: now,
        activated_at: prior?.activated_at || null,
        active_generation: activeBefore,
        previous_active_generation: activeBefore,
        vintages: prior?.vintages || null,
        failure: {
          kind: error.failure_kind || "source_load_failed",
          message: error.message,
        },
        last_good_preserved: Boolean(activeBefore),
        message: "board neighborhood refresh failed while loading sources; retained last-good generation",
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

    const { indexDoc, inputHashes } = buildBoardNeighborhoodIndexFromSources({
      ...sources,
      builtAt: builtAt || indexBuiltAt(sources, now),
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
      receiptSchema: BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_SCHEMA,
      planSchema: BOARD_NEIGHBORHOOD_REFRESH_PLAN_SCHEMA,
      now,
      activatedAt: prior?.activated_at || null,
      planFields: { changed_inputs: Object.freeze([]) },
      receiptFields: {
        failed_at: null,
        input_hashes: inputHashes,
        vintages: indexDoc.vintages,
        inventory: indexDoc.inventory,
        last_good_preserved: false,
      },
      resultFields: { index: indexDoc },
    });
    if (bootstrapped) return bootstrapped;

    // Failure injections must reach the activation boundary even when input
    // hashes match; otherwise rehearsals short-circuit as unchanged.
    const forceRun = Boolean(force || injectFailure || injectMixedGeneration);
    const plan = planBoardNeighborhoodRefresh({
      previousHashes: prior?.input_hashes || null,
      currentHashes: inputHashes,
      force: forceRun,
      activeGeneration: activeBefore,
    });

    const receiptBase = {
      schema: BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_SCHEMA,
      started_at: now,
      plan,
      input_hashes: inputHashes,
      vintages: indexDoc.vintages,
      inventory: indexDoc.inventory,
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
        message: "board neighborhood input hashes reused; generation bytes unchanged",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: true,
        status: "unchanged",
        plan,
        receipt,
        active_generation: activeBefore,
        index: indexDoc,
      };
    }

    // Refuse to publish a successful empty association table (invalid ontology,
    // cleared covers edges, or unpublished geography that yields no boards).
    if (!(indexDoc.inventory?.board_associated_row_count > 0)) {
      const receipt = {
        ...receiptBase,
        status: "failed",
        completed_at: now,
        failed_at: now,
        activated_at: prior?.activated_at || null,
        failure: {
          kind: "empty_association_table",
          message: "refusing to publish an empty board association table",
        },
        last_good_preserved: Boolean(activeBefore),
        message: "empty association table blocked promotion; retained last-good generation",
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
      if (injectFailure === "before_activate") {
        activateGeneration({
          indexDoc,
          inputHashes,
          generation: indexDoc.generation.id,
          builtAt: indexDoc.generation.built_at,
          failBeforeActivate: true,
          injectMixedGeneration,
          activeIndexPath,
        });
      } else if (injectFailure === "before_active_pointer") {
        activateGeneration({
          indexDoc,
          inputHashes,
          generation: indexDoc.generation.id,
          builtAt: indexDoc.generation.built_at,
          failAfterImmutablePublish: true,
          injectMixedGeneration,
          activeIndexPath,
        });
      } else if (injectFailure === "mixed_generation" || injectMixedGeneration) {
        activateGeneration({
          indexDoc,
          inputHashes,
          generation: indexDoc.generation.id,
          builtAt: indexDoc.generation.built_at,
          injectMixedGeneration: true,
          activeIndexPath,
        });
      } else {
        const activation = activateGeneration({
          indexDoc,
          inputHashes,
          generation: indexDoc.generation.id,
          builtAt: indexDoc.generation.built_at,
          activeIndexPath,
        });
        const receipt = {
          ...receiptBase,
          status: "activated",
          completed_at: now,
          failed_at: null,
          activated_at: now,
          active_generation: activation.generation,
          previous_active_generation: activation.previous_generation,
          last_good_preserved: false,
          message: activeBefore
            ? "board neighborhood generation rebuilt and activated"
            : "board neighborhood generation backfilled and activated",
        };
        if (typeof saveReceipt === "function") saveReceipt(receipt);
        return {
          ok: true,
          status: "activated",
          plan,
          receipt,
          active_generation: activation.generation,
          previous_active_generation: activation.previous_generation,
          index: indexDoc,
          activation,
        };
      }
      // inject paths throw
      throw new Error("board neighborhood refresh injection did not throw");
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
        failure: {
          kind: error.validation ? "consumer_validation_failed" : (injectFailure || "activation_failed"),
          message: error.message,
          validation_errors: error.validation?.errors || null,
        },
        last_good_preserved: Boolean(kept),
        message: "board neighborhood refresh failed; retained last-good generation",
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

function indexBuiltAt(sources, now) {
  return clean(sources?.geography?.generated_at) || clean(now) || null;
}

export {
  BOARD_NEIGHBORHOOD_INDEX_PATH,
  serializeBoardNeighborhoodIndex,
};
