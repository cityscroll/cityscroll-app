import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { primaryDocumentOutputs, resolvePinnedBuildClock } from "../tools/build_primary_documents.mjs";

const OPEN_CONTRACTS = JSON.parse(
  readFileSync(new URL("../site/data/money_default_open.json", import.meta.url), "utf8"),
);

test("resolvePinnedBuildClock is null when CROL_BUILD_DAY is unset", () => {
  assert.equal(resolvePinnedBuildClock({}), null);
});

test("resolvePinnedBuildClock parses a day-only CROL_BUILD_DAY as NY midnight", () => {
  const clock = resolvePinnedBuildClock({ CROL_BUILD_DAY: "2026-09-05" });
  assert.ok(clock instanceof Date);
  assert.equal(clock.toISOString(), "2026-09-05T04:00:00.000Z");
});

test("resolvePinnedBuildClock parses a full instant CROL_BUILD_DAY exactly", () => {
  const clock = resolvePinnedBuildClock({ CROL_BUILD_DAY: "2026-09-05T07:42:13.123Z" });
  assert.ok(clock instanceof Date);
  assert.equal(clock.toISOString(), "2026-09-05T07:42:13.123Z");
});

test("resolvePinnedBuildClock rejects an unparsable CROL_BUILD_DAY", () => {
  assert.throws(() => resolvePinnedBuildClock({ CROL_BUILD_DAY: "not-a-date" }));
});

test("primaryDocumentOutputs without an explicit clock stays unfiltered when CROL_BUILD_DAY is unset", () => {
  const before = process.env.CROL_BUILD_DAY;
  delete process.env.CROL_BUILD_DAY;
  try {
    const outputs = primaryDocumentOutputs();
    const contracts = outputs.find(([path]) => path.endsWith("browse/contracts/index.html"))[1];
    // Unfiltered: every notice the payload carries renders, matching the
    // long-standing default every existing caller already relies on.
    assert.match(contracts, new RegExp(`data-scope-count="${OPEN_CONTRACTS.notices.length}"`));
  } finally {
    if (before === undefined) delete process.env.CROL_BUILD_DAY;
    else process.env.CROL_BUILD_DAY = before;
  }
});

test("primaryDocumentOutputs without an explicit clock honors a pinned CROL_BUILD_DAY", () => {
  const before = process.env.CROL_BUILD_DAY;
  process.env.CROL_BUILD_DAY = "2026-09-05T00:00:00.000Z";
  try {
    const first = primaryDocumentOutputs().find(([path]) => path.endsWith("browse/contracts/index.html"))[1];
    const second = primaryDocumentOutputs().find(([path]) => path.endsWith("browse/contracts/index.html"))[1];
    // Two calls under the same pinned instant must be byte-identical -- the
    // whole point of pinning one build day across a multi-minute run.
    assert.equal(first, second);
  } finally {
    if (before === undefined) delete process.env.CROL_BUILD_DAY;
    else process.env.CROL_BUILD_DAY = before;
  }
});
