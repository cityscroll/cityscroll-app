import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MILLISECONDS_PER_DAY,
  TEST_CLOCK_ENV,
  withPinnedClock,
} from "./helpers/test_clock.mjs";

const PRELOAD = fileURLToPath(new URL("./helpers/test_clock_preload.mjs", import.meta.url));
const PREFLIGHT = readFileSync(new URL("../tools/preflight-required-checks.sh", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../.github/workflows/time-travel.yml", import.meta.url), "utf8");

test("withPinnedClock pins the process clock, preserves explicit dates, and restores the scope", async () => {
  const previousDate = globalThis.Date;
  const pinned = "2026-09-14T00:00:00.000Z";
  await withPinnedClock(pinned, () => {
    const currentDate = globalThis["Date"];
    assert.equal(currentDate["now"](), Date.parse(pinned));
    assert.equal(new globalThis["Date"]().toISOString(), pinned);
    assert.equal(new Date("2000-01-01T00:00:00.000Z").toISOString(), "2000-01-01T00:00:00.000Z");
  });
  assert.equal(globalThis.Date, previousDate);
});

test("withPinnedClock restores the prior Date after an async failure", async () => {
  const previousDate = globalThis.Date;
  await assert.rejects(
    withPinnedClock("2026-09-14T00:00:00.000Z", async () => {
      await Promise.resolve();
      throw new Error("fixture failure");
    }),
    /fixture failure/,
  );
  assert.equal(globalThis.Date, previousDate);
});

test("the preload shifts the process clock by the requested whole number of days", () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv[TEST_CLOCK_ENV];
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", "console.log(globalThis[\"Date\"][\"now\"]())"], {
    encoding: "utf8",
    env,
  });
  const baseline = Number(run(cleanEnv).stdout.trim());
  const shifted = Number(run({
    ...cleanEnv,
    [TEST_CLOCK_ENV]: "45",
    NODE_OPTIONS: `--import=${PRELOAD}`,
  }).stdout.trim());
  assert.ok(Number.isFinite(baseline) && Number.isFinite(shifted));
  const delta = shifted - baseline;
  assert.ok(delta >= 45 * MILLISECONDS_PER_DAY, `clock shifted by only ${delta}ms`);
  assert.ok(delta < 45 * MILLISECONDS_PER_DAY + 10_000, `clock shifted by too much: ${delta}ms`);
});

test("the local runner and CI workflow use the shared preload with bounded concurrency", () => {
  assert.match(PREFLIGHT, /run_node_test\(\)/);
  assert.match(PREFLIGHT, /CITYSCROLL_TEST_TIME_SHIFT_DAYS/);
  assert.match(PREFLIGHT, /--test-concurrency=\"\$NODE_TEST_CONCURRENCY\"/);
  assert.match(WORKFLOW, /CITYSCROLL_TEST_TIME_SHIFT_DAYS: \$\{\{ matrix\.shift \}\}/);
  assert.match(WORKFLOW, /shift: \[1, 45\]/);
  assert.match(WORKFLOW, /family: \[site-node, worker, combined\]/);
  assert.equal((WORKFLOW.match(/--test-concurrency=2/g) || []).length, 3);
  assert.match(WORKFLOW, /test_clock_preload\.mjs/);
  assert.match(WORKFLOW, /intentionally non-required/);
});
