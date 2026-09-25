#!/usr/bin/env node
/**
 * Compatibility entrypoint for segmented meeting detail capture (alias cb0c04802e711).
 *
 * The production A5 harness lives in capture_segmented_meeting_detail.py: it drives
 * the served site in a real browser at 1440/390 with scripting on and off, records
 * falsifiable per-row observations, traverses keyboard focus to a segment anchor,
 * and refuses capture until the served revision contains the delivery ancestor.
 *
 * This Node wrapper forwards argv to that Python tool so existing call sites keep
 * working.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = join(ROOT, "tools/capture_segmented_meeting_detail.py");

const result = spawnSync("python3", [PY, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else {
  process.exitCode = result.status == null ? 1 : result.status;
}
