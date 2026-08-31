import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkRepository, classifyInstructionText, validateCeilingPolicy } from "../tools/agents_router_guard.mjs";

const fixture = (name) => readFileSync(new URL(`fixtures/agents-router/${name}`, import.meta.url), "utf8");

for (const [name, expected] of [
  ["negative/card-heading.md", "card-heading"],
  ["negative/rollout-history.md", "rollout-history"],
  ["negative/mutable-status.md", "mutable-status-ledger"],
  ["negative/duplicate-module-catalog.md", "duplicated-module-catalog"],
]) {
  test(`rejects ${name}`, () => {
    assert.ok(classifyInstructionText(fixture(name)).some((finding) => finding.id === expected));
  });
}

for (const name of [
  "positive/accepted-adr-reference.md",
  "positive/current-maintainer-instruction.md",
  "positive/test-reference.md",
  "positive/fixture-reference.md",
  "positive/code-coupled-evidence.md",
]) {
  test(`permits ${name}`, () => {
    assert.deepEqual(classifyInstructionText(fixture(name)), []);
  });
}

test("ceiling ratchets downward and rejects an increase", () => {
  const base = {
    schema: "cityscroll.agents_router_policy.v1",
    initial_ceiling_bytes: 12000,
    ceiling_history_bytes: [12000],
    max_bytes: 12000,
  };
  assert.deepEqual(validateCeilingPolicy({ ...base, ceiling_history_bytes: [12000, 11000], max_bytes: 11000 }), []);
  assert.ok(validateCeilingPolicy({ ...base, ceiling_history_bytes: [12000, 13000], max_bytes: 13000 }).some((finding) => finding.includes("increase")));
});

test("clean repository router, instruction inventory, pointers, and receipt pass", () => {
  assert.deepEqual(checkRepository(), []);
});
