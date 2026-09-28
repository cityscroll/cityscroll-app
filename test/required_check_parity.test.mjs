import assert from "node:assert/strict";
import { test } from "node:test";

import { compareRequiredCheckParity } from "../tools/audit-required-check-parity.mjs";

const ciWith = (command) => [
  "  unit-family:",
  "    steps:",
  `        run: ${command}`,
  "  a11y-pr-shard:",
  "    steps:",
  "  required-functional-shard:",
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

test("required-check parity reports a local functional command missing from hosted CI", () => {
  const result = compareRequiredCheckParity({
    ciSource: ciWith("node --test test/example.test.mjs"),
    preflightSource: "run_and_fail python3 test/functional/example.py\n",
  });
  assert.deepEqual(result.missingHostedFunctional, [
    "python3 test/functional/example.py",
  ]);
});

test("required-check parity recognizes functional checks behind the retry wrapper", () => {
  const result = compareRequiredCheckParity({
    ciSource: ciWith("node --test test/example.test.mjs"),
    preflightSource: "run_and_fail python3 test/functional/example.py --land-canary\n",
    a11yShardRunnerSource: "tools/run_a11y_functional_check.sh example python3 test/functional/example.py --land-canary\n",
  });
  assert.deepEqual(result.missingHostedFunctional, []);
});
