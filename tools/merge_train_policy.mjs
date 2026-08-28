#!/usr/bin/env node

/**
 * Evaluate merge-train batch observations without changing the native queue.
 *
 * The source is a normalized, read-only snapshot. The evaluator reports the
 * four requested batch sizes, keeps observations above the native ceiling as
 * evidence only, and emits a receipt for producer groups that must be
 * serialized before they enter one train.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadElderPolicy, pickElderSeatHolder } from "./elder_merge_slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "tools", "merge_queue_policy.json");
const SOURCE_SCHEMA = "cityscroll.merge-throughput.train-policy.source.v1";
const REPORT_SCHEMA = "cityscroll.merge-throughput.train-policy.report.v1";
const SERIALIZATION_SCHEMA = "cityscroll.merge-throughput.generated-file-serialization.v1";
const REQUIRED_BATCH_SIZES = [1, 3, 5, 6];
const MINIMUM_SAMPLE_COUNT = 2;
const DEFAULT_THRESHOLDS = {
  max_runner_wait_minutes: 15,
  max_ejection_rate: 0.25,
};

function fail(message) {
  throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function metric(value, measurement, basis, extra = {}) {
  return { value, measurement, basis, ...extra };
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function finite(value, label, { integer = false, positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}: expected a finite number`);
  if (integer && !Number.isInteger(value)) fail(`${label}: expected an integer`);
  if (positive ? value <= 0 : value < 0) fail(`${label}: expected ${positive ? "a positive" : "a non-negative"} number`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}: expected a non-empty string`);
  return value;
}

function loadNativePolicy() {
  return JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
}

function validatePolicy(policy) {
  const queue = policy.merge_queue;
  if (!queue || queue.grouping_strategy !== "ALLGREEN") fail("native merge policy must retain ALLGREEN");
  finite(queue.max_entries_to_build, "merge_queue.max_entries_to_build", { integer: true, positive: true });
  finite(queue.max_entries_to_merge, "merge_queue.max_entries_to_merge", { integer: true, positive: true });
  if (queue.max_entries_to_build !== queue.max_entries_to_merge) fail("native build and merge ceilings must agree");
  return queue;
}

function validateSource(source, queue) {
  if (source?.schema !== SOURCE_SCHEMA) fail(`invalid source schema: expected ${SOURCE_SCHEMA}`);
  nonEmpty(source.repository, "repository");
  nonEmpty(source.source_run_id, "source_run_id");
  if (!Number.isFinite(Date.parse(source.observed_at))) fail("observed_at: expected an ISO timestamp");
  if (!source.native_policy || source.native_policy.grouping_strategy !== queue.grouping_strategy) {
    fail("source native_policy must prove the committed ALLGREEN grouping strategy");
  }
  if (source.native_policy.max_entries_to_build !== queue.max_entries_to_build
    || source.native_policy.max_entries_to_merge !== queue.max_entries_to_merge) {
    fail("source native_policy must match the committed native ceiling");
  }
  const observations = source.batch_observations;
  if (!Array.isArray(observations) || !observations.length) fail("batch_observations must be non-empty");
  const bySize = new Map();
  for (const [index, observation] of observations.entries()) {
    const label = `batch_observations[${index}]`;
    finite(observation.batch_size, `${label}.batch_size`, { integer: true, positive: true });
    if (!REQUIRED_BATCH_SIZES.includes(observation.batch_size)) fail(`${label}.batch_size must be one of ${REQUIRED_BATCH_SIZES.join(", ")}`);
    if (bySize.has(observation.batch_size)) fail(`${label}: duplicate batch size`);
    bySize.set(observation.batch_size, observation);
    if (!["controlled", "observed"].includes(observation.observation_kind)) fail(`${label}.observation_kind is invalid`);
    if (!Array.isArray(observation.samples) || !observation.samples.length) fail(`${label}.samples must be non-empty`);
    for (const [sampleIndex, sample] of observation.samples.entries()) {
      const sampleLabel = `${label}.samples[${sampleIndex}]`;
      nonEmpty(sample.id, `${sampleLabel}.id`);
      if (sample.grouping_strategy !== "ALLGREEN") fail(`${sampleLabel} must retain ALLGREEN composition`);
      finite(sample.runner_wait_minutes, `${sampleLabel}.runner_wait_minutes`);
      finite(sample.train_wall_time_minutes, `${sampleLabel}.train_wall_time_minutes`, { positive: true });
      finite(sample.successful_dequeues, `${sampleLabel}.successful_dequeues`, { integer: true });
      finite(sample.ejections, `${sampleLabel}.ejections`, { integer: true });
      finite(sample.time_in_queue_minutes, `${sampleLabel}.time_in_queue_minutes`);
      if (!Array.isArray(sample.per_shard_wall_time_minutes) || !sample.per_shard_wall_time_minutes.length) {
        fail(`${sampleLabel}.per_shard_wall_time_minutes must be non-empty`);
      }
      sample.per_shard_wall_time_minutes.forEach((value, shardIndex) => finite(value, `${sampleLabel}.per_shard_wall_time_minutes[${shardIndex}]`, { positive: true }));
      if (sample.successful_dequeues + sample.ejections <= 0) fail(`${sampleLabel} must have a non-zero attempt denominator`);
      if (sample.observation_kind === "observed" && observation.observation_kind !== "observed") {
        fail(`${sampleLabel} cannot be more authoritative than its batch observation`);
      }
    }
  }
  for (const size of REQUIRED_BATCH_SIZES) {
    if (!bySize.has(size)) fail(`missing required batch observation for size ${size}`);
  }
  if (!bySize.get(6).samples.some((sample) => sample.observation_kind === "observed" || bySize.get(6).observation_kind === "observed")) {
    fail("the six-car observation must include observed evidence");
  }
  if (!Array.isArray(source.serialized_producer_groups) || !source.serialized_producer_groups.length) {
    fail("serialized_producer_groups must be non-empty");
  }
  const groupIds = new Set();
  for (const [index, group] of source.serialized_producer_groups.entries()) {
    const label = `serialized_producer_groups[${index}]`;
    nonEmpty(group.group_id, `${label}.group_id`);
    if (groupIds.has(group.group_id)) fail(`${label}: duplicate group_id`);
    groupIds.add(group.group_id);
    if (!Array.isArray(group.files) || !group.files.length) fail(`${label}.files must be non-empty`);
    if (!Array.isArray(group.producers) || group.producers.length < 2) fail(`${label}.producers must contain overlapping producers`);
    nonEmpty(group.reason, `${label}.reason`);
    if (group.action !== "serialize") fail(`${label}.action must be serialize`);
    group.files.forEach((file, fileIndex) => nonEmpty(file, `${label}.files[${fileIndex}]`));
    group.producers.forEach((producer, producerIndex) => nonEmpty(producer.id, `${label}.producers[${producerIndex}].id`));
  }
  if (!Array.isArray(source.eligible_elder_prs)) fail("eligible_elder_prs must be an array");
  return bySize;
}

function aggregateObservation(observation) {
  const samples = observation.samples;
  const runnerWait = samples.map((sample) => sample.runner_wait_minutes);
  const trainMinutes = samples.reduce((sum, sample) => sum + sample.train_wall_time_minutes, 0);
  const successes = samples.reduce((sum, sample) => sum + sample.successful_dequeues, 0);
  const ejections = samples.reduce((sum, sample) => sum + sample.ejections, 0);
  const attempts = successes + ejections;
  const shards = samples.flatMap((sample) => sample.per_shard_wall_time_minutes);
  const queues = samples.map((sample) => sample.time_in_queue_minutes);
  const sufficient = samples.length >= MINIMUM_SAMPLE_COUNT;
  const denominator = samples.length;
  return {
    schema: "cityscroll.merge-throughput.batch-size-measurement.v1",
    batch_size: observation.batch_size,
    observation_kind: observation.observation_kind,
    sample_count: metric(samples.length, "measured", "source batch samples", { denominator: samples.length }),
    sample_sufficiency: {
      sufficient,
      minimum_samples: MINIMUM_SAMPLE_COUNT,
      reason: sufficient ? "sample count meets the bounded recommendation minimum" : "sample count is below the bounded recommendation minimum",
    },
    runner_wait_minutes: metric(round(runnerWait.reduce((sum, value) => sum + value, 0) / denominator), "measured", "mean runner wait across batch samples", { denominator }),
    per_shard_wall_time_minutes: {
      mean: metric(round(shards.reduce((sum, value) => sum + value, 0) / shards.length), "measured", "all source shard intervals", { denominator: shards.length }),
      max: metric(round(Math.max(...shards)), "measured", "maximum source shard interval", { denominator: shards.length }),
    },
    successful_dequeues: metric(successes, "measured", "source successful dequeue observations", { denominator: samples.length }),
    successful_dequeue_service_rate_per_hour: metric(round(successes / (trainMinutes / 60)), "derived", "successful dequeues divided by source train wall time hours", { numerator: successes, denominator_minutes: trainMinutes }),
    ejections: metric(ejections, "measured", "source ejection observations", { denominator: samples.length }),
    ejection_rate: metric(round(ejections / attempts), "derived", "ejections divided by successful dequeues plus ejections", { numerator: ejections, denominator: attempts }),
    time_in_queue_minutes: metric(round(queues.reduce((sum, value) => sum + value, 0) / denominator), "measured", "mean source time in queue across batch samples", { denominator }),
    train_wall_time_minutes: metric(round(trainMinutes / denominator), "measured", "mean source train wall time", { denominator }),
    composition: {
      grouping_strategy: "ALLGREEN",
      allgreen: samples.every((sample) => sample.grouping_strategy === "ALLGREEN"),
      same_group_samples: samples.filter((sample) => sample.composition === "same-group").length,
    },
  };
}

function recommendationFor(measurements, queue, thresholds) {
  const nativeCeiling = Math.min(queue.max_entries_to_build, queue.max_entries_to_merge);
  const candidates = measurements.filter((measurement) => measurement.batch_size <= nativeCeiling);
  const sufficient = candidates.every((measurement) => measurement.sample_sufficiency.sufficient);
  if (!sufficient) {
    return {
      status: "insufficient-evidence",
      recommended_batch_bound: null,
      confidence: "none",
      reason: "Every in-ceiling candidate needs at least the bounded sample minimum before a batch bound is recommended.",
      eligible_candidates: [],
    };
  }
  const eligible = candidates.filter((measurement) => measurement.runner_wait_minutes.value <= thresholds.max_runner_wait_minutes
    && measurement.ejection_rate.value <= thresholds.max_ejection_rate);
  const ranked = [...eligible].sort((a, b) => {
    const aScore = a.successful_dequeue_service_rate_per_hour.value * (1 - a.ejection_rate.value);
    const bScore = b.successful_dequeue_service_rate_per_hour.value * (1 - b.ejection_rate.value);
    return bScore - aScore || b.batch_size - a.batch_size;
  });
  const fallback = candidates.find((measurement) => measurement.batch_size === queue.min_entries_to_merge) || candidates[0];
  const selected = ranked[0] || fallback;
  return {
    status: "recommended",
    recommended_batch_bound: Math.min(selected.batch_size, nativeCeiling),
    confidence: "bounded",
    reason: ranked.length
      ? "Select the highest adjusted service-rate candidate that stays below runner-wait and ejection thresholds; the native ceiling remains a hard upper bound."
      : "All candidates show saturation or ejection pressure; retain the minimum native batch while collecting more evidence.",
    eligible_candidates: ranked.map((measurement) => measurement.batch_size),
    thresholds,
    adjusted_service_rate: selected.successful_dequeue_service_rate_per_hour.value * (1 - selected.ejection_rate.value),
  };
}

function buildSerializationReceipt(source) {
  const groups = source.serialized_producer_groups.map((group) => ({
    group_id: group.group_id,
    action: "serialize",
    files: [...group.files].sort(),
    producers: group.producers.map((producer) => ({ id: producer.id, outputs: [...(producer.outputs || [])].sort() })),
    reason: group.reason,
    receipt: "overlapping generated-file producers share one train boundary; run one producer group at a time",
  }));
  const receiptBase = {
    schema: SERIALIZATION_SCHEMA,
    source_run_id: source.source_run_id,
    repository: source.repository,
    groups,
    generated_file_conflict_policy: "serialize-overlapping-producer-groups",
    watermark_decision: {
      state: "registered-decision",
      action: "reference-only",
      note: "The shared architecture watermark serialization finding remains a registered decision; this policy does not implement a watermark remedy.",
    },
    validation: "passed",
  };
  return { ...receiptBase, receipt_sha256: sha256(receiptBase) };
}

export function buildTrainPolicy(source, { policy = loadNativePolicy(), thresholds = DEFAULT_THRESHOLDS } = {}) {
  const queue = validatePolicy(policy);
  const bySize = validateSource(source, queue);
  const measurements = REQUIRED_BATCH_SIZES.map((size) => aggregateObservation(bySize.get(size)));
  const recommendation = recommendationFor(measurements, queue, thresholds);
  const elder = loadElderPolicy();
  const elderProtection = pickElderSeatHolder(source.eligible_elder_prs, elder, Date.parse(source.observed_at));
  const serialization = buildSerializationReceipt(source);
  const overCeiling = measurements.filter((measurement) => measurement.batch_size > Math.min(queue.max_entries_to_build, queue.max_entries_to_merge));
  const reportBase = {
    schema: REPORT_SCHEMA,
    repository: source.repository,
    source_run_id: source.source_run_id,
    observed_at: source.observed_at,
    observation_window: source.window || null,
    policy: {
      path: "tools/merge_queue_policy.json",
      grouping_strategy: queue.grouping_strategy,
      allgreen_unchanged: queue.grouping_strategy === "ALLGREEN",
      native_ceiling: Math.min(queue.max_entries_to_build, queue.max_entries_to_merge),
      maximum_observed_batch_size: Math.max(...REQUIRED_BATCH_SIZES),
    },
    measurements,
    observed_evidence: {
      batch_size: 6,
      observation_kind: "observed",
      statement: bySize.get(6).evidence_note || "Observed six-car batch evidence is retained with its source observation.",
      interpretation: "Same-group batches merged conflict-free in the observed run; solo ejections remain a service-loss signal, not proof that batching alone caused the difference.",
    },
    recommendation,
    ceiling_guard: {
      over_ceiling_observations: overCeiling.map((measurement) => measurement.batch_size),
      admitted_to_recommendation: overCeiling.every((measurement) => !measurement.sample_sufficiency.sufficient) ? [] : overCeiling.filter((measurement) => measurement.batch_size <= Math.min(queue.max_entries_to_build, queue.max_entries_to_merge)).map((measurement) => measurement.batch_size),
      reason: "Observed evidence above the committed native ceiling is retained for comparison but cannot change queue settings.",
    },
    composition_guard: {
      grouping_strategy: "ALLGREEN",
      allgreen_unchanged: measurements.every((measurement) => measurement.composition.allgreen),
      same_group_batches_preserved: measurements.some((measurement) => measurement.composition.same_group_samples > 0),
    },
    elder_protection: {
      policy_module: "tools/elder_merge_slot.mjs",
      detect_and_steer_age_hours: elder.detect_and_steer_age_hours,
      elder_age_hours: elder.elder_age_hours,
      rebase_churn_threshold: elder.rebase_churn_threshold,
      reservation: elderProtection,
      cannot_starve_eligible_elder: elderProtection.seat == null || elderProtection.seat.number === elderProtection.elders[0]?.number,
    },
    serialization_receipt_sha256: serialization.receipt_sha256,
    validation: "passed",
  };
  return { report: { ...reportBase, report_sha256: sha256(reportBase) }, serialization };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${file}: ${error.message}`);
  }
}

function outputFiles(result) {
  return {
    "train-policy-report.json": result.report,
    "serialization-receipt.json": result.serialization,
  };
}

function writeOutputs(directory, result) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(outputFiles(result))) fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function compareOutputs(directory, result) {
  for (const [name, expected] of Object.entries(outputFiles(result))) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) fail(`missing expected train-policy artifact: ${file}`);
    if (canonicalJson(readJson(file)) !== canonicalJson(expected)) fail(`train-policy artifact drift: ${name}`);
  }
}

function parseArgs(argv) {
  const args = { fixture: null, output: null, check: false, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") args.fixture = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--check") args.check = true;
    else if (value === "--write") args.write = true;
    else if (value === "--help") {
      console.log("Usage: node tools/merge_train_policy.mjs --fixture DIR [--check | --write] [--output DIR]");
      process.exit(0);
    } else fail(`unknown argument: ${value}`);
  }
  if (!args.fixture) fail("--fixture DIR is required");
  if (args.check === args.write) fail("choose exactly one of --check or --write");
  return args;
}

function resolveFixture(fixture) {
  const rootSource = path.join(fixture, "source.json");
  const trainSource = path.join(fixture, "train-policy", "source.json");
  if (fs.existsSync(trainSource) && readJson(rootSource).schema !== SOURCE_SCHEMA) {
    return { source: trainSource, output: path.join(fixture, "train-policy", "expected") };
  }
  return { source: rootSource, output: path.join(fixture, "expected") };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const fixture = path.resolve(args.fixture);
    const resolved = resolveFixture(fixture);
    const result = buildTrainPolicy(readJson(resolved.source));
    const output = path.resolve(args.output ?? resolved.output);
    if (args.check) compareOutputs(output, result);
    else writeOutputs(output, result);
    console.log(`merge-train policy ${args.check ? "valid" : "written"}: ${result.report.report_sha256}`);
    return 0;
  } catch (error) {
    console.error(`merge-train policy invalid: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(main());
