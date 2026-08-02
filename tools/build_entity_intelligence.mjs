#!/usr/bin/env node
/**
 * Materialize cross-domain entity intelligence lookup (instant serve path).
 *
 * Usage:
 *   node tools/build_entity_intelligence.mjs
 *   node tools/build_entity_intelligence.mjs --check
 *   node tools/build_entity_intelligence.mjs --print-demo
 *
 * Reads warehouse fixtures + existing site warehouse lookups + domain seed
 * observations. Does not download bulk data. CPU-light pure JS.
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

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const printDemo = args.includes("--print-demo");

  const full = buildEntityIntelligenceDoc(ROOT);
  const slim = slimDocForWorker(full);

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
    if (!existsSync(OUT_SITE) || !existsSync(OUT_WORKER)) {
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
    console.log(
      `entity intelligence ok: entities=${site.entity_count} multi_domain=${site.multi_domain_count}`,
    );
    return;
  }

  mkdirSync(path.dirname(OUT_SITE), { recursive: true });
  mkdirSync(path.dirname(OUT_WORKER), { recursive: true });
  const body = `${JSON.stringify(slim, null, 2)}\n`;
  writeFileSync(OUT_SITE, body);
  writeFileSync(OUT_WORKER, body);
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
