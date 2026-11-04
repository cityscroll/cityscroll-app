/**
 * The dated aggregates exist to survive the thing that would otherwise corrupt the trend:
 * receipts leaving retention. Every case here is one of the ways that corruption arrives.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_USAGE_DAILY_KEY_PREFIX,
  SEARCH_USAGE_DAILY_SCHEMA,
  buildSearchUsageDailyAggregate,
  classifySearchUsageAbsentDays,
  foldSearchUsageDays,
  publishSearchUsageDailyAggregates,
  publishableSearchUsageDays,
  readSearchUsageDailySeries,
  reconcileSearchUsageDaily,
  searchUsageDailyContentHash,
  searchUsageDayBeforeMeasurement,
  searchUsageDayKey,
} from "../src/lib/search_usage_daily.mjs";

const MEASURED_SINCE = "2026-08-01T00:00:00.000Z";

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  const writes = [];
  return {
    store,
    writes,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { writes.push(key); store.set(key, value); },
    async list({ prefix = "", cursor } = {}) {
      void cursor;
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

function execution(id, instant, { returned = true } = {}) {
  return {
    execution: id,
    receivedAtMs: Date.parse(instant),
    outcome: returned ? "matched" : "empty",
    recognized: false,
    visitor: null,
    subscriber: null,
    families: returned ? ["contracts"] : [],
    returnedRecords: returned,
  };
}

test("a day's aggregate is the same bytes however often it is recomputed", () => {
  const first = buildSearchUsageDailyAggregate({
    day: "2026-09-03",
    counts: { searches_run: 5, searches_returning_records: 4 },
    measuredSince: MEASURED_SINCE,
  });
  const second = buildSearchUsageDailyAggregate({
    day: "2026-09-03",
    counts: { searches_run: 5, searches_returning_records: 4 },
    measuredSince: MEASURED_SINCE,
  });
  assert.deepEqual(first, second);
  assert.equal(first.content_hash, searchUsageDailyContentHash(first));
  assert.equal(first.cutoff, "2026-09-04T00:00:00.000Z");
  assert.equal(first.coverage, "complete");
  // No clock rode along: nothing in the stored body moves when the run does.
  assert.equal(JSON.stringify(first).includes("generated_at"), false);
});

test("a day measurement began inside is partial, and says so rather than reading as a whole day", () => {
  const aggregate = buildSearchUsageDailyAggregate({
    day: "2026-08-01",
    counts: { searches_run: 2, searches_returning_records: 1 },
    measuredSince: "2026-08-01T14:00:00.000Z",
  });
  assert.equal(aggregate.coverage, "partial");
  assert.equal(aggregate.measured_since, "2026-08-01T14:00:00.000Z");
});

test("a retry crossing midnight leaves one execution on one date", async () => {
  // The same execution, submitted once before midnight and retried after it. The store learned
  // of it at 23:58 on the 3rd, so that is its date, whatever time the retry arrives.
  const observations = [
    execution("exec-a", "2026-09-03T23:58:00.000Z"),
    execution("exec-a", "2026-09-04T00:03:00.000Z"),
  ];
  const folded = foldSearchUsageDays(observations, { now: new Date("2026-09-05T09:00:00Z"), measuredSince: MEASURED_SINCE });
  assert.deepEqual(folded.days, { "2026-09-03": { searches_run: 1, searches_returning_records: 1 } });
  assert.equal(folded.duplicate_intakes, 1);

  // And the same holds through a publish that itself runs just after midnight.
  const kv = fakeKV();
  await publishSearchUsageDailyAggregates({ ALERT_STATE: kv }, {
    now: new Date("2026-09-04T00:05:00Z"),
    observations,
    measuredSince: MEASURED_SINCE,
  });
  const third = JSON.parse(kv.store.get(searchUsageDayKey("2026-09-03")));
  const fourth = kv.store.get(searchUsageDayKey("2026-09-04"));
  assert.equal(third.metrics.searches_run, 1);
  assert.equal(fourth, undefined, "the running day is never published");
});

test("today is never published, and nothing before measurement began is either", () => {
  const days = publishableSearchUsageDays({
    now: new Date("2026-09-06T12:00:00Z"),
    measuredSince: "2026-09-03T00:00:00.000Z",
  });
  assert.deepEqual(days, ["2026-09-03", "2026-09-04", "2026-09-05"]);
  assert.equal(days.includes("2026-09-06"), false);
  assert.equal(days.includes("2026-09-02"), false);
});

test("an unchanged rebuild writes nothing at all", async () => {
  const kv = fakeKV();
  const env = { ALERT_STATE: kv };
  const options = {
    now: new Date("2026-09-05T09:00:00Z"),
    observations: [execution("exec-a", "2026-09-04T10:00:00.000Z")],
    measuredSince: MEASURED_SINCE,
  };
  const first = await publishSearchUsageDailyAggregates(env, options);
  const writtenFirst = kv.writes.length;
  assert.ok(first.days.some((row) => row.day === "2026-09-04" && row.action === "created"));

  const second = await publishSearchUsageDailyAggregates(env, options);
  assert.equal(kv.writes.length, writtenFirst, "a rebuild over the same receipts writes nothing");
  assert.ok(second.days.every((row) => row.action === "unchanged"));
});

test("retention expiry cannot rewrite a published day downwards", async () => {
  const kv = fakeKV();
  const env = { ALERT_STATE: kv };
  const day = "2026-09-04";
  await publishSearchUsageDailyAggregates(env, {
    now: new Date("2026-09-05T09:00:00Z"),
    observations: [
      execution("exec-a", "2026-09-04T10:00:00.000Z"),
      execution("exec-b", "2026-09-04T11:00:00.000Z"),
      execution("exec-c", "2026-09-04T12:00:00.000Z"),
    ],
    measuredSince: MEASURED_SINCE,
  });
  assert.equal(JSON.parse(kv.store.get(searchUsageDayKey(day))).metrics.searches_run, 3);

  // The same day, reprocessed after two of its receipts have left the receipt store.
  const replayed = await publishSearchUsageDailyAggregates(env, {
    now: new Date("2026-09-05T21:00:00Z"),
    observations: [execution("exec-c", "2026-09-04T12:00:00.000Z")],
    measuredSince: MEASURED_SINCE,
  });
  const row = replayed.days.find((entry) => entry.day === day);
  assert.equal(row.action, "divergent_kept_stored");
  assert.equal(row.stored_metrics.searches_run, 3);
  assert.equal(row.recomputed_metrics.searches_run, 1);
  assert.equal(
    JSON.parse(kv.store.get(searchUsageDayKey(day))).metrics.searches_run,
    3,
    "the stored day stands; a shrinking recompute is reported, never written",
  );
});

test("a missed cycle leaves a gap, and resumed collection fills only what it can prove", async () => {
  const kv = fakeKV();
  const env = { ALERT_STATE: kv };
  // Day one publishes. Then nothing runs for two days.
  await publishSearchUsageDailyAggregates(env, {
    now: new Date("2026-09-03T09:00:00Z"),
    observations: [execution("exec-a", "2026-09-02T10:00:00.000Z")],
    measuredSince: "2026-09-02T00:00:00.000Z",
  });
  // Collection resumes on the 6th. The receipts for the 3rd and 4th are still inside the
  // 30-day receipt window, so a resumed run publishes them.
  await publishSearchUsageDailyAggregates(env, {
    now: new Date("2026-09-06T09:00:00Z"),
    observations: [
      execution("exec-a", "2026-09-02T10:00:00.000Z"),
      execution("exec-b", "2026-09-04T10:00:00.000Z"),
    ],
    measuredSince: "2026-09-02T00:00:00.000Z",
  });
  const series = await readSearchUsageDailySeries(env, { now: new Date("2026-09-06T09:00:00Z"), days: 5 });
  const byDay = Object.fromEntries(series.series.map((entry) => [entry.day, entry.metrics.searches_run]));
  assert.equal(byDay["2026-09-02"], 1);
  // The 3rd genuinely had no executions, so it is a measured zero, not a gap.
  assert.equal(byDay["2026-09-03"], 0);
  assert.equal(byDay["2026-09-04"], 1);
  assert.equal(byDay["2026-09-05"], 0);
  // Without a measurement start, the day before publication is reported as missing, not zero.
  assert.deepEqual(series.missing_days, ["2026-09-01"]);
  assert.equal(Object.hasOwn(byDay, "2026-09-01"), false);
  assert.equal(series.newest_day, "2026-09-05");

  const bounded = await readSearchUsageDailySeries(env, {
    now: new Date("2026-09-06T09:00:00Z"),
    days: 5,
    measuredSince: "2026-09-02T00:00:00.000Z",
  });
  assert.deepEqual(bounded.missing_days, []);
  assert.deepEqual(bounded.before_measurement, ["2026-09-01"]);
  assert.equal(bounded.measured_since, "2026-09-02T00:00:00.000Z");
});

test("measured_since after retention start with one stored day is healthy", async () => {
  assert.equal(searchUsageDayBeforeMeasurement("2026-09-08", "2026-09-09T00:00:00.000Z"), true);
  assert.equal(searchUsageDayBeforeMeasurement("2026-09-09", "2026-09-09T00:00:00.000Z"), false);
  const measuredSince = "2026-09-09T00:00:00.000Z";
  const kv = fakeKV({
    [`${SEARCH_USAGE_DAILY_KEY_PREFIX}2026-09-09`]: JSON.stringify(buildSearchUsageDailyAggregate({
      day: "2026-09-09",
      counts: { searches_run: 16, searches_returning_records: 15 },
      measuredSince,
    })),
  });
  const series = await readSearchUsageDailySeries({ ALERT_STATE: kv }, {
    now: new Date("2026-09-10T11:47:00Z"),
    days: 90,
    measuredSince,
  });
  assert.equal(series.newest_day, "2026-09-09");
  assert.deepEqual(series.missing_days, []);
  assert.ok(series.before_measurement.includes("2026-09-08"));
  assert.ok(series.before_measurement.includes("2026-08-11"));
  assert.equal(series.before_measurement.includes("2026-09-09"), false);
  assert.deepEqual(series.unrecoverable_days, []);
  const recon = reconcileSearchUsageDaily({
    storedSeries: series,
    observedDays: { "2026-09-09": { searches_run: 16, searches_returning_records: 15 } },
    now: new Date("2026-09-10T11:47:00Z"),
  });
  assert.equal(recon.ok, true);
  assert.deepEqual(recon.missing_days, []);
  assert.ok(recon.before_measurement.includes("2026-09-08"));
});

test("a stored gap after measurement began stays missing", async () => {
  const measuredSince = "2026-09-01T00:00:00.000Z";
  const seed = {};
  for (const day of ["2026-09-01", "2026-09-03"]) {
    seed[`${SEARCH_USAGE_DAILY_KEY_PREFIX}${day}`] = JSON.stringify(buildSearchUsageDailyAggregate({
      day, counts: { searches_run: 1, searches_returning_records: 1 }, measuredSince,
    }));
  }
  const series = await readSearchUsageDailySeries({ ALERT_STATE: fakeKV(seed) }, {
    now: new Date("2026-09-04T12:00:00Z"),
    days: 5,
    measuredSince,
  });
  assert.deepEqual(series.missing_days, ["2026-09-02"]);
  assert.equal(series.missing_days.includes("2026-08-30"), false);
  assert.ok(series.before_measurement.includes("2026-08-30"));
  assert.deepEqual(classifySearchUsageAbsentDays({
    wantedDays: ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"],
    heldDays: ["2026-09-01", "2026-09-03"],
    now: new Date("2026-09-04T12:00:00Z"),
    measuredSince,
  }), {
    missing_days: ["2026-09-02"],
    before_measurement: ["2026-08-31"],
    unrecoverable_days: [],
  });
});

test("a gap older than the receipts is named as one nothing can recover", async () => {
  const kv = fakeKV({
    [`${SEARCH_USAGE_DAILY_KEY_PREFIX}2026-09-05`]: JSON.stringify(buildSearchUsageDailyAggregate({
      day: "2026-09-05", counts: { searches_run: 1, searches_returning_records: 1 }, measuredSince: MEASURED_SINCE,
    })),
  });
  const series = await readSearchUsageDailySeries({ ALERT_STATE: kv }, { now: new Date("2026-09-06T09:00:00Z"), days: 60 });
  assert.equal(series.schema, SEARCH_USAGE_DAILY_SCHEMA);
  assert.ok(series.missing_days.includes("2026-09-04"));
  assert.ok(series.unrecoverable_days.includes("2026-07-20"), "a day past the receipt horizon is unrecoverable");
  assert.equal(series.unrecoverable_days.includes("2026-09-04"), false);
  // Not one of the missing days is reported as a count.
  for (const day of series.missing_days) {
    assert.equal(series.series.some((entry) => entry.day === day), false, day);
  }
});

test("reconciliation compares only what both sides can still speak for", () => {
  const storedSeries = {
    series: [
      { day: "2026-09-05", metrics: { searches_run: 2, searches_returning_records: 1 } },
      { day: "2026-09-04", metrics: { searches_run: 9, searches_returning_records: 9 } },
      { day: "2026-06-01", metrics: { searches_run: 4, searches_returning_records: 4 } },
    ],
    missing_days: ["2026-09-03"],
    unrecoverable_days: [],
  };
  const result = reconcileSearchUsageDaily({
    storedSeries,
    observedDays: { "2026-09-05": { searches_run: 2, searches_returning_records: 1 } },
    now: new Date("2026-09-06T09:00:00Z"),
  });
  const byDay = Object.fromEntries(result.rows.map((row) => [row.day, row.state]));
  assert.equal(byDay["2026-09-05"], "matched");
  assert.equal(byDay["2026-09-04"], "divergent");
  assert.equal(byDay["2026-06-01"], "beyond_receipt_retention");
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing_days, ["2026-09-03"]);
});

test("no store is not a published day", async () => {
  const result = await publishSearchUsageDailyAggregates({}, { now: new Date("2026-09-06T09:00:00Z") });
  assert.deepEqual(result, { published: false, reason: "no_store", days: [] });
  const series = await readSearchUsageDailySeries({}, { now: new Date("2026-09-06T09:00:00Z") });
  assert.equal(series.available, false);
  assert.deepEqual(series.series, []);
});

test("the day the receipt scan can no longer cover is not recomputed as divergent", async () => {
  // The recorded incident: measurement began 2026-09-09, every day through 2026-11-02 is
  // stored, and on 2026-11-03 the recompute window reached its 30th closed day back,
  // 2026-10-04. That day sits below the receipt scan's floor (a 30-day window including
  // today), so a recompute folded an empty receipt set for it and reported the stored day
  // as divergent on every run — while the stored day, written from a complete scan the
  // day after it closed, was never wrong.
  const measuredSince = "2026-09-09T00:00:00.000Z";
  const now = new Date("2026-11-03T11:47:46.215Z");
  const seed = {};
  for (let ms = Date.parse("2026-10-05T00:00:00.000Z"); ms <= Date.parse("2026-11-02T00:00:00.000Z"); ms += 24 * 3600 * 1000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    seed[`${SEARCH_USAGE_DAILY_KEY_PREFIX}${date}`] = JSON.stringify(buildSearchUsageDailyAggregate({
      day: date, counts: { searches_run: 0, searches_returning_records: 0 }, measuredSince,
    }));
  }
  seed[`${SEARCH_USAGE_DAILY_KEY_PREFIX}2026-10-04`] = JSON.stringify(buildSearchUsageDailyAggregate({
    day: "2026-10-04", counts: { searches_run: 3, searches_returning_records: 2 }, measuredSince,
  }));
  seed[`${SEARCH_USAGE_DAILY_KEY_PREFIX}2026-10-05`] = JSON.stringify(buildSearchUsageDailyAggregate({
    day: "2026-10-05", counts: { searches_run: 1, searches_returning_records: 1 }, measuredSince,
  }));
  const kv = fakeKV(seed);
  const env = { ALERT_STATE: kv };

  // The scan's own horizon: the widest usage window opens at 2026-10-05, so the 4th is
  // outside it no matter how wide a horizon the publisher is asked for.
  assert.equal(publishableSearchUsageDays({ now, measuredSince }).includes("2026-10-04"), false);
  assert.equal(publishableSearchUsageDays({ now, measuredSince, horizonDays: 400 }).includes("2026-10-04"), false);

  // A recompute over what the scan can still return neither rewrites the stored day nor
  // reports it: it has no row at all, because no receipt can speak for it any more.
  const storedBefore = kv.store.get(searchUsageDayKey("2026-10-04"));
  const published = await publishSearchUsageDailyAggregates(env, {
    now,
    observations: [execution("exec-scan", "2026-10-05T08:00:00.000Z")],
    measuredSince,
  });
  assert.equal(published.days.some((row) => row.day === "2026-10-04"), false);
  assert.equal(published.days.some((row) => row.action === "divergent_kept_stored"), false);
  assert.equal(kv.store.get(searchUsageDayKey("2026-10-04")), storedBefore);

  // The reconciliation reports that day as beyond the receipts, never as a mismatch.
  const series = await readSearchUsageDailySeries(env, { now, days: 30, measuredSince });
  const observed = foldSearchUsageDays(
    [execution("exec-scan", "2026-10-05T08:00:00.000Z")],
    { now, measuredSince },
  );
  const recon = reconcileSearchUsageDaily({ storedSeries: series, observedDays: observed.days, now });
  const byDay = Object.fromEntries(recon.rows.map((row) => [row.day, row.state]));
  assert.equal(byDay["2026-10-04"], "beyond_receipt_retention");
  assert.equal(recon.rows.some((row) => row.state === "divergent"), false);
  assert.equal(recon.ok, true);
});

test("a day below the scan floor is left absent, never zero-created by a late rerun", async () => {
  // A run 30 days after a missed day cannot recover that day: its receipts are below the
  // scan floor. Publishing must leave the day absent rather than storing an empty
  // aggregate that would read as a measured zero.
  const measuredSince = "2026-09-09T00:00:00.000Z";
  const kv = fakeKV();
  const published = await publishSearchUsageDailyAggregates({ ALERT_STATE: kv }, {
    now: new Date("2026-11-03T11:47:46.215Z"),
    observations: [execution("exec-scan", "2026-10-05T08:00:00.000Z")],
    measuredSince,
  });
  assert.equal(published.days.some((row) => row.day === "2026-10-04"), false);
  assert.equal(kv.store.get(searchUsageDayKey("2026-10-04")), undefined);
  // The oldest day the scan covers in full is still published, including as a measured zero.
  assert.ok(published.days.some((row) => row.day === "2026-10-05" && row.action === "created"));
  assert.ok(JSON.parse(kv.store.get(searchUsageDayKey("2026-10-05"))).metrics.searches_run === 1);
});
