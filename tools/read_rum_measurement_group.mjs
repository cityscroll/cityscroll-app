#!/usr/bin/env node
/**
 * Read one retained RUM measurement group and report it labelled.
 *
 * The shared read-back procedure asks a question about one population. This
 * entry point reads exactly one — `resident` or `synthetic` — through the same
 * bounded query grammar the private read model uses, applies that group's own
 * sample floor and its own window anchor, and labels every row with the group it
 * came from. There is no argument that reads both at once, because a percentile
 * pooled across the two would describe no population at all.
 *
 *   ANALYTICS_ACCOUNT_ID=... ANALYTICS_READ_TOKEN=... \
 *   node tools/read_rum_measurement_group.mjs --group synthetic \
 *     --metric content_ready_ms --surface notice --component none --window 7d
 *
 * `--anchor` names the group's window anchor explicitly. Without it the anchor
 * is the first retained observation in the group, which for the synthetic group
 * is the first probe slot that reached the dataset.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  measurementGroupNames,
  projectMeasurementGroupReadBack,
  resolveMeasurementGroup,
  validateMeasurementGroupReadBack,
} from "./lib/rum_measurement_groups.mjs";
import { readPerformanceAnalytics } from "../worker/src/lib/performance_query.mjs";

const USAGE = `Usage: node tools/read_rum_measurement_group.mjs --group <${measurementGroupNames().join("|")}>
  [--metric <metric_id>] [--surface <surface_id>] [--component <component_id>]
  [--window 24h|7d|30d|90d] [--anchor <ISO>] [--floor <n>] [--out <path>]`;

export function parseArgs(argv) {
  const args = {
    group: null,
    metric: null,
    surface: null,
    component: null,
    window: "7d",
    anchor: null,
    floor: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--group") args.group = argv[++i];
    else if (arg === "--metric") args.metric = argv[++i];
    else if (arg === "--surface") args.surface = argv[++i];
    else if (arg === "--component") args.component = argv[++i];
    else if (arg === "--window") args.window = argv[++i];
    else if (arg === "--anchor") args.anchor = argv[++i];
    else if (arg === "--floor") args.floor = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") return { ...args, help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.group) throw new Error(`--group is required\n${USAGE}`);
  resolveMeasurementGroup(args.group);
  return args;
}

export function buildQuery(args) {
  const group = resolveMeasurementGroup(args.group);
  const filters = { traffic_class: group.traffic_class };
  if (args.metric) filters.metric_id = args.metric;
  if (args.surface) filters.surface_id = args.surface;
  if (args.component) filters.component_id = args.component;
  // Grouping only on dimensions the filters did not already pin keeps the read
  // legal for the shared grammar whether or not the caller narrowed it.
  const groupBy = ["metric_id", "surface_id", "component_id"].filter((dimension) => !filters[dimension]);
  return {
    window: args.window,
    filters,
    ...(groupBy.length ? { group_by: groupBy } : {}),
  };
}

export async function readMeasurementGroup(args, { env = process.env, now = new Date() } = {}) {
  const snapshot = await readPerformanceAnalytics(env, buildQuery(args), {
    now,
    sampleFloor: args.floor || env.RUM_MIN_SAMPLED_ROWS || undefined,
  });
  const document = projectMeasurementGroupReadBack({
    group: args.group,
    snapshot,
    anchor: args.anchor,
    sampleFloor: args.floor,
    queriedAt: now,
  });
  const validation = validateMeasurementGroupReadBack(document);
  if (!validation.ok) {
    const error = new Error(validation.errors.join("; "));
    error.validation = validation;
    throw error;
  }
  return document;
}

function summaryLine(document) {
  const sufficient = document.groups.filter((row) => row.sufficiency === "sufficient").length;
  return JSON.stringify({
    measurement_group: document.measurement_group,
    label: document.label,
    traffic_class: document.traffic_class,
    query_status: document.query_status,
    anchor: document.anchor.at,
    anchor_source: document.anchor.source,
    window_begins_at_or_after_anchor: document.window.begins_at_or_after_anchor,
    sample_floor: document.sample_floor,
    groups: document.groups.length,
    sufficient_groups: sufficient,
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const document = await readMeasurementGroup(args);
  if (args.out) {
    const out = resolve(args.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  } else {
    console.log(JSON.stringify(document, null, 2));
  }
  console.error(summaryLine(document));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`measurement group read unavailable: ${error.message}`);
    process.exitCode = 1;
  });
}
