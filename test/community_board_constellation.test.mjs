import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCommunityBoardConstellationView,
  buildCommunityBoardEdgeSummary,
  communityBoardInstitutionHref,
  communityBoardOutputHref,
  communityBoardPath,
  communityBoardPlaceHref,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { entityPivotRouteStatus } from "../site/edge_summary.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url)));
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const meetingIndex = JSON.parse(readFileSync(new URL("../site/data/community_board_meeting_index.json", import.meta.url)));

const sources = { sourceRegistry, sourceInventory, scorecard, geography };

test("board routes preserve the separate place, governance, and output projections", () => {
  assert.equal(communityBoardPath("bronx-cb-02"), "/community-boards/bronx-cb-02/");
  assert.equal(communityBoardPlaceHref({ borough: "Bronx", community_district_id: "X02" }), "/near-you/#map?level=community_district&parent=Bronx&id=X02&lens=meetings");
  assert.equal(communityBoardInstitutionHref("bronx-cb-02"), "/browse/people/?board=bronx-cb-02#community-boards");
  assert.equal(communityBoardOutputHref("bronx-cb-02"), "/community-boards/#board-bronx-cb-02");
});
test("board constellation uses typed summaries and holds unjoined governance edges", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", sources);
  assert.equal(view.kind, "community-board-constellation");
  assert.equal(view.summary.matched_categories, 2);
  assert.deepEqual(view.categories.map((category) => category.status), ["matched", "matched", "unknown", "unknown", "unknown"]);
  const matched = buildCommunityBoardEdgeSummary(view).filter((edge) => edge.state === "matched");
  assert.ok(matched.every((edge) => edge.source && edge.source.name && entityPivotRouteStatus(edge.href).verified));
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "hosts_meeting")?.href, null);
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "has_member")?.href, null);
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "issues_recommendation")?.href, null);
  assert.equal(view.local_constellation.kind, "community-board");
});

test("board document keeps empty or unknown categories honest and resident-readable", () => {
  const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("bronx-cb-02", sources));
  assert.match(html, /Connected board records/);
  assert.match(html, /District coverage/);
  assert.match(html, /Official source inventory/);
  assert.match(html, /Meetings and hearings \(Unknown \/ not indexed\)/);
  assert.match(html, /Board members \(Not yet shown — official board records are still being collected\)/);
  assert.match(html, /Board recommendations \(Not yet shown — official board records are still being collected\)/);
  assert.match(html, /Open official calendar/);
  assert.doesNotMatch(html, /matter_title_place|venue_line|boro_cd|Source: Unavailable|Join method: Unavailable/);
  assert.doesNotMatch(html, /No meetings exist/);
});

test("board profile renders receipt-backed records while leaving unjoined records non-official", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", {
    ...sources,
    sourceRecords: [{
      record_kind: "document",
      record_id: "minutes-1",
      source_record_id: "minutes-1",
      source_url: "https://board.example/minutes",
      record_url: "https://board.example/minutes/2026-08-12.pdf",
      title: "Full board minutes",
      date: "2026-08-12",
      category: "minutes",
      observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
    }],
  });
  assert.equal(view.source_records[0].state, "observed");
  assert.equal(view.categories.find((category) => category.id === "meetings").status, "matched");
  assert.equal(view.categories.find((category) => category.id === "members").status, "unknown");
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  assert.match(visible, /Board records from official sources/);
  assert.match(visible, /Full board minutes/);
  assert.match(visible, /Source observed/);
  assert.doesNotMatch(visible, /record_kind|source_record_id|observed_receipt|Source: Unavailable|Join method: Unavailable/);
});

test("indexed board events replace the unknown meetings state without becoming official joins", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-06", {
    ...sources,
    sourceRecords: meetingIndex.by_board,
  });
  const meetings = view.categories.find((category) => category.id === "meetings");
  assert.equal(meetings.status, "matched");
  assert.equal(meetings.count, 12);
  assert.ok(meetings.items.every((item) => item.state === "observed"));
  assert.ok(meetings.items.every((item) => item.join?.matched !== true));
  const html = renderCommunityBoardConstellationDocument(view);
  assert.doesNotMatch(html, /Meetings and hearings \(Unknown \/ not indexed\)/);
  assert.match(html, /Source observed/);
});
