#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  evaluateAllMeterRelease,
  evaluateWarehouseExperiment,
  validateWorkerCostProfile,
} from "./lib/worker_cost_control.mjs";

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const command = process.argv[2];
let result;
if (command === "profile-check") {
  const input = arg("--input");
  if (!input) throw new Error("profile-check requires --input");
  result = validateWorkerCostProfile(read(input));
} else if (command === "warehouse-evaluate") {
  const baseline = arg("--baseline");
  const candidate = arg("--candidate");
  if (!baseline || !candidate) throw new Error("warehouse-evaluate requires --baseline and --candidate");
  result = evaluateWarehouseExperiment({ baseline: read(baseline), candidate: read(candidate) });
} else if (command === "release-evaluate") {
  const baseline = arg("--baseline");
  const candidate = arg("--candidate");
  if (!baseline || !candidate) throw new Error("release-evaluate requires --baseline and --candidate");
  result = evaluateAllMeterRelease({ baseline: read(baseline), candidate: read(candidate) });
  if (!result.pass) process.exitCode = 1;
} else {
  throw new Error("usage: worker_cost_control.mjs <profile-check|warehouse-evaluate|release-evaluate> [options]");
}
console.log(JSON.stringify(result, null, 2));
