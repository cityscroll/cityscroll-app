#!/usr/bin/env node

import {
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const GENERATION_OUTPUT_RECEIPT_SCHEMA = "cityscroll.generation-output-receipt.v1";
export const DEFAULT_GENERATION_OUTPUT_RECEIPT = ".artifacts/generation-output-receipt.json";

function outputPath(output) {
  return typeof output === "string" ? output : output?.path;
}

function labelPath(rootDir, path) {
  const label = relative(rootDir, path).replaceAll("\\", "/");
  return label && !label.startsWith("../") && label !== ".." ? label : path;
}

export function inspectGenerationOutputs({ rootDir = process.cwd(), outputs = [] } = {}) {
  const root = resolve(rootDir);
  const findings = [];
  const expectedArtifacts = outputs.map(outputPath).filter(Boolean).map((path) => {
    const resolvedPath = resolve(root, path);
    return { path: resolvedPath, label: labelPath(root, resolvedPath) };
  });

  for (const artifact of expectedArtifacts) {
    let stat;
    try {
      stat = statSync(artifact.path);
    } catch {
      findings.push(`missing generated output: ${artifact.label}`);
      continue;
    }
    if (!stat.isFile()) {
      findings.push(`generated output is not a file: ${artifact.label}`);
    } else if (stat.size === 0) {
      findings.push(`generated output is empty: ${artifact.label}`);
    }
  }

  return {
    expectedArtifacts: expectedArtifacts.map(({ label }) => label),
    findings,
  };
}

export function writeGenerationOutputReceipt({
  receiptPath = resolve(process.cwd(), DEFAULT_GENERATION_OUTPUT_RECEIPT),
  boundary,
  status,
  expectedArtifacts,
  findings = [],
} = {}) {
  const receipt = {
    schema: GENERATION_OUTPUT_RECEIPT_SCHEMA,
    boundary: boundary || "unknown",
    status,
    expected_artifacts: expectedArtifacts,
    findings,
    generated_at: new Date().toISOString(),
  };
  mkdirSync(dirname(resolve(receiptPath)), { recursive: true });
  writeFileSync(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export function assertGeneratedOutputs({
  rootDir = process.cwd(),
  boundary,
  outputs,
  receiptPath = process.env.GENERATION_OUTPUT_RECEIPT
    || resolve(rootDir, DEFAULT_GENERATION_OUTPUT_RECEIPT),
} = {}) {
  const result = inspectGenerationOutputs({ rootDir, outputs });
  const status = result.findings.length ? "failed" : "passed";
  writeGenerationOutputReceipt({
    receiptPath,
    boundary,
    status,
    expectedArtifacts: result.expectedArtifacts,
    findings: result.findings,
  });

  if (result.findings.length) {
    throw new Error(
      `generation output guard failed at ${boundary}: ${result.findings.join("; ")}. `
      + `Expected artifact(s): ${result.expectedArtifacts.join(", ")}`,
    );
  }
  return result;
}
