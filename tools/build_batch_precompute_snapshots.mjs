#!/usr/bin/env node
// Build BATCHABLE first-paint snapshots for wave-2 perceived speed.
//
// Usage:
//   node tools/build_batch_precompute_snapshots.mjs            # write both
//   node tools/build_batch_precompute_snapshots.mjs --check     # fail if stale (CI)
//   node tools/build_batch_precompute_snapshots.mjs --fixture   # use offline fixtures
//
// Snapshots are commit-time artifacts (inline-at-build). Clients paint from them
// immediately and may hybrid-refresh live SODA when freshness matters.

import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDataPageSnapshot,
  buildLandDefaultSnapshot,
  fetchDataPageCharts,
  fetchLandDefaultProjects,
} from "./lib/batch_precompute_snapshots.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "site", "data");
const DATA_PAGE_OUT = path.join(DATA_DIR, "data_page_charts.json");
const LAND_OUT = path.join(DATA_DIR, "land_default_ulurp.json");
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "batch-precompute");

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    fixture: argv.includes("--fixture"),
    dataOnly: argv.includes("--data-only"),
    landOnly: argv.includes("--land-only"),
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

export async function buildAll({ fetchImpl = fetch, now = new Date(), fixture = false, dataOnly = false, landOnly = false } = {}) {
  const results = {};
  if (!landOnly) {
    let raw;
    if (fixture) {
      raw = await loadFixture("data_page_charts_raw.json");
    } else {
      raw = await fetchDataPageCharts(fetchImpl, now);
    }
    results.data_page = buildDataPageSnapshot(raw, { now });
  }
  if (!dataOnly) {
    let projects;
    if (fixture) {
      projects = await loadFixture("land_default_projects.json");
    } else {
      projects = await fetchLandDefaultProjects(fetchImpl);
    }
    results.land_default = buildLandDefaultSnapshot(projects, { now });
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
  });
  const out = [];
  if (built.data_page) {
    out.push(await writeOrCheck(DATA_PAGE_OUT, built.data_page, args.check));
  }
  if (built.land_default) {
    out.push(await writeOrCheck(LAND_OUT, built.land_default, args.check));
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
