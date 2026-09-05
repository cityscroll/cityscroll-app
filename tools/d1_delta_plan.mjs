#!/usr/bin/env node
/**
 * Partition-level delta plans for the D1 read models (Release-control d1-03).
 *
 * Today the read-model SQL begins with table-wide deletes and reinserts every row.
 * This module makes the change set explicit instead: it reduces each published model
 * to keyed records grouped by the manifest's partition, fingerprints every record, and
 * compares a prior snapshot against the current one to produce insert, update, delete,
 * and unchanged sets per partition. Unchanged partitions carry zero operations.
 *
 * Contract (fail closed):
 *   - no prior snapshot, or a prior built from a different manifest fingerprint, is not
 *     an implicit full rebuild: `plan` refuses unless `--rebuild <reason>` names one;
 *   - a partition whose watermark is missing, unparsable, or older than the prior
 *     snapshot's refuses the plan naming the model and partition;
 *   - a rebuild is a separate operation ("rebuild") with its reason recorded in the plan.
 *
 * Record derivations here must stay aligned with the SQL builder and the manifest's
 * key columns, including ordinal-derived keyword_search document ids and OCP row keys.
 * A manifest change requires an explicit rebuild; it does not update these derivations.
 * This tool emits plans only; it does not execute SQL or change publication behavior.
 *
 * Usage:
 *   node tools/d1_delta_plan.mjs snapshot [--out <path>]
 *   node tools/d1_delta_plan.mjs plan --prior <snapshot> [--current <snapshot>]
 *                                     [--rebuild <reason>] [--out <path>]
 *   node tools/d1_delta_plan.mjs plan --rebuild <reason> [--current <snapshot>]
 *                                     [--out <path>]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { entityIntelligenceSummary, graphLinkRows } from "./d1_graph_link_rows.mjs";
import { loadManifest, manifestFingerprint, modelEntry, sourceSnapshotVersion } from "./d1_manifest.mjs";
import {
  readKeywordSearchIndexShard,
  readKeywordSearchIndexShardManifest,
} from "../site/keyword_search_index_shards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_SCHEMA = "cityscroll.d1-partition-snapshot.v1";
export const PLAN_SCHEMA = "cityscroll.d1-delta-plan.v1";
export const WHOLE_MODEL_PARTITION = "__model__";
export const DEFAULT_SNAPSHOT_PATH = join(ROOT, "worker", ".d1-read-models", "partition-snapshot.json");

export class DeltaPlanError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "DeltaPlanError";
    this.code = code;
    this.context = context;
  }
}

function fail(code, message, context) {
  throw new DeltaPlanError(code, message, context);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function fingerprintRecord(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 32);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ocpRowKey(row, ordinal) {
  return [row?.request_id, row?.pin, row?.start_date, ordinal]
    .map((value) => String(value ?? "").trim()).join("|");
}

/** Keyed records per partition for one model, mirroring the builder's row derivations. */
export function partitionRecords(entry, sourceDocument) {
  const partitions = new Map();
  const add = (partition, watermark, table, keyParts, record) => {
    if (!partitions.has(partition)) partitions.set(partition, { watermark, rows: new Map() });
    const bucket = partitions.get(partition);
    const key = `${table}|${keyParts.map((part) => String(part ?? "")).join("|")}`;
    if (bucket.rows.has(key)) {
      fail("duplicate_key", `models[${entry.model_id}] partition ${partition} has duplicate key ${key}`,
        { model_id: entry.model_id, partition, key });
    }
    bucket.rows.set(key, fingerprintRecord(record));
  };

  switch (entry.model_id) {
    case "keyword_search": {
      const families = sourceDocument?.families;
      if (!families || typeof families !== "object" || Array.isArray(families)) {
        fail("source_shape", "keyword_search source document needs a families object", { model_id: entry.model_id });
      }
      for (const familyId of Object.keys(families).sort()) {
        const family = families[familyId] || {};
        add(familyId, family.as_of, "keyword_search_families", [familyId], {
          family_id: familyId, source: family.source ?? null, as_of: family.as_of ?? null,
          source_row_count: Number(family.source_row_count) || 0,
          indexed_count: Number(family.indexed_count) || 0, coverage: family.coverage || [],
        });
        for (const [ordinal, document] of (family.documents || []).entries()) {
          const documentId = `${familyId}:${ordinal}`;
          const searchText = [document.title, document.summary, document.search_text].filter(Boolean).join(" ");
          add(familyId, family.as_of, "keyword_search_documents", [documentId], {
            document_id: documentId, family_id: familyId, ordinal, object_ref: document.object_ref ?? null,
            source_observation_refs: Array.isArray(document.source_observation_refs) ? document.source_observation_refs : [],
            document, search_text: searchText,
          });
          add(familyId, family.as_of, "keyword_search_fts", [documentId], {
            document_id: documentId, family_id: familyId, search_text: searchText,
          });
        }
      }
      break;
    }
    case "ocp_awards": {
      const watermark = sourceDocument?.materialized_at;
      const rows = sourceDocument?.rows || [];
      partitions.set(WHOLE_MODEL_PARTITION, { watermark, rows: new Map() });
      for (const [ordinal, row] of rows.entries()) {
        add(WHOLE_MODEL_PARTITION, watermark, "ocp_awards_warehouse", [ocpRowKey(row, ordinal)], {
          request_id: row.request_id ?? null, start_date: row.start_date ?? null,
          agency_name: row.agency_name ?? null, type_of_notice_description: row.type_of_notice_description ?? null,
          short_title: row.short_title ?? null, pin: row.pin == null ? null : String(row.pin).trim(),
          contract_amount: row.contract_amount ?? null, vendor_name: row.vendor_name ?? null,
        });
      }
      break;
    }
    case "entity_intelligence": {
      const doc = sourceDocument || {};
      const watermark = doc.generated_at;
      add(WHOLE_MODEL_PARTITION, watermark, "entity_intelligence_meta", ["current"], {
        generated_at: doc.generated_at ?? null, observation_count: Number(doc.observation_count) || 0,
        entity_count: Number(doc.entity_count) || 0, multi_domain_count: Number(doc.multi_domain_count) || 0,
        summary: entityIntelligenceSummary(doc),
      });
      for (const entityRef of Object.keys(doc.by_ref || {}).sort()) {
        add(WHOLE_MODEL_PARTITION, watermark, "entity_intelligence_entities", [entityRef], doc.by_ref[entityRef]);
      }
      for (const subjectRef of Object.keys(doc.by_subject_ref || {}).sort()) {
        for (const link of doc.by_subject_ref[subjectRef] || []) {
          const entityRef = String(link?.entity_ref || "").trim();
          const relation = String(link?.relation || "").trim();
          const confidence = String(link?.confidence || "").trim();
          if (!entityRef || !relation) continue;
          add(WHOLE_MODEL_PARTITION, watermark, "entity_intelligence_subject_refs",
            [subjectRef, entityRef, relation, confidence], link);
        }
      }
      for (const row of graphLinkRows(doc)) {
        add(WHOLE_MODEL_PARTITION, watermark, "entity_intelligence_graph_links",
          [row.to_ref, row.from_ref, row.link_type], row.payload);
      }
      break;
    }
    default:
      fail("unknown_model", `no record derivation for model ${entry.model_id}`, { model_id: entry.model_id });
  }
  return partitions;
}

/** Load the live source document for one manifest entry. */
export function loadSourceDocument(entry, root = ROOT) {
  const path = join(root, entry.source.path);
  if (entry.source.kind === "keyword_search_index_shards") {
    const { dir, manifest: shardManifest } = readKeywordSearchIndexShardManifest(path);
    const families = {};
    for (const descriptor of shardManifest?.shards || []) {
      families[descriptor.family] = readKeywordSearchIndexShard(dir, descriptor);
    }
    return { families };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Reduce every manifest model to a serialisable partition snapshot. */
export function snapshotFor(manifest, sourceDocuments) {
  const models = {};
  for (const entry of [...manifest.models].sort((a, b) => compareText(a.model_id, b.model_id))) {
    const source = sourceDocuments[entry.model_id];
    if (source === undefined) fail("missing_source", `no source document for ${entry.model_id}`, { model_id: entry.model_id });
    const partitions = {};
    for (const [partition, bucket] of [...partitionRecords(entry, source)].sort(([a], [b]) => compareText(a, b))) {
      partitions[partition] = {
        watermark: bucket.watermark ?? null,
        rows: Object.fromEntries([...bucket.rows].sort(([a], [b]) => compareText(a, b))),
      };
    }
    models[entry.model_id] = {
      model_version: entry.model_version,
      partition: entry.partition,
      source_snapshot_version: sourceSnapshotVersion(entry, source),
      partitions,
    };
  }
  return { schema: SNAPSHOT_SCHEMA, manifest_fingerprint: manifestFingerprint(manifest), models };
}

/**
 * Watermark tokens are the manifest's source snapshot field values as published. Some
 * sources emit a single ISO timestamp; the keyword search corpora emit a `|`-joined
 * token mixing counts and timestamps. Ordering therefore uses the timestamp components
 * only: a token must carry at least one parsable timestamp, and a partition regresses
 * when any timestamp component moves earlier or a timestamp component disappears.
 */
export function watermarkInstants(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const instants = value.split("|").map((part) => part.trim())
    .filter((part) => /^\d{4}-\d{2}-\d{2}/.test(part))
    .map((part) => Date.parse(part)).filter((ms) => !Number.isNaN(ms));
  return instants.length === 0 ? null : instants;
}

function requireWatermark(modelId, partition, value, role) {
  const instants = watermarkInstants(value);
  if (!instants) {
    fail("watermark_missing", `models[${modelId}] partition ${partition} ${role} watermark is missing or carries no timestamp`,
      { model_id: modelId, partition, role, value: value ?? null });
  }
  return instants;
}

export function watermarkRegressed(priorInstants, currentInstants) {
  if (currentInstants.length < priorInstants.length) return true;
  return priorInstants.some((before, index) => currentInstants[index] < before);
}

function diffRows(priorRows, currentRows) {
  const ops = { insert: [], update: [], delete: [] };
  let unchanged = 0;
  const keys = new Set([...Object.keys(priorRows), ...Object.keys(currentRows)]);
  for (const key of [...keys].sort(compareText)) {
    const [table, ...rest] = key.split("|");
    const ref = { table, key: rest.join("|") };
    const before = priorRows[key];
    const after = currentRows[key];
    if (before === undefined) ops.insert.push(ref);
    else if (after === undefined) ops.delete.push(ref);
    else if (before !== after) ops.update.push(ref);
    else unchanged += 1;
  }
  return { ops, unchanged };
}

function counts(ops, unchanged) {
  return {
    insert: ops.insert.length, update: ops.update.length, delete: ops.delete.length,
    unchanged, total_ops: ops.insert.length + ops.update.length + ops.delete.length,
  };
}

/**
 * Compare a prior snapshot with the current one. Returns the plan or throws a
 * DeltaPlanError; never returns a partial plan.
 */
export function planDelta({ prior, current, rebuild = null }) {
  if (!current || current.schema !== SNAPSHOT_SCHEMA) fail("current_snapshot", "current snapshot is missing or has the wrong schema");
  const reason = rebuild == null ? null : String(rebuild).trim();
  if (rebuild != null && !reason) fail("rebuild_reason", "a rebuild needs a non-empty reason");

  for (const modelId of new Set([...Object.keys(prior?.models || {}), ...Object.keys(current.models)])) {
    const beforePartitions = prior?.models?.[modelId]?.partitions || {};
    const afterPartitions = current.models[modelId]?.partitions || {};
    for (const partition of new Set([...Object.keys(beforePartitions), ...Object.keys(afterPartitions)])) {
      const before = beforePartitions[partition];
      const after = afterPartitions[partition];
      const priorAt = before ? requireWatermark(modelId, partition, before.watermark, "prior") : null;
      const currentAt = after ? requireWatermark(modelId, partition, after.watermark, "current") : null;
      if (priorAt && currentAt && watermarkRegressed(priorAt, currentAt)) {
        fail("watermark_regressed", `models[${modelId}] partition ${partition} watermark regressed ${before.watermark} -> ${after.watermark}`,
          { model_id: modelId, partition, prior: before.watermark, current: after.watermark });
      }
    }
  }

  if (reason) {
    return {
      schema: PLAN_SCHEMA, operation: "rebuild", reason, manifest_fingerprint: current.manifest_fingerprint,
      prior_manifest_fingerprint: prior?.manifest_fingerprint ?? null,
      models: Object.entries(current.models).map(([modelId, model]) => ({
        model_id: modelId, model_version: model.model_version, truncate: true,
        partitions: Object.entries(model.partitions).map(([partition, bucket]) => {
          const ops = { insert: Object.keys(bucket.rows).sort(compareText).map((key) => {
            const [table, ...rest] = key.split("|");
            return { table, key: rest.join("|") };
          }), update: [], delete: [] };
          return { partition, status: "rebuild", prior_watermark: prior?.models?.[modelId]?.partitions?.[partition]?.watermark ?? null,
            current_watermark: bucket.watermark, ops, counts: counts(ops, 0) };
        }),
      })),
    };
  }

  if (!prior || prior.schema !== SNAPSHOT_SCHEMA) {
    fail("no_prior_snapshot", "no prior partition snapshot: a first publication is an explicit rebuild (--rebuild <reason>)");
  }
  if (prior.manifest_fingerprint !== current.manifest_fingerprint) {
    fail("manifest_changed", "manifest fingerprint changed since the prior snapshot: publish as an explicit rebuild",
      { prior: prior.manifest_fingerprint, current: current.manifest_fingerprint });
  }

  const models = [];
  for (const modelId of Object.keys(current.models).sort(compareText)) {
    const currentModel = current.models[modelId];
    const priorModel = prior.models[modelId];
    if (!priorModel) fail("model_added", `models[${modelId}] has no prior snapshot: publish as an explicit rebuild`, { model_id: modelId });
    if (priorModel.model_version !== currentModel.model_version) {
      fail("model_version_changed", `models[${modelId}] model_version moved ${priorModel.model_version} -> ${currentModel.model_version}: publish as an explicit rebuild`,
        { model_id: modelId });
    }
    const partitionIds = new Set([...Object.keys(priorModel.partitions), ...Object.keys(currentModel.partitions)]);
    const partitions = [];
    for (const partition of [...partitionIds].sort(compareText)) {
      const before = priorModel.partitions[partition];
      const after = currentModel.partitions[partition];
      if (before && after) {
        const { ops, unchanged } = diffRows(before.rows, after.rows);
        const total = ops.insert.length + ops.update.length + ops.delete.length;
        partitions.push({ partition, status: total === 0 ? "unchanged" : "changed",
          prior_watermark: before.watermark, current_watermark: after.watermark, ops, counts: counts(ops, unchanged) });
      } else if (after) {
        const { ops, unchanged } = diffRows({}, after.rows);
        partitions.push({ partition, status: "added", prior_watermark: null, current_watermark: after.watermark, ops, counts: counts(ops, unchanged) });
      } else {
        const { ops, unchanged } = diffRows(before.rows, {});
        partitions.push({ partition, status: "removed", prior_watermark: before.watermark, current_watermark: null, ops, counts: counts(ops, unchanged) });
      }
    }
    const totals = partitions.reduce((acc, item) => {
      for (const field of ["insert", "update", "delete", "unchanged", "total_ops"]) acc[field] += item.counts[field];
      acc[`${item.status}_partitions`] += 1;
      return acc;
    }, { insert: 0, update: 0, delete: 0, unchanged: 0, total_ops: 0,
      unchanged_partitions: 0, changed_partitions: 0, added_partitions: 0, removed_partitions: 0 });
    models.push({ model_id: modelId, model_version: currentModel.model_version, truncate: false, partitions, totals });
  }
  return { schema: PLAN_SCHEMA, operation: "delta", reason: null, manifest_fingerprint: current.manifest_fingerprint,
    prior_manifest_fingerprint: prior.manifest_fingerprint, models };
}

export function liveSnapshot(root = ROOT, manifest = loadManifest()) {
  const sources = {};
  for (const entry of manifest.models) sources[entry.model_id] = loadSourceDocument(modelEntry(manifest, entry.model_id), root);
  return snapshotFor(manifest, sources);
}

function parseArgs(argv) {
  const out = { command: argv[2], prior: null, current: null, outPath: null, rebuild: null };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${arg} needs a value`); return argv[i]; };
    if (arg === "--prior") out.prior = next();
    else if (arg === "--current") out.current = next();
    else if (arg === "--out") out.outPath = next();
    else if (arg === "--rebuild") out.rebuild = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

function readPriorSnapshot(path, rebuildRequested) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && rebuildRequested) return null;
    if (error?.code === "ENOENT") fail("no_prior_snapshot", `prior snapshot ${path} does not exist: a first publication is an explicit rebuild (--rebuild <reason>)`);
    throw error;
  }
}

function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) { process.stdout.write(text); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function main() {
  let args;
  try { args = parseArgs(process.argv); } catch (error) { console.error(`d1_delta_plan: ${error.message}`); return 2; }
  try {
    if (args.command === "snapshot") {
      writeJson(args.outPath, liveSnapshot());
      return 0;
    }
    if (args.command === "plan") {
      if (!args.prior && args.rebuild == null) { console.error("d1_delta_plan: plan needs --prior <snapshot> (or --rebuild <reason>)"); return 2; }
      const prior = args.prior ? readPriorSnapshot(args.prior, args.rebuild != null) : null;
      const current = args.current ? JSON.parse(readFileSync(args.current, "utf8")) : liveSnapshot();
      const plan = planDelta({ prior, current, rebuild: args.rebuild });
      writeJson(args.outPath, plan);
      const summary = plan.models.map((model) => `${model.model_id}: ${model.operation || plan.operation} ${model.totals ? `ops=${model.totals.total_ops} changed=${model.totals.changed_partitions} unchanged=${model.totals.unchanged_partitions}` : "rebuild"}`);
      if (args.outPath) console.error(summary.join("\n"));
      return 0;
    }
    console.error("d1_delta_plan: usage: snapshot [--out p] | plan --prior p [--current p] [--rebuild reason] [--out p]");
    return 2;
  } catch (error) {
    if (error instanceof DeltaPlanError) {
      console.error(`d1_delta_plan: refused (${error.code}): ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
