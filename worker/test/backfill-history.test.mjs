// The one-time hist:<metric>:<day> backfill's pure date math — the part that decides whether
// a gap day between the earliest recovered day and today is safe to record as a confirmed
// zero, or must be left unrecorded because the source counter's TTL could have already lost
// a real (non-zero) count. See worker/scripts/backfill-history.mjs's header comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween, allDaysInRange } from "../scripts/backfill-history.mjs";

test("daysBetween counts whole UTC days, not wall-clock hours", () => {
  assert.equal(daysBetween("2026-07-03", "2026-07-14"), 11);
  assert.equal(daysBetween("2026-07-13", "2026-07-14"), 1);
  assert.equal(daysBetween("2026-07-14", "2026-07-14"), 0);
});

test("allDaysInRange walks forward and excludes the end day, matching 'never touch today'", () => {
  assert.deepEqual(allDaysInRange("2026-07-11", "2026-07-14"), ["2026-07-11", "2026-07-12", "2026-07-13"]);
  assert.deepEqual(allDaysInRange("2026-07-14", "2026-07-14"), []);
});

test("before: a metric whose source TTL is shorter than its recovered window had no way to tell a true zero from an already-expired real count, so zero-filling it would risk asserting activity that just vanished; after: ttlDays > daysBetween(oldest, today) is the exact boundary — digest's 40-day TTL clears an 11-day gap (zero-fill safe), nl_search's 2-day TTL does not clear a 1-day-old single point once the gap grows past 2 days", () => {
  const digestSafe = 40 > daysBetween("2026-07-03", "2026-07-14");
  const nlSafeToday = 2 > daysBetween("2026-07-13", "2026-07-14");
  const nlSafeIfGapGrew = 2 > daysBetween("2026-07-05", "2026-07-14");
  assert.equal(digestSafe, true);
  assert.equal(nlSafeToday, true, "a single-day-old gap is still within the 2-day TTL");
  assert.equal(nlSafeIfGapGrew, false, "a 9-day-old gap has already outrun the 2-day TTL — must not zero-fill");
});
