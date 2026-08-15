import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AS_OF_QUERY_KEY,
  CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP,
  CIVIC_TIME_THEORY_SOURCES,
  CIVIC_TIME_DEPENDENCY_REGISTRY_SCHEMA,
  CIVIC_TIME_REMATERIALIZATION_RECEIPT_SCHEMA,
  TIME_AXES,
  asOfFilterCanNarrow,
  asOfHref,
  buildLedgerSummary,
  buildCivicTimeAffectedObjectRegistry,
  buildCivicTimeDerivedRows,
  buildNoticeBitemporalHistory,
  buildNoticeTemporalFacts,
  classifyItemTemporal,
  dayStamp,
  normalizeAsOfDay,
  noticeVisibleAsOf,
  parseAsOfFromSearch,
  projectAgencyConstellationAsOf,
  rematerializeCivicTimeLedger,
  renderCivicTimeLedgerPanel,
  renderNoticeBitemporalHistory,
} from "../site/civic_time_ledger.mjs";
import { buildCivicTimeSourceChange } from "../worker/src/lib/civic_time_writer.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const intelligence = JSON.parse(
  readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
);
const certification = JSON.parse(
  readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"),
);

const PARKS = "parks-and-recreation";

test("normalizeAsOfDay accepts calendar days and rejects invented neighbours", () => {
  assert.equal(normalizeAsOfDay("2024-06-01"), "2024-06-01");
  assert.equal(normalizeAsOfDay("2024-06-01T15:30:00.000Z"), "2024-06-01");
  assert.equal(normalizeAsOfDay("2024-02-31"), null);
  assert.equal(normalizeAsOfDay("not-a-date"), null);
  assert.equal(normalizeAsOfDay(""), null);
});

test("dayStamp extracts ISO day without inventing clocks", () => {
  assert.equal(dayStamp("2026-05-18T00:00:00.000"), "2026-05-18");
  assert.equal(dayStamp(null), null);
  assert.equal(dayStamp("sometime soon"), null);
});

test("asOfHref is shareable and strips empty as-of", () => {
  assert.equal(
    asOfHref("/agencies/parks-and-recreation/", "2024-06-01"),
    `/agencies/parks-and-recreation/?${AS_OF_QUERY_KEY}=2024-06-01`,
  );
  assert.equal(asOfHref("/agencies/parks-and-recreation/", null), "/agencies/parks-and-recreation/");
  assert.equal(
    parseAsOfFromSearch(`?${AS_OF_QUERY_KEY}=2024-06-01&tab=1`),
    "2024-06-01",
  );
});

test("TIME_AXES names remain available for library callers", () => {
  assert.equal(TIME_AXES.valid.id, "valid");
  assert.equal(TIME_AXES.system.id, "system");
});

test("Snodgrass theory sources are page-cited and source status stays honest", () => {
  const snodgrass = CIVIC_TIME_THEORY_SOURCES.snodgrass;
  assert.equal(snodgrass.status, "held_read");
  assert.equal(snodgrass.cangshu_id, 1183);
  assert.match(snodgrass.canonical_href, /^https:\/\/www2\.cs\.arizona\.edu\//);
  assert.deepEqual(
    snodgrass.citations.map((citation) => citation.pages),
    ["4", "20–21", "224–226", "249", "309–312"],
  );

  const dateDarwenLorentzos = CIVIC_TIME_THEORY_SOURCES.date_darwen_lorentzos;
  assert.equal(dateDarwenLorentzos.status, "partial_reference_held");
  assert.equal(dateDarwenLorentzos.cangshu_id, 1182);
  assert.equal(dateDarwenLorentzos.synthesis_status, "remaining_debt");
  assert.match(dateDarwenLorentzos.canonical_href, /^https:\/\/shop\.elsevier\.com\//);
});

test("four civic clocks map onto bitemporal axes once without collapsing evidence clocks", () => {
  assert.deepEqual(Object.keys(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP), [
    "civic",
    "publication",
    "observation",
    "processing",
  ]);
  assert.equal(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.civic.bitemporal_axis, "valid");
  assert.equal(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.publication.bitemporal_axis, null);
  assert.equal(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.publication.public_as_of_role, "valid_fallback");
  assert.equal(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.observation.bitemporal_axis, "system");
  assert.equal(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.processing.bitemporal_axis, null);
  assert.equal(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.processing.notice_recorded_role, "fallback_display");

  const axisOwners = Object.entries(CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP)
    .filter(([, clock]) => clock.bitemporal_axis)
    .map(([clock, definition]) => [definition.bitemporal_axis, clock]);
  assert.deepEqual(axisOwners, [["valid", "civic"], ["system", "observation"]]);
});

test("classifyItemTemporal never invents system time from materialisation vintage", () => {
  const clocks = classifyItemTemporal(
    { date: "2023-03-03", source: "warehouse" },
    "2024-06-01",
  );
  assert.equal(clocks.valid_day, "2023-03-03");
  assert.equal(clocks.system_day, null);
  assert.equal(clocks.system_known, false);
  assert.equal(clocks.included_by_valid, true);
  assert.equal(clocks.included_by_system, null);
  assert.equal(clocks.filter_basis, "valid_or_publication");
});

test("Parks as-of valid filter keeps earlier records and drops later ones", () => {
  const now = buildAgencyConstellationView(PARKS, { intelligence, certification });
  assert.ok(now);
  assert.equal(asOfFilterCanNarrow(now), true);

  const asOf = projectAgencyConstellationAsOf(now, "2024-06-01", { axis: "valid" });
  assert.equal(asOf.as_of.day, "2024-06-01");
  assert.equal(asOf.as_of.axis, "valid");

  const nowItems = now.categories.flatMap((c) => c.items.map((i) => `${c.id}:${i.id}`));
  const asOfItems = asOf.categories.flatMap((c) => c.items.map((i) => `${c.id}:${i.id}`));
  assert.ok(asOfItems.length < nowItems.length, "past as-of must visibly narrow the sample");

  for (const category of asOf.categories) {
    for (const item of category.items) {
      assert.ok(item.temporal?.valid_day, `expected valid day on ${item.id}`);
      assert.ok(item.temporal.valid_day <= "2024-06-01", item.temporal.valid_day);
    }
  }

  // Parks rules include 2026 notices in the current sample — they must leave as-of 2024-06-01.
  const nowRules = now.categories.find((c) => c.id === "rules");
  const asOfRules = asOf.categories.find((c) => c.id === "rules");
  if (nowRules?.items.some((item) => dayStamp(item.date) > "2024-06-01")) {
    assert.ok(asOfRules.count < nowRules.items.length || asOfRules.items.every((i) => dayStamp(i.date) <= "2024-06-01"));
    assert.ok(asOf.as_of.counts.excluded_after_as_of >= 1);
  }

  const summary = buildLedgerSummary(now, asOf);
  assert.equal(summary.as_of, "2024-06-01");
  assert.ok(summary.now.item_count > summary.as_of_counts.item_count);
});

test("asOfFilterCanNarrow is false when dated spread is too thin", () => {
  const thin = {
    kind: "agency-constellation",
    categories: [
      {
        id: "contracts",
        items: [{ id: "a", date: "2024-01-01" }],
      },
    ],
  };
  assert.equal(asOfFilterCanNarrow(thin), false);

  const sameDay = {
    kind: "agency-constellation",
    categories: [
      {
        id: "contracts",
        items: [
          { id: "a", date: "2024-01-01" },
          { id: "b", date: "2024-01-01" },
        ],
      },
    ],
  };
  assert.equal(asOfFilterCanNarrow(sameDay), false);

  const useful = {
    kind: "agency-constellation",
    categories: [
      {
        id: "contracts",
        items: [
          { id: "a", date: "2024-01-01" },
          { id: "b", date: "2025-06-01" },
        ],
      },
    ],
  };
  assert.equal(asOfFilterCanNarrow(useful), true);
});

test("system-axis filter does not invent membership without observation clocks", () => {
  const now = buildAgencyConstellationView(PARKS, { intelligence, certification });
  const asOf = projectAgencyConstellationAsOf(now, "2024-06-01", { axis: "system" });
  const systemKnown = now.categories.flatMap((c) => c.items).some((item) => item.observed_at || item.system_time);
  if (!systemKnown) {
    assert.equal(asOf.summary.matched_categories, 0);
  }
});

test("notice temporal facts prefer valid/publication clocks", () => {
  const facts = buildNoticeTemporalFacts({
    request_id: "20260521021",
    start_date: "2026-05-21",
    event_date: "2026-06-01",
  });
  assert.equal(facts.clocks.published_at, "2026-05-21");
  assert.equal(facts.clocks.valid_at, "2026-06-01");
  assert.equal(facts.clocks.observed_at, null);
  assert.equal(facts.system_time_status, "not_retained");

  const before = noticeVisibleAsOf(facts, "2024-01-01", { axis: "valid" });
  assert.equal(before.included, false);
  const after = noticeVisibleAsOf(facts, "2026-12-01", { axis: "valid" });
  assert.equal(after.included, true);
  const system = noticeVisibleAsOf(facts, "2026-12-01", { axis: "system" });
  assert.equal(system.known, false);
  assert.equal(system.basis, "system_time_not_retained");
});

test("notice bitemporal history keeps valid, system, and processing clocks independent", () => {
  const history = buildNoticeBitemporalHistory(
    { request_id: "20240723114" },
    [
      {
        event_id: "cte-published",
        subject_ref: "notice:20240723114",
        event_kind: "procurement.notice_published",
        valid_at: null,
        published_at: "2024-07-23T00:00:00.000Z",
        written_at: "2026-08-01T12:01:00.000Z",
        processed_at: "2026-08-01T12:00:00.000Z",
      },
      {
        event_id: "cte-due",
        subject_ref: "notice:20240723114",
        event_kind: "procurement.solicitation_due",
        valid_at: "2024-08-20",
        published_at: null,
        processed_at: null,
      },
      { event_id: "other", subject_ref: "notice:other", valid_at: "2024-01-01" },
    ],
  );
  assert.equal(history.count, 2);
  const published = history.events.find((event) => event.event_id === "cte-published");
  const due = history.events.find((event) => event.event_id === "cte-due");
  assert.equal(published.clocks.valid_at, null);
  assert.equal(published.clocks.system_at, "2026-08-01T12:01:00.000Z");
  assert.equal(published.clocks.system_basis, "ledger_write");
  assert.equal(published.clocks.processed_at, "2026-08-01T12:00:00.000Z");
  assert.equal(due.clocks.valid_at, "2024-08-20");
  assert.equal(due.clocks.system_at, null);
  assert.equal(due.clocks.system_basis, "unknown");
  assert.equal(due.clocks.processed_at, null);

  const processingFallback = buildNoticeBitemporalHistory(
    { request_id: "20240723114" },
    [{
      event_id: "cte-processing-only",
      subject_ref: "notice:20240723114",
      event_kind: "procurement.notice_published",
      processed_at: "2026-08-01T12:00:00.000Z",
    }],
  ).events[0];
  assert.equal(processingFallback.clocks.system_at, "2026-08-01T12:00:00.000Z");
  assert.equal(processingFallback.clocks.system_basis, "processing_fallback");

  const html = renderNoticeBitemporalHistory({ notice: { request_id: "20240723114" }, events: history.events });
  assert.match(html, /Bitemporal history/);
  assert.match(html, /Valid time/);
  assert.match(html, /Recorded time/);
  assert.match(html, /Notice published/);
  assert.match(html, /Responses due/);
  assert.doesNotMatch(html, /VALID is when|SYSTEM is when|Not recorded/);
  assert.match(html, /data-civic-time-valid=""/);
  assert.doesNotMatch(html, /2024-07-23.*SYSTEM/);
});

test("notice bitemporal history hides an empty retained event set", () => {
  assert.equal(
    renderNoticeBitemporalHistory({ notice: { request_id: "20240723114" }, events: [], state: "ok" }),
    "",
  );
  assert.equal(
    renderNoticeBitemporalHistory({ notice: { request_id: "20240723114" }, events: [], state: "unavailable" }),
    "",
  );
});

test("agency document embeds compact ledger when useful; asOf pre-filters", () => {
  const now = buildAgencyConstellationView(PARKS, { intelligence, certification });
  const htmlNow = renderAgencyConstellationDocument(now);
  assert.match(htmlNow, /data-civic-time-ledger="1"/);
  assert.match(htmlNow, /Filter this agency/);
  assert.doesNotMatch(htmlNow, /System time/);
  assert.doesNotMatch(htmlNow, /not retained/i);
  assert.doesNotMatch(htmlNow, /Sources and limits/);
  assert.doesNotMatch(htmlNow, /Why do we believe this\? ·/);
  assert.match(htmlNow, /civic_time_ledger_runtime\.mjs/);
  assert.match(htmlNow, /As of 2024-06-01/);
  assert.match(htmlNow, /as_of=2024-06-01/);

  const htmlAsOf = renderAgencyConstellationDocument(now, { asOf: "2024-06-01" });
  assert.match(htmlAsOf, /as of 2024-06-01/i);
  assert.match(htmlAsOf, /canonical" href="https:\/\/cityscroll\.org\/agencies\/parks-and-recreation\/\?as_of=2024-06-01"/);
  assert.match(htmlAsOf, /data-as-of="2024-06-01"/);
  assert.match(htmlAsOf, /of\s*<strong>\d+<\/strong>\s*dated records/i);
  // Full now payload remains for client re-filter.
  assert.match(htmlAsOf, /"kind":"agency-constellation"/);
});

test("ledger panel HTML is compact and free of system-time disclaimers", () => {
  const panel = renderCivicTimeLedgerPanel({
    path: "/agencies/parks-and-recreation/",
    asOfDay: "2024-06-01",
    summary: {
      now: { item_count: 10, matched_categories: 4 },
      as_of_counts: { item_count: 4, matched_categories: 2, excluded_after_as_of: 6 },
      arrived_after: [{ id: "x", label: "Later rule", category_id: "rules", date: "2026-05-18" }],
    },
  });
  assert.doesNotMatch(panel, /not retained/i);
  assert.doesNotMatch(panel, /System time/);
  assert.doesNotMatch(panel, /Valid time/);
  assert.doesNotMatch(panel, /we learned on 2024/i);
  assert.match(panel, /name="as_of"/);
  assert.match(panel, /value="2024-06-01"/);
  assert.match(panel, /4.*10.*dated records|4<\/strong> of/s);
  assert.match(panel, /ctl-how/);
});

test("PASSPort revision rematerializes only registered civic-time derived rows", () => {
  const previous = {
    event_id: "passport-due-v1",
    subject_ref: "notice:20260707026",
    event_kind: "procurement.solicitation_due",
    source_record_ref: "passport-rfx:81026B0003",
    source_revision: "rfx:81026B0003:due:2026-08-18",
    payload_hash: "hash-v1",
    materializer_name: "money-lifecycle",
    materializer_version: "3",
    valid_at: "2026-08-18",
    published_at: null,
    observed_at: "2026-07-29T12:00:00.000Z",
    processed_at: "2026-08-11T12:00:00.000Z",
  };
  const revised = {
    ...previous,
    event_id: "passport-due-v2",
    source_revision: "rfx:81026B0003:due:2026-08-25",
    payload_hash: "hash-v2",
    materializer_version: "4",
    valid_at: "2026-08-25",
    observed_at: "2026-08-12T09:00:00.000Z",
    processed_at: "2026-08-12T12:00:00.000Z",
    supersedes_event_id: previous.event_id,
  };
  const unrelated = {
    event_id: "city-record-other",
    subject_ref: "notice:20260801001",
    event_kind: "procurement.notice_published",
    source_record_ref: "city-record:20260801001",
    source_revision: "cr:20260801001:start_date:2026-08-01",
    payload_hash: "other-hash",
    materializer_name: "money-lifecycle",
    materializer_version: "3",
    valid_at: null,
    published_at: "2026-08-01",
    observed_at: "2026-08-02T09:00:00.000Z",
    processed_at: "2026-08-11T12:00:00.000Z",
  };
  const events = [previous, unrelated];
  const registry = buildCivicTimeAffectedObjectRegistry(events);
  const before = buildCivicTimeDerivedRows(events, { referenceDay: "2026-08-12" });
  const change = buildCivicTimeSourceChange(previous, revised);

  assert.equal(registry.schema, CIVIC_TIME_DEPENDENCY_REGISTRY_SCHEMA);
  assert.equal(registry.state, "matched");
  assert.equal(registry.dependencies.length, 1);
  assert.equal(registry.dependencies[0].canonical_href, "/notices/20260707026");

  const result = rematerializeCivicTimeLedger({
    events,
    materializations: before,
    registry,
    change,
    changedEvent: revised,
    referenceDay: "2026-08-12",
    rematerializedAt: "2026-08-12T12:01:00.000Z",
  });

  const affectedRef = "civic-time-ledger:notice:20260707026";
  const unrelatedRef = "civic-time-ledger:notice:20260801001";
  assert.notStrictEqual(result.materializations[affectedRef], before[affectedRef]);
  assert.strictEqual(result.materializations[unrelatedRef], before[unrelatedRef]);
  assert.equal(result.materializations[affectedRef].history.count, 2);
  assert.equal(result.materializations[affectedRef].derived_feature_rollup.counts.materialized, 1);
  assert.deepEqual(
    result.materializations[affectedRef].derived_feature_rollup.spans.valid,
    { start: "2026-08-25", end: "2026-08-25" },
  );

  const receipt = result.receipt;
  assert.equal(receipt.schema, CIVIC_TIME_REMATERIALIZATION_RECEIPT_SCHEMA);
  assert.equal(receipt.state, "rematerialized");
  assert.deepEqual(receipt.scope.affected_derived_rows, [affectedRef]);
  assert.deepEqual(receipt.scope.untouched_derived_rows, [unrelatedRef]);
  assert.equal(receipt.scope.canonical_href, "/notices/20260707026");
  assert.equal(receipt.versions.source.previous_revision, previous.source_revision);
  assert.equal(receipt.versions.source.current_revision, revised.source_revision);
  assert.equal(receipt.versions.materializer.previous, "money-lifecycle@3");
  assert.equal(receipt.versions.materializer.current, "money-lifecycle@4");
  assert.equal(receipt.clocks.source.published_at, null);
  assert.equal(receipt.clocks.source.observed_at, "2026-08-12T09:00:00.000Z");
  assert.equal(receipt.clocks.processing.source_processed_at, "2026-08-12T12:00:00.000Z");
  assert.equal(receipt.clocks.processing.rematerialized_at, "2026-08-12T12:01:00.000Z");
  assert.deepEqual(receipt.invalidation, {
    state: "resolved",
    reason: "source_revision_changed",
    invalidated_derived_rows: [affectedRef],
  });
  assert.deepEqual(receipt.recomputed[0].features, ["notice_bitemporal_history", "derived_feature_rollup"]);
});

test("unregistered changes stay unknown and an empty registry stays empty", () => {
  const empty = buildCivicTimeAffectedObjectRegistry([]);
  assert.equal(empty.state, "empty");
  assert.deepEqual(empty.dependencies, []);

  const materializations = { "civic-time-ledger:notice:keep": Object.freeze({ marker: "untouched" }) };
  const result = rematerializeCivicTimeLedger({
    events: [],
    materializations,
    registry: empty,
    change: {
      change_class: "passport_rfx_revision",
      scope: { source_record_ref: "passport-rfx:unknown", subject_ref: "notice:unknown" },
    },
    changedEvent: null,
    rematerializedAt: "2026-08-12T12:01:00.000Z",
  });
  assert.strictEqual(result.materializations, materializations);
  assert.equal(result.receipt.state, "unknown");
  assert.equal(result.receipt.invalidation.state, "unknown");
  assert.deepEqual(result.receipt.recomputed, []);
});
