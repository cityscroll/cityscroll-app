import assert from "node:assert/strict";
import { test } from "node:test";

import { findUninjectedClockAdditions } from "../tools/audit-test-clocks.mjs";

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

test("test clock audit permits fixed dates and injectable defaults", () => {
  const diff = [
    "+++ b/worker/test/example.test.mjs",
    "@@ -0,0 +1,3 @@",
    "+const fixtureNow = new Date(\"2026-08-04T12:00:00Z\");",
    `+function build(now = ${wallDate}) { return now; }`,
    `+function token(nowMs = ${wallNow}) { return nowMs; }`,
  ].join("\n");
  assert.deepEqual(findUninjectedClockAdditions(diff), []);
});
