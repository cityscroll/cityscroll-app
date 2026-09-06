#!/usr/bin/env node
/**
 * Bounded warehouse-side acquisition for priority sources that the scheduled
 * rematerialization rail would otherwise rebuild from an old snapshot.
 * Refuses undocumented bulk ingest.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PRIORITY_SOURCE_FAMILIES } from "./priority_source_health_closure.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RECEIPT_PATH = "warehouse/receipts/proof/priority_source_bounded_acquisition_latest.json";

const FORBIDDEN = [/--bulk/, /--ack-large/];

export const BOUNDED_ACQUISITIONS = Object.freeze([
  {
    family_id: "zap-projects",
    source_contract_id: "zap-projects",
    command: ["warehouse/.venv/bin/python", "warehouse/scripts/ingest.py", "--dataset", "zap-projects", "--limit", "50"],
  },
  {
    family_id: "community-board-minutes",
    source_contract_id: "non-council-board-minutes",
    command: ["node", "warehouse/scripts/non_council_outcomes.mjs", "--limit", "1", "--max-docs", "1"],
  },
]);

export function assertBoundedCommand(command) {
  const text = command.join(" ");
  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) throw new Error(`refusing unbounded ingest: ${text}`);
  }
  return command;
}

export function runBoundedAcquisitions(options = {}) {
  const root = options.root || ROOT;
  const spawn = options.spawn || spawnSync;
  const now = options.now || new Date().toISOString();
  const commands = [];
  for (const job of BOUNDED_ACQUISITIONS) {
    assertBoundedCommand(job.command);
    const executable = job.command[0] === "node" ? process.execPath : join(root, job.command[0]);
    const args = job.command[0] === "node"
      ? [join(root, job.command[1]), ...job.command.slice(2)]
      : job.command.slice(1);
    if (job.command[0] !== "node" && !existsSync(executable) && options.spawn == null) {
      commands.push({
        ...job,
        status: "skipped",
        reason: "warehouse-python-unavailable",
        exit_code: null,
      });
      continue;
    }
    const result = spawn(executable, args, { cwd: root, stdio: options.stdio || "inherit" });
    commands.push({
      ...job,
      status: result?.error || result?.status !== 0 ? "failed" : "succeeded",
      exit_code: result?.status ?? null,
    });
  }
  return {
    schema: "cityscroll.priority_source_bounded_acquisition.v1",
    generated_at: now,
    families: PRIORITY_SOURCE_FAMILIES.map((row) => row.id),
    commands,
  };
}

function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--bounded")) throw new Error("refusing to run without --bounded");
  const receipt = runBoundedAcquisitions();
  const path = join(ROOT, RECEIPT_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${RECEIPT_PATH} status=${receipt.commands.every((row) => row.status !== "failed") ? "ok" : "partial"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
