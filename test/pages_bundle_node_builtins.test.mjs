import assert from "node:assert/strict";
import test from "node:test";
import { findPagesBundleNodeBuiltins } from "../tools/check_pages_bundle_node_builtins.mjs";

test("Pages Function import graph contains no Node built-ins", async () => {
  const result = await findPagesBundleNodeBuiltins();
  assert.deepEqual(result.violations, []);
  assert.ok(result.files.length > 1);
});
