#!/usr/bin/env node
// Build the retained materialization of published city-agency entity records.
//
// Inputs are already-acquired, committed snapshots: the agency identity
// crosswalk (which carries each source dataset's own last-updated date), the
// agency constellation rollup, and the award-corroborated public contract
// census. Nothing here reaches a publisher; the request path never does either.
//
// Run:  node tools/build_agency_entity_publication.mjs
//       node tools/build_agency_entity_publication.mjs --check   (staleness gate)

import { createHash, } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENCY_ENTITY_PUBLICATION_SCHEMA,
  buildAgencyEntityPublication,
} from "../site/agency_entity_publication.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS = {
  crosswalk: "worker/src/data/agency_crosswalk.json",
  constellation: "site/data/agency_constellation_lookup.json",
  contractGraph: "worker/src/data/passport_ei_graph.json",
};
const OUTPUTS = [
  "site/data/agency_entity_publication.json",
  "worker/src/data/agency_entity_publication.json",
];
const RECEIPT = "site/data/agency_sources/verification_receipts/agency_entity_publication.json";

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The publication is stamped with the hash of the snapshots it was built from. */
async function inputDigest() {
  const hash = createHash("sha256");
  for (const relative of Object.values(INPUTS)) {
    hash.update(await readFile(path.join(ROOT, relative)));
  }
  return hash.digest("hex");
}

function receiptFor(doc, digest, serialized) {
  const withLeader = Object.values(doc.agencies)
    .filter((record) => record.graph.edges.some((edge) => edge.type === "agency_led_by")).length;
  const withContracts = Object.values(doc.agencies)
    .filter((record) => record.graph.edges.some((edge) => edge.type === "published_by_agency")).length;
  return {
    schema: "cityscroll.agency_entity_publication_receipt.v1",
    publication_schema: doc.schema,
    method: doc.method,
    generated_at: doc.generated_at,
    input_digest: `sha256:${digest}`,
    publication_digest: `sha256:${sha256(serialized)}`,
    sources: doc.sources.map((source) => ({
      system: source.system,
      id: source.id,
      observed_on: source.observed_on,
      provides: source.provides,
    })),
    coverage: {
      ...doc.coverage,
      agencies_with_principal_officer_edge: withLeader,
      agencies_with_published_contract_edge: withContracts,
    },
  };
}

async function main() {
  const [crosswalk, constellation, contractGraph] = await Promise.all([
    readJson(INPUTS.crosswalk),
    readJson(INPUTS.constellation),
    readJson(INPUTS.contractGraph),
  ]);
  const digest = await inputDigest();
  const doc = buildAgencyEntityPublication({
    crosswalk,
    constellation,
    contractGraph,
    // The publication clock is the inputs, not the build machine: the same
    // snapshots always produce the same bytes.
    generatedAt: contractGraph?.generated_at || null,
  });
  if (doc.schema !== AGENCY_ENTITY_PUBLICATION_SCHEMA) throw new Error("unexpected publication schema");
  if (!doc.coverage.published_agency_count) throw new Error("no agency entity records were published");
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  const receipt = `${JSON.stringify(receiptFor(doc, digest, serialized), null, 2)}\n`;

  if (process.argv.includes("--check")) {
    for (const output of OUTPUTS) {
      if (await readFile(path.join(ROOT, output), "utf8") !== serialized) {
        throw new Error(`stale agency entity publication: ${output}`);
      }
    }
    if (await readFile(path.join(ROOT, RECEIPT), "utf8") !== receipt) {
      throw new Error("stale agency entity publication receipt");
    }
    console.log(`agency entity publication ok agencies=${doc.coverage.published_agency_count}`);
    return;
  }

  for (const output of [...OUTPUTS, RECEIPT]) {
    mkdirSync(path.dirname(path.join(ROOT, output)), { recursive: true });
  }
  for (const output of OUTPUTS) await writeFile(path.join(ROOT, output), serialized);
  await writeFile(path.join(ROOT, RECEIPT), receipt);
  console.log(JSON.stringify({
    outputs: OUTPUTS,
    receipt: RECEIPT,
    published_agency_count: doc.coverage.published_agency_count,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
