#!/usr/bin/env node
/**
 * Materialize cross-domain entity intelligence lookup (instant serve path).
 *
 * Usage:
 *   node tools/build_entity_intelligence.mjs
 *   node tools/build_entity_intelligence.mjs --check
 *   node tools/build_entity_intelligence.mjs --print-demo
 *
 * Reads warehouse fixtures + site warehouse lookups + live rules/meetings
 * domain observation snapshots (City Record Agency Rules + hearings). Does not
 * download bulk data at build time. CPU-light pure JS.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEntityIntelligenceDoc,
  slimDocForWorker,
} from "./lib/entity_intelligence_build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = path.join(ROOT, "site", "data", "entity_intelligence_lookup.json");
const OUT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "entity_intelligence_lookup.json",
);
const OUT_VENDOR_FOOTPRINT_EVIDENCE = path.join(
  ROOT,
  "docs",
  "evidence",
  "vendor-footprint-coverage.json",
);
const OUT_VENDOR_FOOTPRINT_SITE = path.join(
  ROOT,
  "site",
  "data",
  "vendor_footprint_coverage.json",
);
const OUT_VENDOR_FOOTPRINT_WORKER = path.join(
  ROOT,
  "worker",
  "src",
  "data",
  "vendor_footprint_coverage.json",
);

function vendorFootprintEvidence(doc) {
  const footprint = doc.vendor_footprint || {};
  return {
    schema_version: 1,
    title: "Vendor footprint coverage and promotion receipt",
    generated_at: doc.generated_at,
    status: footprint.status,
    qualifier_required: footprint.qualifier_required,
    sections: footprint.sections,
    excluded_confidence: footprint.excluded_confidence,
    summary: footprint.summary,
    promotion: footprint.promotion,
    provenance: footprint.provenance,
  };
}

function vendorFootprintCoverageIndex(doc) {
  const awardsByRef = doc.vendor_footprint?.awards_by_ref || {};
  return {
    schema_version: 1,
    generated_at: doc.generated_at,
    // Compact public index: ref|linked|eligible|rate. The route expands the
    // reader label from these build-derived values.
    rows: Object.entries(awardsByRef).map(([ref, coverage]) =>
      [ref, coverage.linked, coverage.eligible, coverage.rate ?? ""].join("|")),
  };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const printDemo = args.includes("--print-demo");

  const full = buildEntityIntelligenceDoc(ROOT);
  const slim = slimDocForWorker(full);
  const footprintEvidence = vendorFootprintEvidence(full);
  const footprintCoverage = vendorFootprintCoverageIndex(full);

  if (printDemo) {
    console.log(JSON.stringify(full.verified_demo || full.demo_refs, null, 2));
    const parksRef = full.verified_demo?.ref;
    if (parksRef && full.by_ref[parksRef]) {
      const v = full.by_ref[parksRef];
      console.log(
        "domains:",
        Object.fromEntries(
          Object.entries(v.domains).map(([k, d]) => [k, { status: d.status, count: d.count }]),
        ),
      );
      console.log("link_count", v.links?.length);
      console.log(
        "sample links",
        (v.links || []).slice(0, 6).map((l) => ({
          type: l.type,
          domain: l.domain,
          from: l.from,
          to: l.to,
          provenance: l.provenance,
        })),
      );
    }
  }

  if (check) {
    if (!existsSync(OUT_SITE) || !existsSync(OUT_WORKER)
      || !existsSync(OUT_VENDOR_FOOTPRINT_EVIDENCE)
      || !existsSync(OUT_VENDOR_FOOTPRINT_SITE)
      || !existsSync(OUT_VENDOR_FOOTPRINT_WORKER)) {
      console.error("entity intelligence lookup missing — run without --check");
      process.exit(1);
    }
    const site = JSON.parse(readFileSync(OUT_SITE, "utf8"));
    // Stable fields only (generated_at may differ)
    const strip = (d) => {
      const { generated_at, ...rest } = d;
      return rest;
    };
    const a = JSON.stringify(strip(site));
    const b = JSON.stringify(strip(slim));
    if (a !== b) {
      console.error("entity intelligence lookup drift — rebuild with tools/build_entity_intelligence.mjs");
      process.exit(1);
    }
    const committedEvidence = JSON.parse(readFileSync(OUT_VENDOR_FOOTPRINT_EVIDENCE, "utf8"));
    if (JSON.stringify(strip(committedEvidence)) !== JSON.stringify(strip(footprintEvidence))) {
      console.error("vendor footprint coverage receipt drift — rebuild with tools/build_entity_intelligence.mjs");
      process.exit(1);
    }
    for (const coveragePath of [OUT_VENDOR_FOOTPRINT_SITE, OUT_VENDOR_FOOTPRINT_WORKER]) {
      const committedCoverage = JSON.parse(readFileSync(coveragePath, "utf8"));
      if (JSON.stringify(strip(committedCoverage)) !== JSON.stringify(strip(footprintCoverage))) {
        console.error("vendor footprint coverage index drift — rebuild with tools/build_entity_intelligence.mjs");
        process.exit(1);
      }
    }
    console.log(
      `entity intelligence ok: entities=${site.entity_count} multi_domain=${site.multi_domain_count}`,
    );
    return;
  }

  mkdirSync(path.dirname(OUT_SITE), { recursive: true });
  mkdirSync(path.dirname(OUT_WORKER), { recursive: true });
  mkdirSync(path.dirname(OUT_VENDOR_FOOTPRINT_EVIDENCE), { recursive: true });
  mkdirSync(path.dirname(OUT_VENDOR_FOOTPRINT_SITE), { recursive: true });
  mkdirSync(path.dirname(OUT_VENDOR_FOOTPRINT_WORKER), { recursive: true });
  const body = `${JSON.stringify(slim, null, 2)}\n`;
  writeFileSync(OUT_SITE, body);
  writeFileSync(OUT_WORKER, body);
  writeFileSync(OUT_VENDOR_FOOTPRINT_EVIDENCE, `${JSON.stringify(footprintEvidence, null, 2)}\n`);
  const footprintBody = `${JSON.stringify(footprintCoverage)}\n`;
  writeFileSync(OUT_VENDOR_FOOTPRINT_SITE, footprintBody);
  writeFileSync(OUT_VENDOR_FOOTPRINT_WORKER, footprintBody);
  console.log(
    `wrote ${path.relative(ROOT, OUT_SITE)} and worker twin — entities=${slim.entity_count} multi_domain=${slim.multi_domain_count} observations=${slim.observation_count}`,
  );
  if (slim.verified_demo) {
    console.log(
      `verified demo: ${slim.verified_demo.display_name} (${slim.verified_demo.ref}) domains_matched=${slim.verified_demo.domains_matched}`,
    );
  }
}

main();
