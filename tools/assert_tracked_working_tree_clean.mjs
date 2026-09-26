#!/usr/bin/env node
/**
 * Fail when the working tree has tracked-file modifications.
 * Used by the Time-travel CI job after the shifted suite so evidence
 * writers cannot leave residue on tracked fixtures.
 *
 *   node tools/assert_tracked_working_tree_clean.mjs
 */

import { assertTrackedWorkingTreeClean } from "../test/helpers/tracked_working_tree.mjs";

try {
  assertTrackedWorkingTreeClean();
  process.stdout.write("tracked working tree clean\n");
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}
