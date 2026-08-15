#!/usr/bin/env node
// Build bounded daily snapshots for resident surfaces.
//
// Usage:
//   node tools/build_batch_precompute_snapshots.mjs            # write all
//   node tools/build_batch_precompute_snapshots.mjs --check     # fail if stale (CI)
//   node tools/build_batch_precompute_snapshots.mjs --fixture   # use offline fixtures
//
// Snapshots are commit-time artifacts (inline-at-build). Browser readers filter
// them locally; only this acquisition command contacts publisher sources.

import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDataPageSnapshot,
  buildLandDefaultSnapshot,
  buildMoneyAgenciesSnapshot,
  buildMoneyDefaultOpenSnapshot,
  buildStaffingHiresSnapshot,
  fetchDataPageCharts,
  fetchLandDefaultProjects,
  fetchLandOutcomeSnapshots,
  fetchMoneyAgencies,
  fetchMoneyDefaultOpen,
  fetchStaffingHires,
} from "./lib/batch_precompute_snapshots.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "site", "data");
const DATA_PAGE_OUT = path.join(DATA_DIR, "data_page_charts.json");
const LAND_OUT = path.join(DATA_DIR, "land_default_ulurp.json");
const MONEY_OPEN_OUT = path.join(DATA_DIR, "money_default_open.json");
const MONEY_AGENCIES_OUT = path.join(DATA_DIR, "money_procurement_agencies.json");
const STAFFING_HIRES_OUT = path.join(DATA_DIR, "staffing_default_hires.json");
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "batch-precompute");

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    fixture: argv.includes("--fixture"),
    dataOnly: argv.includes("--data-only"),
    landOnly: argv.includes("--land-only"),
    moneyOnly: argv.includes("--money-only"),
    staffingOnly: argv.includes("--staffing-only"),
  };
}

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), "utf8"));
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeOrCheck(filePath, payload, check) {
  const rendered = stableStringify(payload);
  if (check) {
    let existing = null;
    try {
      existing = await readFile(filePath, "utf8");
    } catch {
      existing = null;
    }
    assert.equal(
      existing,
      rendered,
      `${path.relative(ROOT, filePath)} is stale; rebuild with node tools/build_batch_precompute_snapshots.mjs`,
    );
    return { path: filePath, status: "ok" };
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, rendered);
  return { path: filePath, status: "wrote", bytes: Buffer.byteLength(rendered) };
}

function wants(args, key) {
  const only =
    args.dataOnly || args.landOnly || args.moneyOnly || args.staffingOnly;
  if (!only) return true;
  if (key === "data") return args.dataOnly;
  if (key === "land") return args.landOnly;
  if (key === "money") return args.moneyOnly;
  if (key === "staffing") return args.staffingOnly;
  return false;
}

export async function buildAll({
  fetchImpl = fetch,
  now = new Date(),
  fixture = false,
  dataOnly = false,
  landOnly = false,
  moneyOnly = false,
  staffingOnly = false,
} = {}) {
  const args = { dataOnly, landOnly, moneyOnly, staffingOnly };
  const results = {};
  if (wants(args, "data")) {
    let raw;
    if (fixture) {
      raw = await loadFixture("data_page_charts_raw.json");
    } else {
      raw = await fetchDataPageCharts(fetchImpl, now);
    }
    results.data_page = buildDataPageSnapshot(raw, { now });
  }
  if (wants(args, "land")) {
    let projects;
    let outcomesByProject;
    if (fixture) {
      projects = await loadFixture("land_default_projects.json");
      outcomesByProject = Object.fromEntries(projects.map((project, index) => [
        project.project_id,
        {
          project_id: project.project_id,
          public_status: project.public_status,
          portal_url: `https://zap.planning.nyc.gov/projects/${project.project_id}`,
          join: index === 0
            ? { matched: true, method: "exact_project_id" }
            : { matched: false, reason: "No published outcome joined." },
          filled: index === 0,
          approved_actions: index === 0 ? [{ status: "Approved", action: "ZM" }] : [],
          dispositions: [],
          documents: index === 0
            ? [{ name: "Decision", url: "https://example.invalid/decision.pdf" }]
            : [],
          n_documents: index === 0 ? 1 : 0,
          spine: { events: [] },
        },
      ]));
    } else {
      projects = await fetchLandDefaultProjects(fetchImpl);
      outcomesByProject = await fetchLandOutcomeSnapshots(projects, fetchImpl);
    }
    results.land_default = buildLandDefaultSnapshot(projects, { now, outcomesByProject });
  }
  if (wants(args, "money")) {
    let openRows;
    let agencyRows;
    if (fixture) {
      openRows = await loadFixture("money_default_open_raw.json");
      agencyRows = await loadFixture("money_procurement_agencies_raw.json");
    } else {
      [openRows, agencyRows] = await Promise.all([
        fetchMoneyDefaultOpen(fetchImpl, now),
        fetchMoneyAgencies(fetchImpl),
      ]);
    }
    results.money_default_open = buildMoneyDefaultOpenSnapshot(openRows, { now });
    results.money_agencies = buildMoneyAgenciesSnapshot(agencyRows, { now });
  }
  if (wants(args, "staffing")) {
    let hires;
    if (fixture) {
      hires = await loadFixture("staffing_default_hires_raw.json");
    } else {
      hires = await fetchStaffingHires(fetchImpl);
    }
    results.staffing_hires = buildStaffingHiresSnapshot(hires, { now });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const built = await buildAll({
    now,
    fixture: args.fixture,
    dataOnly: args.dataOnly,
    landOnly: args.landOnly,
    moneyOnly: args.moneyOnly,
    staffingOnly: args.staffingOnly,
  });
  const out = [];
  if (built.data_page) {
    out.push(await writeOrCheck(DATA_PAGE_OUT, built.data_page, args.check));
  }
  if (built.land_default) {
    out.push(await writeOrCheck(LAND_OUT, built.land_default, args.check));
  }
  if (built.money_default_open) {
    out.push(await writeOrCheck(MONEY_OPEN_OUT, built.money_default_open, args.check));
  }
  if (built.money_agencies) {
    out.push(await writeOrCheck(MONEY_AGENCIES_OUT, built.money_agencies, args.check));
  }
  if (built.staffing_hires) {
    out.push(await writeOrCheck(STAFFING_HIRES_OUT, built.staffing_hires, args.check));
  }
  for (const row of out) {
    console.log(
      args.check
        ? `ok ${path.relative(ROOT, row.path)}`
        : `wrote ${path.relative(ROOT, row.path)} (${row.bytes} bytes)`,
    );
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
