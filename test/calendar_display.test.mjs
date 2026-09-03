// The bounded display-occurrence contract: a backward-looking query that never
// touches feed defaults, a pure eligibility boundary, and a pure density rule.
// This suite pins the edge matrix — date and timestamp identity, inclusive
// bounds, the normative exclusions, and the three-occurrence / two-date /
// 42-day cluster rule — plus the deterministic cross-surface census.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createCalendarOccurrence } from "../site/calendar_occurrence.mjs";
import {
  CALENDAR_DISPLAY_EXCLUSION_REASONS,
  boundedDisplayOccurrences,
  buildDisplayOccurrenceCensus,
  classifyDisplayRecord,
  displayOccurrenceEligibility,
  evaluateDisplayCluster,
  normalizeDisplayBounds,
  occurrenceDay,
} from "../site/calendar_display.mjs";
import {
  buildCalendarDisplayOccurrenceCensus,
  readCorpus,
} from "../tools/build_calendar_display_occurrence_census.mjs";

const WIDE = { from: "2000-01-01", to: "2099-12-31" };

function eligibleRecord(overrides = {}) {
  return {
    object_ref: "meeting:example-1",
    scope_ref: "scope:meetings:example",
    title: "Public hearing",
    event_date: "2026-03-04T18:00:00-05:00",
    timezone: "America/New_York",
    canonical_url: "https://cityscroll.org/meetings/meeting%3Aexample-1/",
    source_system: "city_record",
    source_record_id: "example-1",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/example-1",
    provenance: { basis: "publisher_record", field: "event_date" },
    ...overrides,
  };
}

function dayOccurrence(date, extra = {}) {
  return createCalendarOccurrence({
    uid: extra.uid || `occ:${date}:${extra.suffix || "a"}`,
    object_ref: extra.object_ref || `occ:${date}`,
    kind: extra.kind || "event",
    title: "x",
    ...(String(date).length > 10 ? { starts_at: date } : { date }),
    timezone: extra.timezone,
    status: extra.status,
    lifecycle: extra.lifecycle,
    canonical_url: "https://cityscroll.org/x",
    source: { system: "city_record", record_id: "x" },
    provenance: { basis: "publisher_record" },
  });
}

/* ===== A1: bounds separate the query window from occurrence meaning ===== */

test("bounds are required and validated on the new path", () => {
  assert.throws(() => boundedDisplayOccurrences([eligibleRecord()]), /bounds/);
  assert.throws(() => normalizeDisplayBounds(null), /bounds/);
  assert.throws(() => normalizeDisplayBounds({ from: "2026-01-01" }), /from` and `to`/);
  assert.throws(() => normalizeDisplayBounds({ from: "2026-02-01", to: "2026-01-01" }), /must not be after/);
  assert.deepEqual(normalizeDisplayBounds({ from: "2026-01-01", to: "2026-02-01" }), { from: "2026-01-01", to: "2026-02-01" });
});

test("a bounded query includes source-observed past occurrences", () => {
  const rows = [
    eligibleRecord({ object_ref: "meeting:past", canonical_url: "https://cityscroll.org/meetings/meeting%3Apast/", event_date: "2026-01-05T18:00:00-05:00" }),
    eligibleRecord({ object_ref: "meeting:future", canonical_url: "https://cityscroll.org/meetings/meeting%3Afuture/", event_date: "2026-12-05T18:00:00-05:00" }),
  ];
  const past = boundedDisplayOccurrences(rows, { from: "2026-01-01", to: "2026-06-30" });
  assert.deepEqual(past.map((o) => o.object_ref), ["meeting:past"]);
  const both = boundedDisplayOccurrences(rows, { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(both.map(occurrenceDay), ["2026-01-05", "2026-12-05"]);
});

test("exact date, timestamp, and date-only deadline each resolve to their real day", () => {
  const rows = [
    eligibleRecord({ object_ref: "meeting:ts", canonical_url: "https://cityscroll.org/meetings/meeting%3Ats/", event_date: "2026-03-04T18:00:00-05:00" }),
    eligibleRecord({ object_ref: "notice:deadline", canonical_url: "https://cityscroll.org/notices/notice%3Adeadline", event_date: undefined, deadline_date: "2026-03-06" }),
  ];
  const occurrences = boundedDisplayOccurrences(rows, { from: "2026-03-01", to: "2026-03-31" });
  const byRef = Object.fromEntries(occurrences.map((o) => [o.object_ref, o]));
  assert.equal(byRef["meeting:ts"].starts_at, "2026-03-04T18:00:00-05:00");
  assert.equal(occurrenceDay(byRef["meeting:ts"]), "2026-03-04");
  assert.equal(byRef["notice:deadline"].date, "2026-03-06");
  assert.equal(occurrenceDay(byRef["notice:deadline"]), "2026-03-06");
});

test("inclusive boundary edges: from and to days are in, one day past is out", () => {
  const rows = [
    eligibleRecord({ object_ref: "notice:from", canonical_url: "https://cityscroll.org/notices/notice%3Afrom", event_date: undefined, deadline_date: "2026-03-01" }),
    eligibleRecord({ object_ref: "notice:to", canonical_url: "https://cityscroll.org/notices/notice%3Ato", event_date: undefined, deadline_date: "2026-03-31" }),
    eligibleRecord({ object_ref: "notice:before", canonical_url: "https://cityscroll.org/notices/notice%3Abefore", event_date: undefined, deadline_date: "2026-02-28" }),
    eligibleRecord({ object_ref: "notice:after", canonical_url: "https://cityscroll.org/notices/notice%3Aafter", event_date: undefined, deadline_date: "2026-04-01" }),
  ];
  const inside = boundedDisplayOccurrences(rows, { from: "2026-03-01", to: "2026-03-31" }).map((o) => o.object_ref);
  assert.deepEqual(inside.sort(), ["notice:from", "notice:to"]);
});

test("timezone identity puts a timestamp on the civic day, not the UTC day", () => {
  // 02:00 UTC on the 16th is 21:00 on the 15th in New York.
  assert.equal(occurrenceDay(dayOccurrence("2026-01-16T02:00:00Z", { timezone: "America/New_York" })), "2026-01-15");
  // A late-evening local hearing stays on its local day even as UTC rolls over.
  assert.equal(occurrenceDay(dayOccurrence("2026-01-15T23:30:00-05:00", { timezone: "America/New_York" })), "2026-01-15");
  // Absent a timezone, the authored wall-clock date is used, matching the feed.
  assert.equal(occurrenceDay(dayOccurrence("2026-01-16T02:00:00Z", {})), "2026-01-16");
});

/* ===== A2: ineligible date-like records emit no eligible display occurrence ===== */

test("each normative exclusion emits no eligible display occurrence", () => {
  const cases = {
    "publication-only-timestamp": { object_ref: "notice:pub", event_date: undefined, deadline_date: undefined, published_at: "2026-03-01T09:00:00-05:00" },
    "undated-record": { object_ref: "notice:undated", event_date: undefined },
    "ambiguous-date": { object_ref: "notice:ambiguous", event_date: "2026-13-40" },
    "inferred-date-no-publisher-basis": { object_ref: "notice:inferred", inferred: true, provenance: { basis: "inferred" } },
    "forecast-date": { object_ref: "notice:forecast", forecast: true, provenance: { basis: "forecast" } },
    "predicted-date": { object_ref: "notice:predicted", predicted: true, provenance: { basis: "prediction" } },
    "statutory-expected-date": { object_ref: "notice:statutory", statutory_expected: true },
    "profile-derived-date": { object_ref: "notice:profile", profile_derived: true },
    "low-confidence-derived-deadline": { object_ref: "notice:lowconf", derived: true, confidence: 0.2, provenance: { basis: "derived" } },
    "unjoined-source-record": { object_ref: "meeting:unjoined", join_status: "rejected" },
    "missing-source-basis": { object_ref: "notice:nosource", source_system: undefined, source_record_id: undefined, source_url: undefined, provenance: null },
    "missing-canonical-destination": { object_ref: "opportunity:nodest", canonical_url: undefined },
  };
  for (const [reason, overrides] of Object.entries(cases)) {
    const record = eligibleRecord(overrides);
    assert.deepEqual(boundedDisplayOccurrences([record], WIDE), [], reason);
    const classified = classifyDisplayRecord(record);
    assert.equal(classified.eligible_occurrences.length, 0, reason);
    assert.equal(classified.excluded[0].reason, reason, reason);
  }
});

test("missing canonical identity is caught even when a destination is present", () => {
  const orphan = createCalendarOccurrence({
    uid: "loose:1", scope_ref: "scope:meetings:x", kind: "event", title: "x",
    date: "2026-03-04", canonical_url: "https://cityscroll.org/x", source: { system: "s" },
    provenance: { basis: "publisher_record" },
  });
  assert.equal(orphan.object_ref, null);
  assert.deepEqual(displayOccurrenceEligibility(orphan, {}), { eligible: false, reason: "missing-canonical-identity" });
});

test("the exclusion vocabulary is closed", () => {
  assert.equal(new Set(CALENDAR_DISPLAY_EXCLUSION_REASONS).size, CALENDAR_DISPLAY_EXCLUSION_REASONS.length);
  const record = eligibleRecord({ object_ref: "meeting:unjoined", join_status: "rejected" });
  assert.ok(CALENDAR_DISPLAY_EXCLUSION_REASONS.includes(classifyDisplayRecord(record).excluded[0].reason));
});

/* ===== lifecycle: duplicate, reschedule, cancellation ===== */

test("a duplicate stable occurrence collapses to one cell", () => {
  const base = eligibleRecord({ object_ref: "meeting:dup", canonical_url: "https://cityscroll.org/meetings/meeting%3Adup/" });
  const rows = [base, { ...base, source_record_id: "dup-2" }];
  const occurrences = boundedDisplayOccurrences(rows, WIDE);
  assert.equal(occurrences.length, 1);
  const surface = buildDisplayOccurrenceCensus([{ surface: "x", records: rows }]).surfaces[0];
  assert.equal(surface.eligible_occurrences, 1);
  assert.equal(surface.exclusion_reasons["duplicate-stable-occurrence"], 1);
});

test("a reschedule keeps one UID at the newer time; a cancellation stays visible as cancelled", () => {
  const scheduled = eligibleRecord({ object_ref: "meeting:hearing", canonical_url: "https://cityscroll.org/meetings/meeting%3Ahearing/", event_date: "2026-03-04T18:00:00-05:00", sequence: 0 });
  const rescheduled = { ...scheduled, event_date: "2026-03-05T19:00:00-05:00", sequence: 1, lifecycle: "rescheduled" };
  const afterReschedule = boundedDisplayOccurrences([scheduled, rescheduled], WIDE);
  assert.equal(afterReschedule.length, 1);
  assert.equal(afterReschedule[0].starts_at, "2026-03-05T19:00:00-05:00");

  const cancelled = eligibleRecord({ object_ref: "meeting:cancelled", canonical_url: "https://cityscroll.org/meetings/meeting%3Acancelled/", event_date: "2026-03-04T18:00:00-05:00", status: "cancelled", lifecycle: "cancelled" });
  const shown = boundedDisplayOccurrences([cancelled], WIDE);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].status, "cancelled");
});

/* ===== A3: density rule across 0/1/2/3+, dates, spans, ties, boundaries ===== */

function cluster(dates, options) {
  return evaluateDisplayCluster(dates.map((d, i) => dayOccurrence(d, { suffix: String(i) })), options);
}

test("occurrence and date counts gate qualification", () => {
  assert.deepEqual(cluster([]).reason, "unavailable-no-occurrences");
  assert.equal(cluster([]).qualifies, false);
  assert.equal(cluster(["2026-03-01"]).reason, "sparse-too-few-occurrences");
  assert.equal(cluster(["2026-03-01", "2026-03-05"]).reason, "sparse-too-few-occurrences");
  assert.equal(cluster(["2026-03-01", "2026-03-01", "2026-03-01"]).reason, "sparse-single-date");
  const ok = cluster(["2026-03-01", "2026-03-01", "2026-03-05"]);
  assert.equal(ok.qualifies, true);
  assert.equal(ok.reason, "eligible");
  assert.equal(ok.distinct_dates, 2);
});

test("42-day windows: 41 and 42 day spans qualify, 43 does not", () => {
  const fit41 = cluster(["2026-01-01", "2026-01-20", "2026-02-10"]);
  assert.equal(fit41.qualifies, true);
  assert.equal(fit41.densest_window.span_days, 41);

  const fit42 = cluster(["2026-01-01", "2026-01-21", "2026-02-11"]);
  assert.equal(fit42.qualifies, true);
  assert.equal(fit42.densest_window.span_days, 42);

  const over43 = cluster(["2026-01-01", "2026-01-22", "2026-02-12"]);
  assert.equal(over43.qualifies, false);
  assert.equal(over43.reason, "sparse-no-dense-window");
});

test("a tie in density resolves to the earliest cluster deterministically", () => {
  const tied = cluster(["2026-03-01", "2026-03-02", "2026-03-03", "2026-06-01", "2026-06-02", "2026-06-03"]);
  assert.equal(tied.qualifies, true);
  assert.equal(tied.densest_window.from, "2026-03-01");
  assert.equal(tied.densest_window.occurrence_count, 3);
  assert.equal(tied.selected_month, "2026-03");
});

test("a month-boundary cluster reports the boundary and the denser month", () => {
  const spillover = cluster(["2026-01-30", "2026-02-02", "2026-02-05"]);
  assert.equal(spillover.qualifies, true);
  assert.equal(spillover.crosses_month_boundary, true);
  assert.equal(spillover.selected_month, "2026-02");
  assert.equal(spillover.densest_window.from, "2026-01-30");
  assert.equal(spillover.densest_window.to, "2026-02-05");
});

/* ===== A3: deterministic census by surface ===== */

test("the census records eligible, sparse, excluded and unavailable cases by surface", () => {
  const census = buildCalendarDisplayOccurrenceCensus(readCorpus());
  const bySurface = Object.fromEntries(census.surfaces.map((row) => [row.surface, row]));
  assert.equal(bySurface.rules.qualification, "eligible");
  assert.equal(bySurface.rules.selected_month, "2026-03");
  assert.equal(bySurface.community_boards.qualification, "eligible");
  assert.equal(bySurface.now.qualification, "eligible");
  assert.equal(bySurface.land.qualification, "eligible");
  assert.equal(bySurface.procurement.qualification, "eligible");
  assert.equal(bySurface.property.qualification, "sparse");
  assert.equal(bySurface.exams.qualification, "unavailable");
  assert.equal(bySurface.legislative.qualification, "excluded");
  assert.deepEqual(census.summary.status_counts, { eligible: 5, sparse: 1, excluded: 1, unavailable: 1 });
});

test("the census is reproducible byte-for-byte and matches the committed evidence", () => {
  const first = buildCalendarDisplayOccurrenceCensus(readCorpus());
  const second = buildCalendarDisplayOccurrenceCensus(readCorpus());
  assert.deepEqual(first, second);
  const committed = JSON.parse(readFileSync(new URL("../site/data/calendar_display_occurrence_census.json", import.meta.url), "utf8"));
  assert.deepEqual(first, committed);
});

test("the census only ever reports closed-vocabulary exclusion reasons and never claims production prevalence", () => {
  const census = buildCalendarDisplayOccurrenceCensus(readCorpus());
  for (const surface of census.surfaces) {
    for (const reason of Object.keys(surface.exclusion_reasons)) {
      assert.ok(CALENDAR_DISPLAY_EXCLUSION_REASONS.includes(reason), reason);
    }
  }
  assert.match(census.provenance.coverage, /not claimed/i);
  assert.match(census.provenance.corpus, /not a live production sample/i);
});
