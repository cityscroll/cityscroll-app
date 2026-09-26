/**
 * Local preflight must pin CROL_BUILD_DAY from the committed money-open
 * snapshot vintage, not from wall-clock today. CI leaves CROL_BUILD_DAY unset
 * (null clock → no open-contract re-filter). The local runner needs one shared
 * instant across rebuilds; that instant has to be a day the snapshot still
 * describes as open.
 *
 * verify: node --test test/preflight_build_day_vintage.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MONEY_OPEN_SNAPSHOT_PATH,
  VINTAGE_FIELDS,
  resolvePreflightBuildDay,
  resolvePreflightBuildDayFromFile,
} from "../tools/resolve_preflight_build_day.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREFLIGHT = readFileSync(new URL("../tools/preflight-required-checks.sh", import.meta.url), "utf8");
const HELPER = "tools/resolve_preflight_build_day.mjs";
const SNAPSHOT = JSON.parse(readFileSync(MONEY_OPEN_SNAPSHOT_PATH, "utf8"));

test("resolvePreflightBuildDay prefers open_as_of, then generated_at, then retrieved_at", () => {
  assert.equal(
    resolvePreflightBuildDay({
      open_as_of: "2026-09-09",
      generated_at: "2026-09-10T06:52:16.670Z",
      retrieved_at: "2026-09-11T00:00:00.000Z",
    }),
    "2026-09-09",
  );
  assert.equal(
    resolvePreflightBuildDay({
      generated_at: "2026-09-10T06:52:16.670Z",
      retrieved_at: "2026-09-11T00:00:00.000Z",
    }),
    "2026-09-10",
  );
  assert.equal(
    resolvePreflightBuildDay({ retrieved_at: "2026-09-11T12:00:00.000Z" }),
    "2026-09-11",
  );
  assert.throws(() => resolvePreflightBuildDay({}), /declares no vintage/);
});

test("the committed money-open snapshot yields a concrete vintage day", () => {
  const day = resolvePreflightBuildDayFromFile();
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  const expected = VINTAGE_FIELDS
    .map((key) => String(SNAPSHOT[key] || "").slice(0, 10))
    .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  assert.equal(day, expected);
  // At least one notice must still be open on that vintage day, or the
  // preflight pin would empty /browse/contracts/ the same way a late
  // wall-clock pin does.
  const openOnVintage = (SNAPSHOT.notices || []).filter(
    (row) => String(row?.due_date || "").slice(0, 10) > day,
  );
  assert.ok(
    openOnVintage.length > 0,
    `no notice in the committed snapshot is open on its own as-of (${day})`,
  );
});

test("the helper CLI prints the snapshot vintage day", () => {
  const run = spawnSync(process.execPath, [HELPER], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), resolvePreflightBuildDayFromFile());
});

test("preflight defaults CROL_BUILD_DAY from the snapshot helper, not wall-clock today", () => {
  assert.match(PREFLIGHT, /resolve_preflight_build_day\.mjs/);
  assert.match(PREFLIGHT, /open_as_of/);
  assert.match(PREFLIGHT, /generated_at/);
  assert.match(PREFLIGHT, /retrieved_at/);
  assert.match(PREFLIGHT, /explicit CROL_BUILD_DAY/);
  assert.match(PREFLIGHT, /CITYSCROLL_TEST_TIME_SHIFT_DAYS/);
  assert.doesNotMatch(
    PREFLIGHT,
    /CROL_BUILD_DAY=\$\{CROL_BUILD_DAY:-\$\(date -u/,
    "preflight must not default CROL_BUILD_DAY to wall-clock today",
  );
  assert.doesNotMatch(
    PREFLIGHT,
    /CROL_BUILD_DAY=\$\{CROL_BUILD_DAY:-\$\(date /,
    "preflight must not default CROL_BUILD_DAY from date(1)",
  );
  // The default assignment must call the helper only when the env is empty, so
  // an explicit override still wins without re-deriving from the snapshot.
  assert.match(
    PREFLIGHT,
    /if \[\[ -z "\$\{CROL_BUILD_DAY:-\}" \]\]; then\s*\n\s*CROL_BUILD_DAY="\$\(node "\$PROJECT_ROOT\/tools\/resolve_preflight_build_day\.mjs"\)"/,
  );
});

test("preflight still sources the git-env scrub before pinning the build day", () => {
  const scrubIdx = PREFLIGHT.indexOf(
    'source "$PROJECT_ROOT/tools/git-hooks/scrub-hook-exported-git-env.sh"',
  );
  const helperIdx = PREFLIGHT.indexOf("resolve_preflight_build_day.mjs");
  assert.ok(scrubIdx >= 0, "preflight must keep the hook-exported git-env scrub");
  assert.ok(helperIdx >= 0, "preflight must resolve the snapshot build day");
  assert.ok(scrubIdx < helperIdx, "scrub must run before the build-day pin");
});
