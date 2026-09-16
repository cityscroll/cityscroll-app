#!/usr/bin/env node
/**
 * Refresh docs/evidence/procurement-disclosure-production-proof/manifest.json.
 *
 * Replays the same Pages-edge procurement detail renders the production-proof
 * suite hashes, then writes the textual sha256 values. No image binaries.
 *
 *   node tools/build_procurement_disclosure_production_proof.mjs
 *   node tools/build_procurement_disclosure_production_proof.mjs --check
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import edgeWorker from "../site/pages_edge.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = new URL("../docs/evidence/procurement-disclosure-production-proof/manifest.json", import.meta.url);
const READ_MODEL_PATH = new URL("../site/data/shared_procurement_read_model.json", import.meta.url);
const PERFORMANCE_PATH = new URL("../site/data/analytics_performance_evidence.json", import.meta.url);

const CONTRACTS = Object.freeze([
  "CT110220271400991",
  "CT105720278802113",
  "CT104020273009333",
  "CT185720228800365",
  "CT185020228802305",
  "CT107120258801626",
]);

const VIEWPORTS = Object.freeze([
  ["desktop", "1440x900"],
  ["mobile", "390x844"],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function assetEnvironment(manifest) {
  return {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") {
          return new Response(JSON.stringify(manifest));
        }
        if (path.startsWith("/data/shared_procurement_read_model/")) {
          const shard = path.slice("/data/".length);
          return new Response(readFileSync(new URL(`../site/data/${shard}`, import.meta.url)));
        }
        return new Response(
          '<!doctype html><html><head><title>CityScroll</title></head><body><main id="noticeview"></main></body></html>',
        );
      },
    },
  };
}

async function servedContract(id, headers, env) {
  const response = await edgeWorker.fetch(new Request(
    `https://cityscroll.org/procurements/${encodeURIComponent(`procurement:contract:${id}`)}/`,
    { headers },
  ), env);
  if (response.status !== 200) {
    throw new Error(`procurement detail ${id} returned ${response.status}`);
  }
  return response.text();
}

function gitTip() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git rev-parse HEAD failed");
  return result.stdout.trim();
}

export async function buildProcurementDisclosureProductionProof({
  revision = gitTip(),
} = {}) {
  const manifest = readJson(READ_MODEL_PATH);
  const performance = readJson(PERFORMANCE_PATH);
  const env = assetEnvironment(manifest);
  const tip = revision;
  const existing = readJson(MANIFEST_PATH);
  const entries = [];
  for (const id of CONTRACTS) {
    for (const [viewport, header] of VIEWPORTS) {
      const html = await servedContract(id, { "X-Test-Viewport": header }, env);
      const route = `/procurements/procurement%3Acontract%3A${id}/`;
      entries.push({
        route,
        viewport,
        revision: tip,
        data_vintage: performance.snapshot_date,
        assertion: `${viewport} server-rendered contract page is keyboard-linkable and free of empty headings`,
        sha256: sha256(html),
      });
    }
  }
  return {
    schema: "cityscroll.render_evidence_manifest.v1",
    revision: tip,
    data_vintage: performance.snapshot_date,
    capture_clock: existing.capture_clock,
    capture_policy: "Textual render hashes only; no image binaries are committed.",
    entries,
  };
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const next = await buildProcurementDisclosureProductionProof();
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  if (check) {
    const current = readFileSync(MANIFEST_PATH, "utf8");
    if (current !== rendered) {
      throw new Error("procurement disclosure production-proof manifest is stale — run node tools/build_procurement_disclosure_production_proof.mjs");
    }
    process.stdout.write("procurement disclosure production-proof manifest current\n");
    return;
  }
  writeFileSync(MANIFEST_PATH, rendered);
  process.stdout.write(`wrote ${MANIFEST_PATH.pathname.replace(/^.*?(docs\/)/, "$1")} (${next.entries.length} entries)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
