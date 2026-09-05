/**
 * PHC-04 — bridges testimony given at an exact Council hearing-to-matter
 * join to the legislative path that matter is actually on, without
 * attributing any outcome to that testimony.
 *
 *   node --test test/legislative_hearing_consequence.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TESTIMONY_RECORD_LABEL,
  projectLegislativeHearingConsequence,
  renderLegislativeHearingConsequence,
} from "../site/legislative_hearing_consequence.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";

const goldFixtures = JSON.parse(
  readFileSync(new URL("fixtures/consequence_projection/gold_fixtures.v0.json", import.meta.url), "utf8"),
);
const goldCase = (id) => goldFixtures.cases.find((c) => c.id === id);
const sharedModel = JSON.parse(readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url), "utf8"));

// The Council-hearing/land-use gold fixture: exact single-matter join on
// matter 79200, hearing outcome "Laid Over by Subcommittee". This matter has
// no entry in site/data/legislative_matter_lookup.json, so it is the fixture
// for the honest "no published amendment or vote yet" state.
function singleMatterNoLookupRecord(overrides = {}) {
  const record = structuredClone(goldCase("full-council-hearing-land-use-matched-join").record);
  record.agency = "City Council";
  return { ...record, ...overrides };
}

// Matter 78605 (LU 0056-2026) has two observed appearances in
// site/data/legislative_matter_lookup.json: a 2026-04-22 hearing that laid it
// over, then a 2026-05-19 hearing that recorded a roll-call vote approving
// it. Building the exact join on the *first* appearance's request id exercises
// the "next published vote" state; building it on the *second* exercises the
// "this hearing's own action is not mistaken for a future event" state.
function matter78605Record(requestId, { outcome, eventName, eventDate } = {}) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: `${eventDate}T11:00:00-04:00`,
    decides: "Zoning, 147-14 Northern Boulevard Rezoning, Queens (C 220415 ZMQ).",
    council_hearing_kind: "land_use",
    meeting_outcome: {
      request_id: requestId,
      snapshot_state: "present",
      event: { event_id: "any", name: eventName, date: eventDate, url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=any", documents: [] },
      matters: [{
        matter_id: "78605",
        matter_file: "LU 0056-2026",
        matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=78605",
        title: "Zoning, 147-14 Northern Boulevard Rezoning, Queens (C 220415 ZMQ).",
        outcome,
      }],
      join: { matched: true, method: "exact_date_body_tokens" },
    },
  };
}

function present(matters) {
  return {
    snapshot_state: "present",
    join: { matched: true, method: "exact_date_body_tokens" },
    matters,
  };
}

function meeting(requestId, outcome) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: "2026-07-22T11:00:00-04:00",
    meeting_outcome: outcome,
  };
}

// ---- A1/G1: a single exact match renders a consequence block tied to that matter ----

test("A1/G1: a request with one exact matter renders a consequence block tied to that matter", () => {
  const record = singleMatterNoLookupRecord();
  const projection = projectLegislativeHearingConsequence(record);
  assert.equal(projection.state, "single");
  assert.equal(projection.matter.matter_id, "79200");
  assert.equal(projection.process_position.label, "Laid Over by Subcommittee");
  assert.equal(projection.testimony_record.label, TESTIMONY_RECORD_LABEL);

  const html = renderLegislativeHearingConsequence(record);
  assert.match(html, /data-legislative-hearing-consequence="1"/);
  assert.match(html, /data-matter-id="79200"/);
  assert.match(html, /Laid Over by Subcommittee/);
});

test("A1: the consequence block sits above the existing continuation on the materialized meeting document", () => {
  const row = sharedModel.rows.find((candidate) => candidate.meeting_id === "meeting:city_record:20260707022");
  assert.ok(row?.meeting_outcome, "the shared meeting model should carry the outcome projection");
  const html = renderMeetingDocument(row, sharedModel);
  const consequenceIndex = html.indexOf('data-legislative-hearing-consequence="1"');
  const continuationIndex = html.indexOf('data-council-matter-continuation="1"');
  assert.ok(consequenceIndex > -1, "the consequence block should render");
  assert.ok(continuationIndex > -1, "the existing continuation should still render");
  assert.ok(consequenceIndex < continuationIndex, "the consequence block should sit above the continuation");
});

// ---- A2/G2: several strict matches require matter selection, never a blended consequence ----

test("A2/G2: a request with several strict matches shows no blended consequence", () => {
  const record = meeting("20260707021", present([
    { matter_id: "79201", matter_file: "LU 0115-2026", title: "A", outcome: "Laid Over by Subcommittee" },
    { matter_id: "79202", matter_file: "LU 0116-2026", title: "B", outcome: "Laid Over by Subcommittee" },
  ]));
  const projection = projectLegislativeHearingConsequence(record);
  assert.equal(projection.state, "multiple");
  assert.equal(projection.matter, null);
  const html = renderLegislativeHearingConsequence(record);
  assert.equal(html, "");
});

// ---- A3/G3: unmatched, missing, or title-only relations mint no continuation ----

test("A3/G3: an unmatched notice mints no consequence", () => {
  const record = meeting("20260827001", { snapshot_state: "absent" });
  assert.equal(projectLegislativeHearingConsequence(record).state, "unmatched");
  assert.equal(renderLegislativeHearingConsequence(record), "");
});

test("A3/G3: a matched hearing with no underlying matter mints no consequence", () => {
  const record = meeting("20260827002", present([]));
  assert.equal(projectLegislativeHearingConsequence(record).state, "no_matter");
  assert.equal(renderLegislativeHearingConsequence(record), "");
});

test("A3/G3 adversarial near-match: a title-only relation fails closed and leaks no matter detail", () => {
  const record = meeting("20260827003", {
    snapshot_state: "present",
    join: { matched: true, method: "title_similarity" },
    matters: [{ matter_id: "99999", title: "Same words as the hearing", outcome: "Approved by Subcommittee" }],
  });
  const projection = projectLegislativeHearingConsequence(record);
  assert.equal(projection.state, "unknown");
  assert.equal(projection.matter, null);
  const html = renderLegislativeHearingConsequence(record);
  assert.equal(html, "");
  assert.doesNotMatch(html, /99999|Same words|Approved by Subcommittee/);
});

test("A3/G3: a missing/unavailable relation mints no consequence", () => {
  const record = { source_system: "city_record", meeting_id: "meeting:city_record:20260827004", request_id: "20260827004" };
  assert.equal(projectLegislativeHearingConsequence(record).state, "unavailable");
  assert.equal(renderLegislativeHearingConsequence(record), "");
});

// ---- A4/A5: process position and testimony destination never attribute causation, and are separate activities ----

test("A4/A5: the copy separates public testimony from committee questioning and never attributes causation to either", () => {
  const record = singleMatterNoLookupRecord();
  const html = renderLegislativeHearingConsequence(record);
  assert.match(html, /Public testimony given at this hearing becomes part of the official hearing record/);
  assert.match(html, /questions committee members asked witnesses are a separate activity from public testimony/);
  assert.match(html, /neither one by itself decides the matter/);
  // Negative rule: never say testimony determined, approved, or defeated the matter.
  assert.doesNotMatch(html, /testimony (determined|approved|defeated|decided|caused)/i);
  assert.doesNotMatch(html, /(because|as a result) of (the )?testimony/i);
});

test("A4: the process position is framed as the committee's own recorded action, citing the official matter source", () => {
  const record = singleMatterNoLookupRecord();
  const html = renderLegislativeHearingConsequence(record);
  assert.match(html, /Where this matter stands:/);
  assert.match(html, /recorded this action at this hearing: Laid Over by Subcommittee/);
  assert.match(html, /href="https:\/\/nyc\.legistar\.com\/Gateway\.aspx\?M=L&amp;ID=79200"/);
});

// ---- A6: a published amendment or vote appears as the next official event, never as testimony's effect ----

test("A6: a later published vote on the same matter surfaces as the next official event", () => {
  const record = matter78605Record("20260408025", {
    outcome: "Laid Over by Subcommittee",
    eventName: "Subcommittee on Zoning and Franchises",
    eventDate: "2026-04-22",
  });
  const projection = projectLegislativeHearingConsequence(record);
  assert.equal(projection.state, "single");
  assert.ok(projection.next_event, "a later vote should be found");
  assert.equal(projection.next_event.label, "Approved by Subcommittee");
  assert.equal(projection.next_event.date, "2026-05-19");

  const html = renderLegislativeHearingConsequence(record);
  assert.match(html, /Next official event on this matter: Approved by Subcommittee/);
  assert.match(html, /2026-05-19/);
  assert.doesNotMatch(html, /No published amendment or vote/);
});

test("A6/negative rule: a hearing that is itself the matter's most recent appearance names no future event, even though its own action was a vote", () => {
  // 20260428021 is matter 78605's *last* observed appearance in the lookup
  // (the 2026-05-19 vote itself). Building the exact join on it must not
  // mistake its own recorded action for a future "next official event".
  const record = matter78605Record("20260428021", {
    outcome: "Approved by Subcommittee",
    eventName: "Subcommittee on Zoning and Franchises",
    eventDate: "2026-05-19",
  });
  const projection = projectLegislativeHearingConsequence(record);
  assert.equal(projection.state, "single");
  assert.equal(projection.next_event, null);
  assert.equal(projection.process_position.label, "Approved by Subcommittee");

  const html = renderLegislativeHearingConsequence(record);
  assert.match(html, /No published amendment or vote on this matter has followed this hearing yet/);
});

test("A6: a matter with no legislative_matter_lookup.json entry honestly states no amendment or vote has followed yet", () => {
  const record = singleMatterNoLookupRecord();
  const projection = projectLegislativeHearingConsequence(record);
  assert.equal(projection.next_event, null);
  const html = renderLegislativeHearingConsequence(record);
  assert.match(html, /No published amendment or vote on this matter has followed this hearing yet/);
});

// ---- negative rule: no consequence block without an exact single-matter join ----

test("negative rule: an empty record produces no state, no matter, and no rendered block", () => {
  const projection = projectLegislativeHearingConsequence({});
  assert.equal(projection.state, "unavailable");
  assert.equal(projection.matter, null);
  assert.equal(renderLegislativeHearingConsequence({}), "");
});
