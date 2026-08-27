#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionText,
} from "../site/source_health_public_projection.mjs";

export const CONTRACTS_PATH = fileURLToPath(
  new URL("../site/data/source_contracts.json", import.meta.url),
);
export const OBSERVATIONS_PATH = fileURLToPath(
  new URL("../site/data/source_health_observations.json", import.meta.url),
);
export const OUTPUT_PATH = fileURLToPath(
  new URL("../site/data/source_health_public.json", import.meta.url),
);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function optionValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function evidenceHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function generatePublicSourceHealthProjection(options = {}) {
  const registry = options.registry || readJson(CONTRACTS_PATH);
  const observations = options.observations || readJson(OBSERVATIONS_PATH);
  return buildPublicSourceHealthProjection(registry, observations);
}

export function checkPublicSourceHealthProjection(options = {}) {
  const expected = publicSourceHealthProjectionText(generatePublicSourceHealthProjection(options));
  const outputPath = options.outputPath || OUTPUT_PATH;
  let actual = null;
  try {
    actual = readFileSync(outputPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ["site/data/source_health_public.json is missing; generated source-health evidence cannot be delivered"];
    }
    return [`site/data/source_health_public.json cannot be read: ${error?.message || error}`];
  }
  if (actual === expected) return [];

  let parsed = null;
  try { parsed = JSON.parse(actual); } catch {}
  if (!parsed) {
    return ["site/data/source_health_public.json is invalid; generated source-health evidence cannot be checked"];
  }
  const generatedAt = parsed.generated_at || "missing generated_at";
  const expectedAt = options.observations?.generated_at || "current source-health receipt";
  return [
    `site/data/source_health_public.json is stale: generated source-health evidence (${generatedAt}) does not match ${expectedAt}; expected evidence hash ${evidenceHash(expected)}, found ${evidenceHash(actual)}`,
  ];
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const contractsPath = optionValue(argv, "--contracts", CONTRACTS_PATH);
  const observationsPath = optionValue(argv, "--observations", OBSERVATIONS_PATH);
  const outputPath = optionValue(argv, "--output", OUTPUT_PATH);
  const valueOptions = new Set(["--contracts", "--observations", "--output"]);
  const unknown = argv.filter((arg, index) => (
    arg !== "--check"
    && !valueOptions.has(arg)
    && argv[index - 1] !== "--contracts"
    && argv[index - 1] !== "--observations"
    && argv[index - 1] !== "--output"
  ));
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  const options = {
    registry: readJson(contractsPath),
    observations: readJson(observationsPath),
    outputPath,
  };
  if (check) {
    const findings = checkPublicSourceHealthProjection(options);
    if (findings.length) {
      for (const finding of findings) console.error(finding);
      process.exitCode = 1;
      return;
    }
    console.log("public source health projection is current");
    return;
  }
  const projection = generatePublicSourceHealthProjection(options);
  writeFileSync(outputPath, publicSourceHealthProjectionText(projection));
  console.log(`wrote ${projection.source_count} public source health rows`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
