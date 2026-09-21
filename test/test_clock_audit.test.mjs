import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findUninjectedClockAdditions,
  findUninjectedClockReads,
} from "../tools/audit-test-clocks.mjs";

const wallDate = `new ${"Date"}()`;
const wallNow = `Date.${"now"}()`;

test("test clock audit rejects new wall-clock reads in tests", () => {
  const diff = [
    "+++ b/test/example.test.mjs",
    "@@ -0,0 +1,2 @@",
    `+const today = ${wallDate}.toISOString().slice(0, 10);`,
    `+const expires = ${wallNow} + 86_400_000;`,
  ].join("\n");
  assert.deepEqual(
    findUninjectedClockAdditions(diff).map(({ line }) => line),
    [1, 2],
  );
});

test("test clock audit recognizes Temporal.Now as a wall-clock read", () => {
  const diff = [
    "+++ b/test/example.test.mjs",
    "@@ -0,0 +1,1 @@",
    "+const instant = Temporal.Now.instant();",
  ].join("\n");
  assert.deepEqual(findUninjectedClockAdditions(diff).map(({ line }) => line), [1]);
});

test("test clock audit accepts a pinned helper import", () => {
  const source = [
    'import { withPinnedClock } from "./helpers/test_clock.mjs";',
    `const today = ${wallDate}.toISOString();`,
  ].join("\n");
  assert.deepEqual(findUninjectedClockReads("test/example.test.mjs", source), []);
});

test("test clock audit accepts an explicit clock passed into the code under test", () => {
  const source = [
    `const instant = ${wallNow};`,
    "await exercise({ now: instant });",
  ].join("\n");
  assert.deepEqual(findUninjectedClockReads("test/example.test.mjs", source), []);
});

test("test clock audit accepts an explicitly allowlisted real-clock line", () => {
  const source = `const today = ${wallDate}; // test-clock: allow-real-clock — this test covers the live clock boundary`;
  assert.deepEqual(findUninjectedClockReads("worker/test/example.test.mjs", source), []);
});

test("test clock audit ignores lint fixture sources that are not tests", () => {
  const diff = [
    "+++ b/test/fixtures/determinism-lint/repo/tools/negative_clock.mjs",
    "@@ -0,0 +1,2 @@",
    `+const started = ${wallNow};`,
    `+const local = ${wallDate};`,
  ].join("\n");
  assert.deepEqual(findUninjectedClockAdditions(diff), []);
});

test("test clock audit permits fixed dates and injectable defaults", () => {
  const diff = [
    "+++ b/worker/test/example.test.mjs",
    "@@ -0,0 +1,3 @@",
    "+const fixtureNow = new Date(\"2026-08-04T12:00:00Z\");",
    "+function build(now) { return new Date(\"2026-08-04T12:00:00Z\"); }",
    "+function token(nowMs) { return new Date(nowMs); }",
  ].join("\n");
  assert.deepEqual(findUninjectedClockAdditions(diff), []);
});
