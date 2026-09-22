import assert from "node:assert/strict";
import { test } from "node:test";

import { compareRequiredCheckParity } from "../tools/audit-required-check-parity.mjs";

const ciWith = (command) => [
  "  unit-family:",
  "    steps:",
  `        run: ${command}`,
  "  a11y-pr-shard:",
  "    steps:",
  "  browser-journeys-pr:",
  "    steps:",
  "  reading-level:",
  "    steps:",
].join("\n");

test("required-check parity recognizes the local node-test wrapper", () => {
  const result = compareRequiredCheckParity({
    ciSource: ciWith("node --test test/example.test.mjs"),
    preflightSource: "run_node_test test/example.test.mjs\n",
  });
  assert.deepEqual(result.missing, []);
});

test("required-check parity reports a hosted validation command missing locally", () => {
  const result = compareRequiredCheckParity({
    ciSource: ciWith("node tools/example_check.mjs --check"),
    preflightSource: "run_node_test test/example.test.mjs\n",
  });
  assert.deepEqual(result.missing, [{
    job: "unit-family",
    command: "node tools/example_check.mjs --check",
  }]);
});
