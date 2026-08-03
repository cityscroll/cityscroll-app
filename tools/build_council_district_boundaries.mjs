#!/usr/bin/env node
// Compat entrypoint: council district boundaries are built as part of the
// unified district boundary layer (community + council). Prefer:
//   node tools/build_district_boundaries.mjs
//
// This script forwards --check / --fixture / live build to that tool so older
// docs and CI references keep working.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "tools/build_district_boundaries.mjs");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [TARGET, ...args], {
  stdio: "inherit",
  cwd: ROOT,
});
process.exitCode = result.status == null ? 1 : result.status;
