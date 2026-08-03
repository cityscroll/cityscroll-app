#!/usr/bin/env node
// Build per-district per-lens activity aggregates for the map exploration
// surface (cs-geo-04). Reads committed corpora + the cs-geo-02 boundary layer.
// No live GIS.
//
//   node tools/build_district_activity.mjs
//   node tools/build_district_activity.mjs --check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDistrictActivity, DISTRICT_ACTIVITY_SCHEMA } from "./lib/district_activity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_OUT = join(ROOT, "site/data/district_activity.json");
const WORKER_OUT = join(ROOT, "worker/src/data/district_activity.json");

const PATHS = {
  boundaries: join(ROOT, "site/data/district_boundaries.json"),
  zap: join(ROOT, "site/data/zap_projects_warehouse_lookup.json"),
  property: join(ROOT, "site/data/property_domain_observations.json"),
  meetings: join(ROOT, "site/data/meetings_domain_observations.json"),
  rules: join(ROOT, "site/data/rules_domain_observations.json"),
  money: join(ROOT, "site/data/ocp_awards_warehouse_lookup.json"),
};

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function build() {
  const boundaries = loadJson(PATHS.boundaries);
  if (!boundaries?.boundary_vintage) {
    throw new Error("missing site/data/district_boundaries.json with boundary_vintage");
  }
  const zap = loadJson(PATHS.zap);
  const property = loadJson(PATHS.property);
  const meetings = loadJson(PATHS.meetings);
  const rules = loadJson(PATHS.rules);
  const money = loadJson(PATHS.money);

  return buildDistrictActivity({
    boundaries,
    zapRows: Array.isArray(zap?.rows) ? zap.rows : [],
    propertyRows: Array.isArray(property?.property_rows) ? property.property_rows : [],
    meetingsRows: Array.isArray(meetings?.rows) ? meetings.rows : [],
    rulesRows: Array.isArray(rules?.rows) ? rules.rows : [],
    moneyRows: Array.isArray(money?.rows) ? money.rows : [],
    builtAt: new Date().toISOString(),
  });
}

function check(doc) {
  if (!doc || doc.schema !== DISTRICT_ACTIVITY_SCHEMA) {
    throw new Error("district_activity schema mismatch");
  }
  if (!doc.boundary_vintage) throw new Error("missing boundary_vintage");
  if (!doc.by_level?.borough || !doc.by_level?.community_district || !doc.by_level?.council_district) {
    throw new Error("missing by_level bags");
  }
  const boroughKeys = Object.keys(doc.by_level.borough);
  if (boroughKeys.length < 5) throw new Error("expected 5 boroughs");
  const cdKeys = Object.keys(doc.by_level.community_district);
  if (cdKeys.length < 50) throw new Error("expected regular community districts");
  const councilKeys = Object.keys(doc.by_level.council_district);
  if (councilKeys.length < 51) throw new Error("expected 51 council districts");
  // At least land + property should have some located rows.
  if ((doc.sources?.land?.located || 0) < 1) {
    throw new Error("expected some located land activity");
  }
  if ((doc.sources?.property?.located || 0) < 1) {
    throw new Error("expected some located property activity");
  }
}

function writeTwin(doc) {
  const text = JSON.stringify(doc) + "\n";
  mkdirSync(dirname(SITE_OUT), { recursive: true });
  writeFileSync(SITE_OUT, text);
  mkdirSync(dirname(WORKER_OUT), { recursive: true });
  writeFileSync(WORKER_OUT, text);
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

if (checkOnly) {
  const existing = loadJson(SITE_OUT);
  if (!existing) {
    console.error("missing", SITE_OUT);
    process.exit(1);
  }
  check(existing);
  // Rebuild and compare shape invariants (not full byte equality — built_at moves).
  const fresh = build();
  check(fresh);
  if (existing.boundary_vintage !== fresh.boundary_vintage) {
    console.error("boundary_vintage drift vs boundary layer");
    process.exit(1);
  }
  console.log("district_activity ok", {
    boundary_vintage: existing.boundary_vintage,
    land_located: existing.sources?.land?.located,
    property_located: existing.sources?.property?.located,
  });
  process.exit(0);
}

const doc = build();
check(doc);
writeTwin(doc);
console.log("wrote", SITE_OUT, {
  boundary_vintage: doc.boundary_vintage,
  sources: doc.sources,
});
