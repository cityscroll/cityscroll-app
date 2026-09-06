/**
 * Publish a validated retained matter generation before releasing its updates.
 *
 * Artifacts are written first; the current-generation pointer is promoted last.
 * An interrupted or incomplete publication leaves the previous complete
 * generation in place. Page requests and update eligibility read this store
 * and never contact a publisher.
 */

import { computeSourceRecordHash } from "./source_records.mjs";
import { verifyRetentionConfiguration } from "./matter_exact_refresh.mjs";
import { defaultMatterHistoriesSourceGate } from "./matter_histories_source_gate.mjs";
import {
  MATTER_COVERAGE_STATE,
  MATTER_PUBLICATION_CURRENT_KEY,
  MATTER_PUBLICATION_GENERATION_SCHEMA,
  buildMatterPublicationManifest,
  decideUpdateRelease,
  matterPublicationArtifactKey,
  resolvePublishedMatterLookup,
  stampMatterLookup,
  validateMatterGeneration,
} from "../../../site/matter_publication_generation.mjs";
import { matterWatchDeliveryEnabled } from "../../../site/council_matter_watch.mjs";

export { resolvePublishedMatterLookup };

function publicationKv(env) {
  return env?.MATTER_PUBLICATION || env?.ALERT_STATE || null;
}

async function kvGet(kv, key) {
  if (!kv?.get) return null;
  const value = await kv.get(key);
  if (value == null) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

async function kvPut(kv, key, value) {
  if (!kv?.put) throw new Error("matter publication store is unavailable");
  await kv.put(key, typeof value === "string" ? value : JSON.stringify(value));
}

export async function readCurrentMatterManifest(env) {
  const kv = publicationKv(env);
  if (!kv) return null;
  const current = await kvGet(kv, MATTER_PUBLICATION_CURRENT_KEY);
  if (!current?.generation_id) return null;
  return current;
}

export async function readPublishedMatterLookup(env, options = {}) {
  return resolvePublishedMatterLookup(env, options);
}

export async function publishMatterGeneration(env, input = {}) {
  const kv = publicationKv(env);
  const previous = await readCurrentMatterManifest(env);
  const sequence = Number.isInteger(Number(input.sequence))
    ? Number(input.sequence)
    : (Number(previous?.sequence) || 0) + 1;
  const publishedAt = input.published_at || new Date().toISOString();
  const sourceVintage = input.source_vintage || input.lookup?.generated_at || publishedAt;
  const generationId = input.generation_id || await computeSourceRecordHash({
    sequence,
    published_at: publishedAt,
    source_vintage: sourceVintage,
    matter_ids: Object.keys(input.lookup?.matters || {}).sort(),
  });
  const coverageState = input.coverage_state || MATTER_COVERAGE_STATE.CURRENT;
  const validation = validateMatterGeneration({
    lookup: input.lookup,
    index: input.index,
    generation_id: generationId,
    sequence,
    published_at: publishedAt,
  });
  if (!validation.ok) {
    return {
      promoted: false,
      held: true,
      reason: "invalid-generation",
      errors: validation.errors,
      current: previous,
    };
  }
  if (input.omitArtifact) {
    return {
      promoted: false,
      held: true,
      reason: "missing-artifact",
      omitted: input.omitArtifact,
      current: previous,
    };
  }
  if (!kv) {
    return {
      promoted: false,
      held: true,
      reason: "publication-store-unavailable",
      current: previous,
    };
  }

  const generation = {
    schema: MATTER_PUBLICATION_GENERATION_SCHEMA,
    generation_id: generationId,
    sequence,
    published_at: publishedAt,
    coverage_state: coverageState,
    source_vintage: sourceVintage,
  };
  const stampedLookup = stampMatterLookup(input.lookup, generation);
  const manifest = buildMatterPublicationManifest(generation, validation);

  await kvPut(kv, matterPublicationArtifactKey(generationId, "lookup.json"), stampedLookup);
  await kvPut(kv, matterPublicationArtifactKey(generationId, "index.json"), input.index);
  if (input.interruptBeforeManifest) {
    return {
      promoted: false,
      held: true,
      reason: "interrupted-before-manifest",
      generation_id: generationId,
      current: previous,
    };
  }
  await kvPut(kv, matterPublicationArtifactKey(generationId, "manifest.json"), manifest);
  await kvPut(kv, MATTER_PUBLICATION_CURRENT_KEY, manifest);
  return {
    promoted: true,
    held: false,
    reason: null,
    generation_id: generationId,
    sequence,
    published_at: publishedAt,
    current: manifest,
    previous,
  };
}

export function holdUpdatesUntilPublished(updates, pageGeneration) {
  const rows = Array.isArray(updates) ? updates : [];
  const released = [];
  const held = [];
  for (const update of rows) {
    const decision = decideUpdateRelease(update, pageGeneration);
    if (decision.release) released.push(update);
    else held.push({ ...update, hold_reason: decision.reason });
  }
  return { released, held };
}

export async function matterWatchActivationReadiness(env) {
  const deliveryReady = matterWatchDeliveryEnabled(env);
  const retention = await verifyRetentionConfiguration(env);
  const sourceGate = defaultMatterHistoriesSourceGate();
  const collectorReady = Boolean(retention?.ok);
  return {
    collector_ready: collectorReady,
    delivery_ready: deliveryReady,
    source_gate_passed: Boolean(sourceGate.passed),
    source_gate_adapter: sourceGate.adapter,
    retention_reason: retention?.reason || null,
    ready: collectorReady && deliveryReady,
    reason: !collectorReady
      ? (retention?.reason || "collector-not-ready")
      : (!deliveryReady ? "delivery-not-ready" : null),
  };
}
