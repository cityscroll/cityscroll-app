import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AS_OF_QUERY_KEY,
  TIME_AXES,
  asOfFilterCanNarrow,
  asOfHref,
  buildLedgerSummary,
  buildNoticeTemporalFacts,
  classifyItemTemporal,
  dayStamp,
  normalizeAsOfDay,
  noticeVisibleAsOf,
  parseAsOfFromSearch,
  projectAgencyConstellationAsOf,
  renderCivicTimeLedgerPanel,
} from "../site/civic_time_ledger.mjs";
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
