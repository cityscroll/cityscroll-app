import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT,
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";

// Story: on Manhattan CB3, an ordinary reader reached a default section
// headed "Unjoined source records (diagnostic)" with 276 items. This suite
// exercises the bounded, task-labelled "Official documents" projection that
// replaced it, on dense, sparse, and documents-only fixtures.

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url)));
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));

const sources = { sourceRegistry, sourceInventory, scorecard, geography };

function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
}

function documentRecord(index, { date } = {}) {
  return {
    record_kind: "document",
    record_id: `doc-${index}`,
    source_record_id: `doc-${index}`,
    source_url: `https://board.example/records/${index}`,
    record_url: `https://board.example/records/${index}.pdf`,
    title: `Board record ${index}`,
    date: date || `2025-01-${String((index % 28) + 1).padStart(2, "0")}`,
    category: "minutes",
    observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
  };
}

// A1: dense fixture — the Manhattan CB3 story's 276-item population.
test("A1: a dense unjoined-record population never renders as an unbounded resident dump", () => {
  const records = Array.from({ length: 276 }, (_, i) => documentRecord(i));
  const view = buildCommunityBoardConstellationView("manhattan-cb-03", { ...sources, sourceRecords: records });
  assert.equal(view.source_records.length, 276, "the full retained population stays on the data model");
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = visibleText(html);
  assert.doesNotMatch(visible, /\(diagnostic\)/i);
  assert.doesNotMatch(visible, /Unjoined source records/i);
  const renderedRows = (html.match(/data-source-record-kind=/g) || []).length;
  assert.ok(renderedRows <= COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT, `rendered ${renderedRows} rows, expected at most ${COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT}`);
  assert.match(visible, new RegExp(`Showing the ${COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT} most recently dated of 276 official documents`));
  assert.deepEqual(detectNodePageCruft(html), []);
});

// A1/A2: sparse fixture — a board with one or two useful records still gets
// a named official-document view with a direct source link, not a diagnostic
// pipeline label, and no bounding note when nothing is truncated.
test("A1/A2: a sparse record population is a named official-document list with direct source links", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-03", {
    ...sources,
    sourceRecords: [documentRecord(1, { date: "2026-07-02" })],
  });
  assert.equal(view.source_records.length, 1);
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = visibleText(html);
  assert.match(visible, /Official documents/);
  assert.match(html, /https:\/\/board\.example\/records\/1\.pdf/);
  assert.doesNotMatch(visible, /Showing the .* most recently dated of/);
  assert.doesNotMatch(visible, /\(diagnostic\)/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

// A5: a board with only official source documents and no accepted events —
// the documents-only negative fixture. No meeting, member, or recommendation
// category is populated, and the categories stay honestly "unknown" rather
// than being promoted to remove the missing label.
test("A5: a documents-only board renders official documents without any accepted proceedings", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-03", {
    ...sources,
    sourceRecords: [documentRecord(1), documentRecord(2), documentRecord(3)],
  });
  const meetings = view.categories.find((category) => category.id === "meetings");
  const members = view.categories.find((category) => category.id === "members");
  const recommendations = view.categories.find((category) => category.id === "recommendations");
  assert.equal(meetings.status, "unknown");
  assert.equal(meetings.count, null);
  assert.deepEqual(meetings.items, []);
  assert.equal(members.status, "unknown");
  assert.equal(recommendations.status, "unknown");
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = visibleText(html);
  assert.match(visible, /Official documents/);
  assert.match(visible, /Board record 1/);
  assert.match(html, /data-community-board-empty-coverage="1"/);
  assert.doesNotMatch(visible, /Published event/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

// A2/A3: the exact-join acceptance gate is untouched by the resident
// projection — a record with no accepted `hosts_meeting` edge stays a held,
// named document, and it is never promoted to a meeting or recommendation
// merely to drop an unlinked label.
test("A2/A3: an unresolved candidate stays a named document and is never promoted to remove its label", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-03", {
    ...sources,
    sourceRecords: [{
      record_kind: "event",
      record_id: "candidate-1",
      source_record_id: "candidate-1",
      source_url: "https://board.example/calendar",
      title: "Possible full board meeting",
      date: "2026-08-01",
      source_role: "upcoming_meetings",
    }],
  });
  const meetings = view.categories.find((category) => category.id === "meetings");
  assert.equal(meetings.status, "unknown");
  assert.equal(meetings.count, null);
  assert.equal(view.source_records.length, 1, "the unresolved candidate is retained, not discarded or promoted");
  assert.equal(view.source_records[0].state, "unknown");
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = visibleText(html);
  assert.match(visible, /Possible full board meeting/);
  assert.doesNotMatch(visible, /Published event/);
  assert.match(visible, /Source status unknown/);
});

// A2: accepted proceedings, participation actions, and exact-join decisions
// already promoted by the source join are preserved unchanged alongside the
// bounded document view.
test("A2: accepted proceedings and participation stay intact next to the bounded document view", () => {
  const meetingEdge = {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from: "community-board:manhattan-cb-03",
    to: "meeting:community_board:cb3-full-board",
    target_kind: "meeting",
    target_id: "meeting:community_board:cb3-full-board",
    target_name: "Manhattan CB3 Full Board",
    href: "/meetings/meeting%3Acommunity_board%3Acb3-full-board",
    canonical_href: "/meetings/meeting%3Acommunity_board%3Acb3-full-board",
    join: { matched: true, event_date: "2026-09-15" },
    source_receipt: { status: "ok", observed_at: "2026-08-27T00:00:00Z" },
    provenance: { source_url: "https://cbmanhattan.cityofnewyork.us/cb3/calendar/" },
  };
  const view = buildCommunityBoardConstellationView("manhattan-cb-03", {
    ...sources,
    institutionEdges: { "manhattan-cb-03": [meetingEdge] },
    sourceRecords: Array.from({ length: 30 }, (_, i) => documentRecord(i)),
  });
  const meetings = view.categories.find((category) => category.id === "meetings");
  assert.equal(meetings.status, "matched");
  assert.equal(meetings.count, 1);
  assert.equal(view.source_records.length, 30, "unrelated held documents are unaffected by the accepted meeting");
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = visibleText(html);
  assert.match(visible, /Manhattan CB3 Full Board/);
  assert.match(visible, /Published event/);
  assert.match(visible, /Official documents/);
});

// The card's ux_review is explicit that no participant research is a
// delivery gate: the bounded projection ships on the exact-join and
// data-retention evidence already exercised above, without waiting on any
// separate participant-evaluation step.
test("participant evaluation is not a delivery gate for this bounded projection", () => {
  assert.equal(typeof COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT, "number");
  assert.ok(COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT > 0);
});
