#!/usr/bin/env node
/**
 * Build the retained Notice post-delivery read-back aggregate.
 *
 * Reads each required measurement group through the shared RUM grammar
 * (`tools/read_rum_measurement_group.mjs` / `worker/src/lib/performance_query.mjs`),
 * the same path `tools/read_rum_drift.mjs` uses for its daily overlay, and writes
 * the committed aggregate at
 * `docs/evidence/performance-drift/notice-readback-aggregate.json`.
 *
 *   ANALYTICS_ACCOUNT_ID=<from worker/wrangler.toml> \
 *   ANALYTICS_READ_TOKEN=<Cloudflare API token with Analytics Engine read> \
 *   RUM_ANALYTICS_DATASET=crol_rum_observations_v1 \
 *   RUM_MEASURED_SINCE=2026-08-19 \
 *   RUM_MIN_SAMPLED_ROWS=30 \
 *   node tools/build_notice_readback_aggregate.mjs
 *
 *   node tools/build_notice_readback_aggregate.mjs --check
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NOTICE_EDGE_CACHE_OUTCOMES, parseNoticeEdgeTiming } from "../site/notice_edge_response.mjs";
import { readMeasurementGroup } from "./read_rum_measurement_group.mjs";
import {
  NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON,
  NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP,
  NOTICE_READBACK_CACHE_OUTCOMES,
  NOTICE_READBACK_DELIVERIES,
  NOTICE_READBACK_GROUP_SPECS,
  NOTICE_READBACK_RETAINED_PATH,
  NOTICE_READBACK_REQUIRED_GROUPS,
  NOTICE_READBACK_SAMPLE_FLOOR,
  buildNoticeReadbackAggregate,
  buildUnreadRecordCacheOutcomeDistribution,
  validateNoticeReadbackAggregate,
} from "./lib/notice_readback_aggregate.mjs";
import {
  DEFAULT_RUM_ANALYTICS_DATASET,
  performanceReadConfiguration,
} from "../worker/src/lib/performance_query.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, NOTICE_READBACK_RETAINED_PATH);

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    check: false,
    window: "7d",
    productionRevision: null,
    now: new Date(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = resolve(argv[++i]);
    else if (arg === "--check") args.check = true;
    else if (arg === "--window") args.window = argv[++i];
    else if (arg === "--production-revision") args.productionRevision = argv[++i];
    else if (arg === "--now") args.now = new Date(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node tools/build_notice_readback_aggregate.mjs [--out path] [--check]",
        "       [--window 7d] [--production-revision <sha>] [--now ISO]",
        "",
        "Reads cold_module_path, first_byte, and synthetic Notice groups from",
        "production, plus the record subrequest cache outcome distribution for the",
        "first_byte window (read with counts, or unread with a reason), and retains",
        "the aggregate under docs/evidence/performance-drift/.",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.now.getTime())) throw new Error("--now must be a valid ISO timestamp");
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function resolveProductionRevision(explicit, fetchImpl = globalThis.fetch) {
  if (explicit) return explicit;
  if (process.env.CITYSCROLL_PRODUCTION_REVISION) return process.env.CITYSCROLL_PRODUCTION_REVISION;
  const response = await fetchImpl("https://api.cityscroll.org/health");
  if (!response.ok) throw new Error(`production health unavailable (${response.status})`);
  const body = await response.json();
  const commit = String(body?.commit || "");
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("production health did not return a 40-character commit SHA");
  }
  return commit;
}

const CACHE_OUTCOME_PROBE_URLS = Object.freeze([
  "https://cityscroll.org/notices/20260805014",
  "https://cityscroll.org/notices/20260708002",
  "https://cityscroll.org/notices/20260716009",
]);

/**
 * Ask whether production retains a windowed record-cache-outcome distribution
 * in the same Analytics Engine dataset the sibling groups use. The RUM
 * observation schema has no cache-outcome dimension, so this returns unread
 * with a precise reason rather than fabricating counts from live headers.
 *
 * Live Server-Timing probes only confirm that responses still carry the
 * vocabulary; they are never tallied into a windowed distribution.
 */
export async function resolveRecordCacheOutcomeDistribution({
  window = null,
  delivery = null,
  queriedAt = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = performanceReadConfiguration(env);
  const dataset = String(env.RUM_ANALYTICS_DATASET || DEFAULT_RUM_ANALYTICS_DATASET).trim()
    || DEFAULT_RUM_ANALYTICS_DATASET;
  const source = {
    response_header: "Server-Timing",
    metric: "cs-record",
    closed_outcomes: [...NOTICE_READBACK_CACHE_OUTCOMES],
    retained_query_path: null,
    analytics_engine_dataset: dataset,
    analytics_engine_configured: config.configured === true,
  };

  let liveOutcomesSeen = [];
  for (const url of CACHE_OUTCOME_PROBE_URLS) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          "User-Agent": "cityscroll-notice-readback-aggregate/1.0",
          Accept: "text/html",
        },
        redirect: "follow",
      });
      const timing = parseNoticeEdgeTiming(response.headers.get("Server-Timing"));
      const outcome = timing?.["cs-record"]?.outcome;
      if (NOTICE_EDGE_CACHE_OUTCOMES.includes(outcome)) liveOutcomesSeen.push(outcome);
    } catch {
      // Probe failure does not invent a distribution; it only weakens the live evidence.
    }
  }
  liveOutcomesSeen = [...new Set(liveOutcomesSeen)].sort();
  if (liveOutcomesSeen.length) source.live_response_outcomes_observed = liveOutcomesSeen;

  // No retained query path exists for this vocabulary in the RUM dataset. An
  // empty read would require a query that returned zero rows of a known
  // cache-outcome series; absence of that series is unread, not empty.
  return buildUnreadRecordCacheOutcomeDistribution({
    reason: NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON,
    detail: [
      "Notice responses carry the record subrequest cache outcome on Server-Timing (cs-record),",
      "but the RUM Analytics Engine observation set used for the sibling measurement groups",
      "retains no cache-outcome dimension, so no windowed distribution can be read.",
      liveOutcomesSeen.length
        ? `Live responses observed outcomes: ${liveOutcomesSeen.join(", ")}.`
        : "Live Server-Timing probes did not return a parseable cs-record outcome during this run.",
    ].join(" "),
    window,
    delivery,
    queriedAt,
    source,
  });
}

function queryPlan() {
  const plan = [];
  for (const groupName of NOTICE_READBACK_REQUIRED_GROUPS) {
    const spec = NOTICE_READBACK_GROUP_SPECS[groupName];
    const delivery = NOTICE_READBACK_DELIVERIES[groupName];
    for (const metric of spec.metrics) {
      plan.push({
        group: groupName,
        rum_group: spec.rum_group,
        metric_id: metric.metric_id,
        surface_id: metric.surface_id,
        component_id: metric.component_id,
        anchor: delivery.merged_at,
      });
    }
  }
  return plan;
}

export async function buildFromProduction({
  window = "7d",
  now = new Date(),
  productionRevision = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  readGroup = readMeasurementGroup,
} = {}) {
  const revision = await resolveProductionRevision(productionRevision, fetchImpl);
  const reads = [];
  for (const entry of queryPlan()) {
    const document = await readGroup({
      group: entry.rum_group,
      metric: entry.metric_id,
      surface: entry.surface_id,
      component: entry.component_id,
      window,
      anchor: entry.anchor,
      floor: String(NOTICE_READBACK_SAMPLE_FLOOR),
      out: null,
    }, { env, now });
    reads.push({
      group: entry.group,
      metric_id: entry.metric_id,
      surface_id: entry.surface_id,
      component_id: entry.component_id,
      document,
    });
  }

  // Inherit the first_byte window so the cache-outcome field sits beside that group.
  const windowSeed = buildNoticeReadbackAggregate({
    reads,
    productionRevision: revision,
    queriedAt: now,
    sampleFloor: NOTICE_READBACK_SAMPLE_FLOOR,
  });
  const firstByte = windowSeed.measurement_groups[NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP];
  const recordCacheOutcomeDistribution = await resolveRecordCacheOutcomeDistribution({
    window: firstByte?.window || null,
    delivery: firstByte?.delivery || null,
    queriedAt: now,
    env,
    fetchImpl,
  });
  const aggregate = buildNoticeReadbackAggregate({
    reads,
    productionRevision: revision,
    queriedAt: now,
    sampleFloor: NOTICE_READBACK_SAMPLE_FLOOR,
    recordCacheOutcomeDistribution,
  });
  const validation = validateNoticeReadbackAggregate(aggregate);
  if (!validation.ok) {
    const error = new Error(validation.refusals.map((row) => row.reason).join(", "));
    error.validation = validation;
    error.aggregate = aggregate;
    throw error;
  }
  return aggregate;
}

function summaryLine(aggregate) {
  const groups = {};
  for (const name of NOTICE_READBACK_REQUIRED_GROUPS) {
    const group = aggregate.measurement_groups[name];
    groups[name] = {
      clears_sample_floor: group.clears_sample_floor,
      metrics: group.metrics.map((metric) => ({
        metric_id: metric.metric_id,
        surface_id: metric.surface_id,
        sampled_count: metric.sampled_count,
        sufficiency: metric.sufficiency,
      })),
    };
  }
  const cache = aggregate.record_cache_outcome_distribution || null;
  return {
    schema: aggregate.schema,
    retained_path: NOTICE_READBACK_RETAINED_PATH,
    production_revision: aggregate.production_revision,
    queried_at: aggregate.queried_at,
    groups,
    record_cache_outcome_distribution: cache ? {
      state: cache.state,
      reason: cache.reason || null,
      sampled_count: cache.sampled_count ?? null,
      outcomes: cache.outcomes || null,
      keyed_to_measurement_group: cache.window?.keyed_to_measurement_group || null,
    } : null,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.check) {
    if (!existsSync(args.out)) {
      console.error(`retained aggregate missing: ${args.out}`);
      process.exitCode = 1;
      return;
    }
    const document = readJson(args.out);
    const validation = validateNoticeReadbackAggregate(document);
    if (!validation.ok) {
      console.error(JSON.stringify({ ok: false, refusals: validation.refusals }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, ...summaryLine(document) }));
    return;
  }

  const aggregate = await buildFromProduction({
    window: args.window,
    now: args.now,
    productionRevision: args.productionRevision,
  });
  writeJson(args.out, aggregate);
  console.log(JSON.stringify(summaryLine(aggregate)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`notice read-back aggregate unavailable: ${error.message}`);
    if (error.validation) {
      console.error(JSON.stringify({ refusals: error.validation.refusals }, null, 2));
    }
    process.exitCode = 1;
  });
}
