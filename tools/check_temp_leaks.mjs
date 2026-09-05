#!/usr/bin/env node
// Fails closed when a test suite leaves scratch directories behind in the
// system temp directory ($TMPDIR). Interrupted, killed-by-timeout, or
// assertion-failing runs skip the `finally`/`with` cleanup in whatever they
// were building, and residue like that is what pushed a shared machine under
// its disk safety floor once already: 24,797 entries and 11.5 GB of finished
// test scratch from this repository, in one measurement.
//
// Usage:
//   node tools/check_temp_leaks.mjs snapshot --out <path>
//   node tools/check_temp_leaks.mjs check --in <path> [--label <name>]
//
// `snapshot` records the current top-level entries of $TMPDIR (minus a small,
// explicit allowlist of names this repository does not own). `check` re-lists
// the same directory and fails if any entry present now was absent at
// snapshot time - a leak, reported by name so it is attributable.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

// Names this repository's suites do not create, so a leftover with one of
// these names is not evidence of a leak here:
//   - playwright / playwright_chromiumdev_profile*: Playwright removes its own
//     download and browser-profile scratch as it reads it, and any residual
//     directory belongs to Playwright's own lifecycle, not a suite in this repo.
//   - dotfiles and platform bookkeeping entries (`.com.apple.*`, `.Trash`, etc.).
// A shared machine may also host unrelated tools' scratch; extend this list with
// an anchored prefix pattern rather than widening a check meant to catch new growth.
const IGNORE_PATTERNS = [
  /^playwright/,
  /^playwright_chromiumdev_profile/,
  /^\./,
  /^com\.apple/,
];

function isIgnored(name) {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(name));
}

function listEntries(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !isIgnored(name))
    .sort();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--out" || arg === "--in") {
      options.path = rest[i + 1];
      i += 1;
    } else if (arg === "--label") {
      options.label = rest[i + 1];
      i += 1;
    }
  }
  return { command, ...options };
}

function main() {
  const { command, path, label } = parseArgs(process.argv.slice(2));
  const dir = tmpdir();

  if (command === "snapshot") {
    if (!path) {
      console.error("check_temp_leaks.mjs snapshot requires --out <path>");
      process.exit(2);
    }
    const entries = listEntries(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ tmpdir: dir, entries }, null, 2) + "\n");
    console.log(`check_temp_leaks: snapshotted ${entries.length} entries under ${dir}`);
    return;
  }

  if (command === "check") {
    if (!path) {
      console.error("check_temp_leaks.mjs check requires --in <path>");
      process.exit(2);
    }
    const before = JSON.parse(readFileSync(path, "utf8"));
    const beforeSet = new Set(before.entries);
    const after = listEntries(before.tmpdir);
    const leaked = after.filter((name) => !beforeSet.has(name));
    const suite = label ? ` (${label})` : "";
    if (leaked.length > 0) {
      console.error(`check_temp_leaks: ${leaked.length} leaked temp director${leaked.length === 1 ? "y" : "ies"}${suite} under ${before.tmpdir}:`);
      for (const name of leaked) {
        console.error(`  ${name}`);
      }
      console.error("A test or tool left scratch behind: add cleanup (see tools/lib/with_temp_dir.mjs / tools/lib/temp_workspace.py).");
      process.exit(1);
    }
    console.log(`check_temp_leaks: no leaks${suite} (${after.length} pre-existing entries unchanged)`);
    return;
  }

  console.error("Usage: node tools/check_temp_leaks.mjs snapshot --out <path> | check --in <path> [--label <name>]");
  process.exit(2);
}

main();
