#!/usr/bin/env node
// Test hook, off by default.
//
// Prints a synthetic served-artifact freshness finding whose text is larger
// than the operating system's per-argument limit for starting a program. It
// exists so the owner-alert delivery path can be proved end to end against the
// real endpoint at the size that used to refuse the delivery outright, without
// waiting for a real staleness incident of that size.
//
// It is only reachable through the workflow's `force_finding` dispatch input,
// which defaults to false, so a scheduled run can never emit it.

// A single argument or environment entry is capped at 128 KiB on Linux. The
// text below clears that comfortably, so the old command-line delivery would
// have been refused before it ever reached the endpoint.
export const FORCED_FINDING_MIN_BYTES = 192 * 1024;

export function syntheticFreshnessFinding({ minBytes = FORCED_FINDING_MIN_BYTES, existingText = "" } = {}) {
  const headline = "forced served-artifact freshness finding raised to verify owner-alert delivery; this run is a delivery check, not an assessment that the served artifact is stale";
  // The headline leads and any real findings follow it, so the padding that
  // sizes the text can never push a genuine finding out of the alert.
  const existing = String(existingText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lines = [headline, ...existing];
  let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  let index = 0;
  while (bytes < minBytes) {
    index += 1;
    const line = `delivery-size verification padding line ${String(index).padStart(6, "0")}; this line only exists to size the finding text above the command-argument limit`;
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = process.argv.indexOf("--findings-file");
  const path = index >= 0 ? process.argv[index + 1] : null;
  let existingText = "";
  if (path) {
    const { readFileSync } = await import("node:fs");
    try {
      existingText = readFileSync(path, "utf8");
    } catch {
      existingText = "";
    }
  }
  process.stdout.write(syntheticFreshnessFinding({ existingText }));
}
