#!/usr/bin/env node
/**
 * Measure individual-project hearing logistics on a fixed, source-listed sample.
 *
 *   node tools/measure_zap_hearing_logistics.mjs --live --limit 50 --out <receipt.json>
 *   node tools/measure_zap_hearing_logistics.mjs --live --sample <receipt.json>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listActiveLandProjects } from "./build_land_upcoming_hearings.mjs";
import {
  parseZapApiProject,
  ZAP_API_BASE,
} from "../worker/src/lib/zap_outcomes.mjs";
import { summarizeZapHearingLogisticsCoverage } from "./lib/zap_hearing_logistics_coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LIMIT = 50;
const DEFAULT_DELAY_MS = 350;
const MIN_DELAY_MS = 300;
const FIELD_CASE_ID = "2024Q0292";

function parseArgs(argv) {
  const args = {
    live: false,
    limit: DEFAULT_LIMIT,
    delayMs: DEFAULT_DELAY_MS,
    sample: null,
    out: null,
    today: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") args.live = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--polite-delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--sample") args.sample = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--today") args.today = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.live && !args.help) throw new Error("refusing network measurement without --live");
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 200) {
    throw new Error("--limit must be between 1 and 200");
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < MIN_DELAY_MS) {
    throw new Error(`--polite-delay-ms must be at least ${MIN_DELAY_MS}`);
  }
  return args;
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function fetchJson(url, timeoutMs = 25000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: ctl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "CityScroll zap-hearing-logistics-measurement/1.0 (+https://cityscroll.org)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProject(projectId, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(`${ZAP_API_BASE}/projects/${encodeURIComponent(projectId)}`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(750);
    }
  }
  throw lastError;
}

function sampleFromReceipt(path) {
  if (!path || !existsSync(path)) throw new Error(`sample receipt not found: ${path}`);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  const ids = receipt.sample_project_ids || receipt.measurement?.projects?.map((row) => row.project_id);
  if (!Array.isArray(ids) || !ids.length) throw new Error("sample receipt has no project ids");
  return ids.map((projectId) => ({ project_id: String(projectId) }));
}

async function selectProjects(args) {
  if (args.sample) return sampleFromReceipt(args.sample).slice(0, args.limit);
  const listed = await listActiveLandProjects({ max: args.limit });
  if (listed.some((project) => project.project_id === FIELD_CASE_ID)) return listed.slice(0, args.limit);
  if (args.limit === 1) return [{ project_id: FIELD_CASE_ID }];
  return [...listed.slice(0, args.limit - 1), { project_id: FIELD_CASE_ID }];
}

async function measure(args) {
  const selected = await selectProjects(args);
  const sample = [];
  for (let index = 0; index < selected.length; index += 1) {
    const project = selected[index];
    const projectId = project.project_id;
    try {
      const payload = await fetchProject(projectId);
      sample.push({ project_id: projectId, status: "ok", record: parseZapApiProject(payload) });
    } catch (error) {
      sample.push({
        project_id: projectId,
        status: "failed",
        error: String(error?.message || error),
      });
    }
    if (index + 1 < selected.length) await wait(args.delayMs);
    if ((index + 1) % 10 === 0 || index + 1 === selected.length) {
      console.error(`measured ${index + 1}/${selected.length}`);
    }
  }
  const observedAt = new Date().toISOString();
  const today = String(args.today || observedAt.slice(0, 10)).slice(0, 10);
  const measurement = summarizeZapHearingLogisticsCoverage(sample, { today });
  const fieldCase = measurement.projects.find((project) => project.project_id === FIELD_CASE_ID) || null;
  return {
    schema_version: 1,
    kind: "zap_individual_project_hearing_logistics_coverage",
    source_contract_id: "zap-api-outcomes",
    observed_at: observedAt,
    observed_on: today,
    source: "zap-api-dispositions",
    sample_definition: {
      universe: "sell-facing Open Data projects",
      statuses: ["In Public Review", "Noticed", "Active", "Filed"],
      ordering: "status priority, then current_milestone_date DESC",
      fixed_after_measurement: true,
      citywide_inference_allowed: false,
    },
    sample_project_ids: selected.map((project) => project.project_id),
    measurement,
    field_case: {
      project_id: FIELD_CASE_ID,
      baseline_report: "data/flywheel-reeval-persona/report.md#3-hearing-attender-land--meetings-logistics",
      baseline_hearing_logistics_populated: 0,
      current_hearing_logistics_populated: fieldCase?.hearing_logistics ? 1 : 0,
      incremental_projects_populated: fieldCase?.hearing_logistics ? 1 : 0,
    },
    honesty: {
      absent_shape: null,
      accepted_source_fields: [
        "dcp-publichearinglocation",
        "dcp-dateofpublichearing",
      ],
      milestone_review_sessions_count_as_logistics: false,
      note: "This is fixed-sample coverage, not a citywide rate.",
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/measure_zap_hearing_logistics.mjs --live [--limit 50] [--sample receipt.json] [--out receipt.json]");
    return;
  }
  const receipt = await measure(args);
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.out) {
    const path = resolve(ROOT, args.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json);
    console.error(`wrote ${path}`);
  }
  process.stdout.write(json);
  if (receipt.measurement.invalid_logistics_rows || receipt.measurement.join_mismatches) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { measure };
