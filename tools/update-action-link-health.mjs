#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { applyAuditVerdicts, renderBrowserHealthState } from "./lib/action_link_health.mjs";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readJson(path, fallback = {}) {
  if (!path) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function main() {
  const reportPath = argumentValue("--report");
  const previousPath = argumentValue("--previous");
  const outputPath = argumentValue("--output");
  const scriptOutputPath = argumentValue("--script-output");
  const escalationAfter = Number(argumentValue("--escalation-after") || 2);
  if (!reportPath || !outputPath || !scriptOutputPath) {
    throw new Error("usage: update-action-link-health --report <json> --previous <json> --output <json> --script-output <js>");
  }
  const report = await readJson(reportPath);
  const previous = await readJson(previousPath);
  const state = applyAuditVerdicts(report, previous, { escalationAfter });
  await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(scriptOutputPath, renderBrowserHealthState(state), "utf8");
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
