#!/usr/bin/env node

import { availableParallelism, cpus, loadavg } from "node:os";
import { pathToFileURL } from "node:url";

// At this ratio every available CPU is already running work or has work queued.
export const MAX_LOAD_PER_CPU = 1;

export function homeColdLoadDecision({
  loadAverage,
  cpuCount,
  maxLoadPerCpu = MAX_LOAD_PER_CPU,
}) {
  if (!Number.isFinite(loadAverage) || loadAverage < 0) {
    throw new TypeError("loadAverage must be a non-negative finite number");
  }
  if (!Number.isInteger(cpuCount) || cpuCount < 1) {
    throw new TypeError("cpuCount must be a positive integer");
  }
  if (!Number.isFinite(maxLoadPerCpu) || maxLoadPerCpu <= 0) {
    throw new TypeError("maxLoadPerCpu must be a positive finite number");
  }

  const loadPerCpu = loadAverage / cpuCount;
  return {
    skip: loadPerCpu >= maxLoadPerCpu,
    loadAverage,
    cpuCount,
    loadPerCpu,
  };
}

export function highLoadNote(decision) {
  return `preflight: SKIP home.cold performance fixture — high machine load (1m loadavg ${decision.loadAverage.toFixed(2)} across ${decision.cpuCount} cores); CI's Performance budgets (20-sample p95) job is the measurement.`;
}

function localCpuCount() {
  return typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
}

export function main() {
  const decision = homeColdLoadDecision({
    loadAverage: loadavg()[0],
    cpuCount: localCpuCount(),
  });
  if (decision.skip) {
    console.error(highLoadNote(decision));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
