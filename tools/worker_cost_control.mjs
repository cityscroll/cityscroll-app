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

function evidence(pathFlag, envFlag) {
  const path = arg(pathFlag);
  const envName = arg(envFlag);
  if (path && envName) throw new Error(`${pathFlag} and ${envFlag} are mutually exclusive`);
  if (path) return read(path);
  if (envName) {
    const value = process.env[envName];
    if (!value) throw new Error(`${envName} is required`);
    return JSON.parse(value);
  }
  throw new Error(`one of ${pathFlag} or ${envFlag} is required`);
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
  const baseline = evidence("--baseline", "--baseline-env");
  const candidate = evidence("--candidate", "--candidate-env");
  const trustedBaseline = evidence("--trusted-baseline-deployment", "--trusted-baseline-deployment-env");
  const trustedCandidate = evidence("--trusted-candidate-deployment", "--trusted-candidate-deployment-env");
  const expectedCandidateRevision = arg("--expected-candidate-revision");
  if (expectedCandidateRevision && candidate.deployed_revision !== expectedCandidateRevision) {
    throw new Error("candidate evidence revision does not match the release revision");
  }
  result = evaluateAllMeterRelease({
    baseline,
    candidate,
    trustedDeployments: { baseline: trustedBaseline, candidate: trustedCandidate },
  });
  if (!result.pass) process.exitCode = 1;
} else {
  throw new Error("usage: worker_cost_control.mjs <profile-check|warehouse-evaluate|release-evaluate> [options]");
}
console.log(JSON.stringify(result, null, 2));
