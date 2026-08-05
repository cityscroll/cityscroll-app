import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Property domain explorer — process-stage ontology, multi-notice grouping, next-action keys.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PROP_PROCESS_STAGES,
  assertPropertyArchiveSafety,
  buildPropertyExplorerEntries,
  clusterRepeatedEntries,
  countPropertyProcessStages,
  describeCollapsedGroup,
  filterPropertyExplorerEntries,
  partitionPropertyExplorerEntries,
  parcelLookupUrls,
  propertyEntryDefaultQualification,
  propertyExplorerCensusCount,
  propertyProcessActionKey,
  propertyProcessFilterKey,
  propertyProcessStage,
  spineCurrentProcessStage,
} from "../site/property_explorer.mjs";
import { extractPropertyCommercial } from "../site/property_commercial.mjs";
import { extractPropertyReaderActions } from "../site/property_reader_actions.mjs";
import {
  aggregatePhaseEvents,
  buildPropertyPhaseView,
  dedupePhaseSourceLinks,
} from "../site/property_phase_spine.mjs";
import { groupDispositionSpines } from "../worker/src/lib/property_disposition_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_disposition/multi_notice_bbl.json"), "utf8"),
);
const censusFixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_plain_summary/real_notices.json"), "utf8"),
);

function censusEntries(rows, today = "2026-08-04") {
  const prepared = rows.map((source) => {
    const row = structuredClone(source);
    row.commercial = extractPropertyCommercial(row);
    row.property_reader_actions = extractPropertyReaderActions(row, {
      today,
      events: row.commercial.timed_events,
    });
    return row;
  });
  return buildPropertyExplorerEntries(prepared, []);
}

test("PROP_PROCESS_STAGES is the ops-ontology rail (not temporal proposed/soon)", () => {
  const keys = PROP_PROCESS_STAGES.map(([k]) => k);
  assert.deepEqual(keys, [
    "all",
    "hearing",
    "auction_or_rfp",
    "award_or_conveyance",
    "unstaged",
  ]);
  assert.equal(propertyProcessActionKey("hearing"), "disposition_phase_action_attend");
  assert.equal(propertyProcessActionKey("auction_or_rfp"), "disposition_phase_action_bid");
  assert.equal(propertyProcessActionKey("award_or_conveyance"), "disposition_phase_action_conveyance");
  assert.equal(propertyProcessActionKey(null), "property_action_open_notice");
});

test("buildPropertyExplorerEntries collapses multi-notice subjects to one disposition card", () => {
  const spines = groupDispositionSpines(fixture.notices);
  const entries = buildPropertyExplorerEntries(fixture.notices, spines);
  assert.ok(entries.length >= 1);
  const multi = entries.filter((e) => e.kind === "disposition" && e.notice_count > 1);
  assert.ok(multi.length >= 1, "expected at least one multi-notice disposition entry");
  for (const e of multi) {
    assert.ok(e.primary?.request_id);
    assert.ok(e.members.length === e.notice_count);
    assert.ok(e.action_key);
    assert.ok(["hearing", "auction_or_rfp", "award_or_conveyance", null].includes(e.process_stage)
      || e.process_stage == null);
  }
  // Notice count of entries ≤ raw notice count when multi-notice collapse fires.
  assert.ok(entries.length <= fixture.notices.length);
});

test("filterPropertyExplorerEntries respects process stage", () => {
  const spines = groupDispositionSpines(fixture.notices);
  const all = buildPropertyExplorerEntries(fixture.notices, spines);
  const hearings = filterPropertyExplorerEntries(all, { process: "hearing" });
  for (const e of hearings) {
    assert.equal(e.process_filter, "hearing");
  }
  const counts = countPropertyProcessStages(all);
  assert.equal(counts.all, all.length);
  assert.ok(typeof counts.hearing === "number");
});

test("asset facets retain action-bearing non-sale records before current/archive partitioning", () => {
  const [seized] = censusEntries([{
    request_id: "seized-with-inquiry",
    start_date: "2026-08-01",
    short_title: "Pending destruction of seized property",
    additional_description_1: "Inquiries relating to the seized property should be made to the Civil Enforcement Unit.",
  }]);
  assert.equal(seized.primary.commercial.sale_eligible, false);
  assert.equal(seized.primary.property_reader_actions.actionable[0]?.kind, "inquire_claim");

  const filtered = filterPropertyExplorerEntries([seized], {
    asset: "seized_property",
    assetOf: (row) => row.commercial?.item?.category,
    commercialOf: (row) => row.commercial,
  });

  assert.equal(filtered.length, 1, "item type is not a sales-only filter");
  const partition = partitionPropertyExplorerEntries(filtered, { today: "2026-08-04" });
  assert.equal(partition.default_count, 1);
  assert.equal(partition.archive_count, 0);
});

test("aggregatePhaseEvents + dedupePhaseSourceLinks collapse verbatim property stage noise", () => {
  const events = [
    {
      title: "PUBLIC HEARING",
      request_id: "a",
      time: { value: "2013-11-25" },
      source: { url: "https://a856-cityrecord.nyc.gov/RequestDetail/a" },
    },
    {
      title: "PUBLIC HEARING",
      request_id: "b",
      time: { value: "2014-04-23" },
      source: { url: "https://a856-cityrecord.nyc.gov/RequestDetail/a" },
    },
    {
      title: "PROPERTY DISPOSITIONS",
      request_id: "c",
      time: { value: "2015-01-01" },
      source: { url: "https://a856-cityrecord.nyc.gov/RequestDetail/c" },
    },
  ];
  const aggs = aggregatePhaseEvents(events);
  assert.equal(aggs.length, 2);
  const publicHearing = aggs.find((a) => a.title === "PUBLIC HEARING");
  assert.equal(publicHearing.count, 2);
  assert.equal(publicHearing.first, "2013-11-25");
  assert.equal(publicHearing.last, "2014-04-23");
  const links = dedupePhaseSourceLinks(events);
  assert.equal(links.count, 2);
  assert.ok(links.url.includes("RequestDetail"));
});

test("buildPropertyPhaseView stamps aggregates and source_url on matched phases", () => {
  const spines = groupDispositionSpines(fixture.notices);
  const multi = spines.find((s) => (s.join?.notice_count || 0) > 1) || spines[0];
  const view = buildPropertyPhaseView(multi);
  assert.ok(view);
  const matched = view.phases.filter((p) => p.matched);
  assert.ok(matched.length >= 1);
  for (const p of matched) {
    assert.ok(Array.isArray(p.aggregates));
    assert.ok("source_url" in p);
    assert.ok("source_link_count" in p);
  }
  assert.ok(view.action?.action_key);
});

test("propertyProcessStage / filter key map disposition_stage onto process rail", () => {
  assert.equal(propertyProcessStage({ disposition_stage: "hearing" }), "hearing");
  assert.equal(propertyProcessFilterKey({ disposition_stage: null }), "unstaged");
  assert.equal(propertyProcessFilterKey({ disposition_stage: "nope" }), "unstaged");
});

test("parcelLookupUrls returns 10-digit BBL deep links with known hosts", () => {
  const links = parcelLookupUrls("1006440001");
  assert.equal(links.bbl, "1006440001");
  assert.match(links.zola_url, /zola\.planning\.nyc\.gov/);
  assert.match(links.acris_url, /a836-acris\.nyc\.gov/);
  assert.match(links.who_owns_what_url, /whoownswhat\.justfix\.org/);
  assert.equal(parcelLookupUrls("bad"), null);
});

test("spineCurrentProcessStage is the latest matched process phase", () => {
  const spine = {
    stages: [
      { kind: "hearing", matched: true },
      { kind: "auction_or_rfp", matched: true },
      { kind: "award_or_conveyance", matched: false },
    ],
  };
  assert.equal(spineCurrentProcessStage(spine), "auction_or_rfp");
});

test("public Property domain mounts process rail + explorer cards; temporal rail remains", () => {
  const index = SITE_SOURCE;
  assert.match(index, /id="processrail"/);
  assert.match(index, /property-domain-intro/);
  assert.match(index, /function propertyExplorerCardHTML/);
  const cardTemplate = index.slice(
    index.indexOf("function propertyExplorerCardHTML"),
    index.indexOf("function propertyClusterCardHTML"),
  );
  assert.match(cardTemplate, /closed \? "property_action_open_notice"/);
  assert.doesNotMatch(cardTemplate, /t\("property_action_closed"\)/);
  assert.match(index, /buildPropertyExplorerEntries/);
  assert.match(index, /const PROP_STAGES=\[\["all","stage_all"\],\["proposed"/);
  assert.match(index, /function propStage\(r\)/);
  assert.match(index, /propProcessSel/);
  // Aggregate + source dedupe on disposition detail.
  assert.match(index, /p\.aggregates/);
  assert.match(index, /p\.source_url/);
});

// ---- Small-multiples collapse (Tufte) + archive-never-leads honesty ------------------
// Runs of near-identical single notices (same agency + asset + stage + title stem,
// differing only by date) collapse into ONE cluster carrying the count + date range —
// the fix for "five identical destruction notices lead the archive".
function noticeEntry({ id, title, agency = "NYPD", asset = "other", stage = "auction_or_rfp", close, status = "closed" }) {
  return {
    kind: "notice",
    notice_count: 1,
    process_stage: stage,
    process_filter: stage,
    temporal_status: status,
    close_date: close || null,
    primary: { request_id: id, short_title: title, agency_name: agency, _asset: asset, event_date: close || null, type_of_notice_description: "Property Disposition" },
  };
}

test("clusterRepeatedEntries collapses >=3 near-identical single notices into one cluster with a date range", () => {
  const entries = [
    noticeEntry({ id: "1", title: "PROPERTY CLERK INVOICE 1001 PENDING DESTRUCTION", close: "2026-01-10" }),
    noticeEntry({ id: "2", title: "PROPERTY CLERK INVOICE 1002 PENDING DESTRUCTION", close: "2026-03-14" }),
    noticeEntry({ id: "3", title: "PROPERTY CLERK INVOICE 1003 PENDING DESTRUCTION", close: "2026-05-01" }),
    noticeEntry({ id: "4", title: "PROPERTY CLERK INVOICE 1004 PENDING DESTRUCTION", close: "2026-02-02" }),
    noticeEntry({ id: "5", title: "PROPERTY CLERK INVOICE 1005 PENDING DESTRUCTION", close: "2026-04-04" }),
  ];
  const out = clusterRepeatedEntries(entries);
  assert.equal(out.length, 1, "five near-identical notices become one card");
  const cluster = out[0];
  assert.equal(cluster.kind, "cluster");
  assert.equal(cluster.count, 5);
  assert.equal(cluster.members.length, 5, "every member is preserved (expandable, not deleted)");
  assert.equal(cluster.date_range.start, "2026-01-10");
  assert.equal(cluster.date_range.end, "2026-05-01");
  assert.equal(cluster.temporal_status, "closed");
  assert.equal(cluster.description, "NYPD property clerk invoice pending destruction");
});

test("describeCollapsedGroup falls back to common agency, notice type, and then dates", () => {
  const typed = [
    noticeEntry({ id: "1", title: "2026-01-01 / 10001", agency: "Department of Citywide Administrative Services" }),
    noticeEntry({ id: "2", title: "2026-02-01 / 10002", agency: "Department of Citywide Administrative Services" }),
  ];
  assert.equal(describeCollapsedGroup(typed), "DCAS property disposition");
  const dated = typed.map((member) => ({ ...member, primary: { ...member.primary, agency_name: null, type_of_notice_description: null } }));
  assert.equal(describeCollapsedGroup(dated), "Dated notices");
});

test("clusterRepeatedEntries leaves distinct notices and small runs (<3) untouched", () => {
  const entries = [
    noticeEntry({ id: "a", title: "Sale of surplus fire apparatus", asset: "vehicle", close: "2026-06-01", status: "open" }),
    noticeEntry({ id: "b", title: "PROPERTY CLERK INVOICE 1 PENDING DESTRUCTION", close: "2026-01-01" }),
    noticeEntry({ id: "c", title: "PROPERTY CLERK INVOICE 2 PENDING DESTRUCTION", close: "2026-02-01" }),
  ];
  const out = clusterRepeatedEntries(entries);
  assert.equal(out.length, 3, "a pair (<3) does not collapse; a unique notice stays");
  assert.ok(out.every((e) => e.kind === "notice"));
});

test("clusterRepeatedEntries never collapses already-grouped multi-notice spines", () => {
  const spine = { kind: "notice", notice_count: 3, process_filter: "hearing", temporal_status: "closed", primary: { request_id: "s", short_title: "PROPERTY CLERK INVOICE PENDING DESTRUCTION", agency_name: "NYPD", _asset: "other" } };
  const entries = [
    spine,
    noticeEntry({ id: "1", title: "PROPERTY CLERK INVOICE 1 PENDING DESTRUCTION", stage: "hearing", close: "2026-01-01" }),
    noticeEntry({ id: "2", title: "PROPERTY CLERK INVOICE 2 PENDING DESTRUCTION", stage: "hearing", close: "2026-02-01" }),
    noticeEntry({ id: "3", title: "PROPERTY CLERK INVOICE 3 PENDING DESTRUCTION", stage: "hearing", close: "2026-03-01" }),
  ];
  const out = clusterRepeatedEntries(entries);
  // The 3 single notices collapse; the multi-notice spine is left as its own entry.
  assert.ok(out.some((e) => e.kind === "cluster" && e.count === 3));
  assert.ok(out.some((e) => e === spine), "multi-notice spine is untouched");
});

test("renderPropExplorer keeps the closed archive one tap away instead of appending it to the default feed", () => {
  const index = readFileSync(join(ROOT, "site/app/property.mjs"), "utf8");
  const routing = readFileSync(join(ROOT, "site/app/routing.mjs"), "utf8");
  const markup = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /partitionPropertyExplorerEntries/);
  assert.match(index, /propertyView===\"archive\"/);
  assert.match(routing, /q\.set\("view", "archive"\)/);
  assert.match(markup, /id="property-view-switch"/);
  assert.match(index, /property_nothing_current/);
  assert.match(index, /data-property-empty-watch/);
  assert.match(index, /propertyActionEnablingInfoHTML/);
  assert.match(index, /property_related_current_sales/);
  // Small-multiples collapse is wired into the feed.
  assert.match(index, /clusterRepeatedEntries/);
  assert.match(index, /propertyClusterCardHTML/);
});

test("default Property qualification follows live typed events and exposed participatory actions", () => {
  const rows = censusFixture.cases.map((entry) => entry.row);
  const entries = censusEntries(rows);
  const partition = partitionPropertyExplorerEntries(entries, { today: "2026-08-04" });
  const ids = (list) => list.flatMap((entry) => entry.members.map((row) => row.request_id));

  assert.deepEqual(ids(partition.default_entries).sort(), [
    "20200128107", // evergreen Property Clerk claim route
    "20251106024", // recurring weekly auto auction remains open through source end date
    "20260526003", // seized-products inquiry route
  ]);
  assert.ok(ids(partition.archive_entries).includes("20240108007"), "Public Hearing pointer is archived");
  assert.ok(ids(partition.archive_entries).includes("20140403113"), "closed medallion result is archived");
  assert.ok(ids(partition.archive_entries).includes("20170512106"), "closed UDAAP hearing is archived");
  assert.ok(ids(partition.archive_entries).includes("20211118008"), "closed acquisition hearing is archived");
  assert.equal(partition.default_count + partition.archive_count, partition.census_total);
  assert.equal(partition.census_total, rows.length);
});

test("default qualification consumes the same closed lifecycle as card tense", () => {
  const row = {
    request_id: "2019-surplus",
    short_title: "The City is currently selling surplus assets online",
    start_date: "2019-01-01",
    additional_description_1: "To begin bidding, register at https://example.gov/auction.",
    commercial: {
      close_date: "2019-01-31",
      glance: { close_date: "2019-01-31", item: "Equipment" },
      timed_events: [],
    },
  };
  row.property_reader_actions = extractPropertyReaderActions(row, { today: "2026-08-04" });
  const [entry] = buildPropertyExplorerEntries([row], []);
  const qualification = propertyEntryDefaultQualification(entry, { today: "2026-08-04" });
  const partition = partitionPropertyExplorerEntries([entry], { today: "2026-08-04" });

  assert.equal(row.property_reader_actions.lifecycle.state, "closed");
  assert.equal(qualification.lifecycle_state, "closed");
  assert.equal(qualification.qualified, false);
  assert.equal(partition.default_count, 0);
  assert.equal(partition.archive_count, 1);
});

test("source lifecycle end keeps a recurring sale current in the route payload", () => {
  const row = {
    request_id: "recurring-auto-auction",
    short_title: "AUTO AUCTION",
    start_date: "2025-11-14",
    end_date: "2027-05-03",
    additional_description_1: "Auctions are held every week at https://example.gov/auction. All auctions are open to the public and registration is free.",
    commercial: {
      close_date: "2025-11-14",
      glance: { close_date: "2025-11-14", item: "Vehicles" },
      timed_events: [],
    },
  };
  row.property_reader_actions = extractPropertyReaderActions(row, { today: "2026-08-04" });
  const [entry] = buildPropertyExplorerEntries([row], []);
  const qualification = propertyEntryDefaultQualification(entry, { today: "2026-08-04" });
  const partition = partitionPropertyExplorerEntries([entry], { today: "2026-08-04" });

  assert.equal(row.property_reader_actions.lifecycle.state, "open");
  assert.equal(qualification.lifecycle_state, "open");
  assert.equal(qualification.qualified, true);
  assert.equal(partition.default_count, 1);
  assert.equal(partition.archive_count, 0);
});

test("future sales and hearings remain in the default feed; actionless destruction and fallback records do not", () => {
  const rows = [
    {
      request_id: "open-medallion",
      start_date: "2026-08-01",
      short_title: "Medallion sale upset price",
      additional_description_1: "All bids must be submitted by September 10, 2026 for the medallion sale.",
    },
    {
      request_id: "live-hearing",
      start_date: "2026-08-01",
      event_date: "2026-09-12",
      short_title: "Public hearing for an acquisition and easement",
      additional_description_1: "People wishing to be heard may attend the public hearing on September 12, 2026.",
    },
    {
      request_id: "destruction-no-contact",
      start_date: "2026-08-01",
      short_title: "Pending destruction of unauthorized tobacco products",
      additional_description_1: "The listed unauthorized products are pending destruction.",
    },
    {
      request_id: "honest-fallback",
      start_date: "2026-08-01",
      short_title: "Property Disposition",
      additional_description_1: "Official record only.",
    },
  ];
  const partition = partitionPropertyExplorerEntries(censusEntries(rows), { today: "2026-08-04" });
  const ids = (list) => list.map((entry) => entry.primary.request_id).sort();
  assert.deepEqual(ids(partition.default_entries), ["live-hearing", "open-medallion"]);
  assert.deepEqual(ids(partition.archive_entries), ["destruction-no-contact", "honest-fallback"]);
  assert.equal(propertyExplorerCensusCount(partition.default_entries), 2);
  assert.equal(propertyExplorerCensusCount(partition.archive_entries), 2);
});

test("archive safety detector rejects a record with a live typed event or exposed action", () => {
  const [live] = censusEntries([{
    request_id: "live-sale",
    start_date: "2026-08-01",
    short_title: "Notice of Public Sale of Residential Property",
    additional_description_1: "All bids must be submitted by September 20, 2026.",
  }]);
  assert.throws(
    () => assertPropertyArchiveSafety([live], { today: "2026-08-04" }),
    /live-sale/,
  );
});

test("Property cards lead with the cached plain variant and disclose the exact legal title", () => {
  const source = readFileSync(join(ROOT, "site/app/property.mjs"), "utf8");
  const summarySource = readFileSync(join(ROOT, "site/property_plain_summary.mjs"), "utf8");
  const cardTemplate = source.slice(
    source.indexOf("function propertyExplorerCardHTML"),
    source.indexOf("function propClusterRange"),
  );
  assert.match(source, /ensurePropertyCardPlainSummary/);
  assert.match(cardTemplate, /property-card-summary/);
  assert.match(summarySource, /property-card-title-source/);
  assert.match(summarySource, /property-card-original-title/);
  assert.match(cardTemplate, /data-card-fact/);
  assert.ok(
    cardTemplate.indexOf("property-card-summary") < cardTemplate.indexOf("propertyCardTitleDisclosureHTML"),
    "plain summary call leads the title-disclosure call",
  );
});
