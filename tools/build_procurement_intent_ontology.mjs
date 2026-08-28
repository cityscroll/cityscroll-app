#!/usr/bin/env node

/** Materialize PIR-2's prospective three-object ontology from PIR-1 output. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProspectiveProcess, validateProspectiveProcess } from "../ontology/procurement_intent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = join(ROOT, "warehouse/fixtures/procurement-intent-radar/candidate_review.v0.json");
const DEFAULT_OUTPUT = join(ROOT, "warehouse/fixtures/procurement-intent-radar/prospective_ontology.v0.json");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function buildArtifactObject(input) {
  const source = JSON.parse(readFileSync(resolve(input), "utf8"));
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const candidates = rows.filter((row) => row?.status === "candidate" && row.assertion && row.source);
  const processes = candidates.map((row) => buildProspectiveProcess({ source: row.source, assertion: row.assertion }));
  processes.forEach(validateProspectiveProcess);
  return {
    schema: "cityscroll.procurement_intent_radar.prospective_ontology.v0",
    ontology_version: "0.1.0",
    source_policy: "prospective-only; source and assertion supplied by PIR-1; no solicitation acquisition, realization joins, or downstream identity lookup",
    input_artifact: input === DEFAULT_INPUT ? "warehouse/fixtures/procurement-intent-radar/candidate_review.v0.json" : resolve(input),
    process_count: processes.length,
    processes,
  };
}

export function buildArtifact({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT } = {}) {
  const artifact = buildArtifactObject(input);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function checkArtifact({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT } = {}) {
  const expected = buildArtifactObject(input);
  if (!existsSync(resolve(output))) throw new Error("prospective ontology artifact is missing; rebuild without --check");
  const actual = readFileSync(resolve(output), "utf8");
  if (actual !== `${JSON.stringify(expected, null, 2)}\n`) throw new Error("prospective ontology artifact is stale; rebuild without --check");
  return expected;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_procurement_intent_ontology.mjs")) {
  const input = argument("--input", DEFAULT_INPUT);
  const output = argument("--output", DEFAULT_OUTPUT);
  const artifact = process.argv.includes("--check") ? checkArtifact({ input, output }) : buildArtifact({ input, output });
  console.log(`${process.argv.includes("--check") ? "checked" : "wrote"} ${output} processes=${artifact.process_count}`);
}
