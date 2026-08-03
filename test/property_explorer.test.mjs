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
  buildPropertyExplorerEntries,
  countPropertyProcessStages,
  filterPropertyExplorerEntries,
  parcelLookupUrls,
  propertyProcessActionKey,
  propertyProcessFilterKey,
  propertyProcessStage,
  spineCurrentProcessStage,
} from "../site/property_explorer.mjs";
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
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /id="processrail"/);
  assert.match(index, /property-domain-intro/);
  assert.match(index, /function propertyExplorerCardHTML/);
  assert.match(index, /buildPropertyExplorerEntries/);
  assert.match(index, /const PROP_STAGES=\[\["all","stage_all"\],\["proposed"/);
  assert.match(index, /function propStage\(r\)/);
  assert.match(index, /propProcessSel/);
  // Aggregate + source dedupe on disposition detail.
  assert.match(index, /p\.aggregates/);
  assert.match(index, /p\.source_url/);
});
