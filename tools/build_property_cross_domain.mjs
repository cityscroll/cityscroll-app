#!/usr/bin/env node
/**
 * Materialize property cross-domain joins (BBL → ZAP, owner → contracts, agency).
 *
 *   node tools/build_property_cross_domain.mjs
 *   node tools/build_property_cross_domain.mjs --check
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPropertyCrossDomainDoc,
  buildParcelIntelligence,
} from "../entity_resolution/cross_domain/index.mjs";
import {
  loadCsvIfExists,
  loadJsonIfExists,
} from "./lib/entity_intelligence_build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = join(ROOT, "site/data/property_cross_domain_lookup.json");
const OUT_WORKER = join(ROOT, "worker/src/data/property_cross_domain_lookup.json");
const FIXTURE = join(ROOT, "worker/test/fixtures/property-cross-domain/corpus.json");

function collectCorpus(root) {
  const fixture = loadJsonIfExists(FIXTURE) || {};
  const propertyRows = [...(fixture.property_rows || [])];
  const zapBblRows = [...(fixture.zap_bbl_rows || [])];
  const zapProjects = [...(fixture.zap_projects || [])];
  const moneyRows = [...(fixture.money_rows || [])];

  for (const p of [
    join(root, "warehouse/fixtures/zap-bbl/sample.csv"),
    join(root, "warehouse/fixtures/zap-bbl/product_seed.csv"),
  ]) {
    for (const row of loadCsvIfExists(p)) {
      if (row.project_id && row.bbl) zapBblRows.push({ ...row, source_system: "zap-bbl" });
    }
  }

  const multi = loadJsonIfExists(
    join(root, "test/fixtures/property_disposition/multi_notice_bbl.json"),
  );
  if (multi?.notices) {
    for (const n of multi.notices) {
      propertyRows.push({ ...n, section_name: n.section_name || "Property Disposition" });
    }
  }

  for (const p of [
    join(root, "warehouse/fixtures/ocp-recent-contract-awards/product_seed.csv"),
    join(root, "warehouse/fixtures/ocp-recent-contract-awards/sample.csv"),
  ]) {
    for (const row of loadCsvIfExists(p)) moneyRows.push(row);
  }
  const ocpLookup = loadJsonIfExists(join(root, "site/data/ocp_awards_warehouse_lookup.json"));
  if (ocpLookup?.rows) {
    for (const row of ocpLookup.rows.slice(0, 200)) moneyRows.push(row);
  }

  for (const p of [
    join(root, "warehouse/fixtures/zap-projects/product_seed.csv"),
    join(root, "warehouse/fixtures/zap-projects/sample.csv"),
  ]) {
    for (const row of loadCsvIfExists(p)) zapProjects.push(row);
  }

  return { propertyRows, zapBblRows, zapProjects, moneyRows };
}

function main() {
  const check = process.argv.includes("--check");
  const corpus = collectCorpus(ROOT);
  const doc = buildPropertyCrossDomainDoc(corpus);

  const demoBbls = ["1006440001", "3025180036", "3044440001"];
  const demos = {};
  for (const bbl of demoBbls) {
    demos[bbl] = buildParcelIntelligence(bbl, corpus);
  }
  const out = {
    ...doc,
    demos,
    demo_bbls: demoBbls,
  };

  if (check) {
    if (!existsSync(OUT_SITE)) {
      console.error("missing", OUT_SITE);
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(OUT_SITE, "utf8"));
    const a = JSON.stringify({
      version: existing.version,
      metrics: existing.metrics,
      demo_bbls: existing.demo_bbls,
    });
    const b = JSON.stringify({
      version: out.version,
      metrics: out.metrics,
      demo_bbls: out.demo_bbls,
    });
    if (a !== b) {
      console.error("property_cross_domain_lookup.json drift — re-run without --check");
      process.exit(1);
    }
    console.log("property cross-domain lookup OK", out.metrics);
    return;
  }

  mkdirSync(dirname(OUT_SITE), { recursive: true });
  mkdirSync(dirname(OUT_WORKER), { recursive: true });
  const text = `${JSON.stringify(out, null, 2)}\n`;
  writeFileSync(OUT_SITE, text);
  writeFileSync(OUT_WORKER, text);
  console.log(
    "wrote property cross-domain lookup",
    OUT_SITE,
    "bbls",
    Object.keys(out.by_bbl || {}).length,
    "metrics",
    out.metrics,
  );
}

main();
