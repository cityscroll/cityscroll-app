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
import { readCommunityBoardMeetingIndex } from "../tools/lib/community_board_meeting_index_io.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url)));
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const communityBoardMoney = JSON.parse(readFileSync(new URL("../site/data/community_board_money.json", import.meta.url)));
const meetingIndex = readCommunityBoardMeetingIndex(new URL("../site/data/community_board_meeting_index.json", import.meta.url));

const sources = { sourceRegistry, sourceInventory, scorecard, geography };

test("board routes preserve the separate place, governance, and output projections", () => {
  assert.equal(communityBoardPath("bronx-cb-02"), "/community-boards/bronx-cb-02/");
  assert.equal(communityBoardPlaceHref({ borough: "Bronx", community_district_id: "X02" }), "/near-you/#map?level=community_district&parent=Bronx&id=X02&lens=meetings");
  assert.equal(communityBoardInstitutionHref("bronx-cb-02"), "/community-boards/bronx-cb-02/");
  assert.equal(communityBoardOutputHref("bronx-cb-02"), "/community-boards/#board-bronx-cb-02");
});
test("board source inventory surfaces the image-linked CB6 Airtable minutes archive", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-06", sources);
  const sourceCategory = view.categories.find((category) => category.id === "sources");
  const minutes = sourceCategory.items.find((item) => item.role === "minutes");
  assert.equal(minutes.url, "https://airtable.com/appgK5bKw7rWMRJEh/shrBzfHDWat4YMTHL/tblpioBcj0BVp5hBw");
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /Open minutes or records/);
  assert.match(html, /appgK5bKw7rWMRJEh\/shrBzfHDWat4YMTHL\/tblpioBcj0BVp5hBw/);
});
test("board constellation uses typed summaries and holds unjoined governance edges", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", sources);
  assert.equal(view.kind, "community-board-constellation");
  assert.equal(view.summary.matched_categories, 2);
  assert.deepEqual(view.categories.map((category) => category.status), ["matched", "matched", "unknown", "unknown", "unknown", "unknown"]);
  const matched = buildCommunityBoardEdgeSummary(view).filter((edge) => edge.state === "matched");
  assert.ok(matched.every((edge) => edge.source && edge.source.name && entityPivotRouteStatus(edge.href).verified));
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "hosts_meeting")?.href, null);
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "has_member")?.href, null);
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "issues_recommendation")?.href, null);
  assert.equal(view.local_constellation.kind, "community-board");
});

test("board document keeps empty or unknown categories honest and resident-readable", () => {
  const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("bronx-cb-02", sources));
  assert.match(html, /Connected civic objects/);
  assert.match(html, /About this board/);
  assert.match(html, /District coverage/);
  assert.match(html, /Sources &amp; coverage/);
  assert.match(html, /Upcoming &amp; recent proceedings \(Records not shown\)/);
  assert.match(html, /People \(Records not shown\)/);
  assert.match(html, /Matters &amp; actions \(Records not shown\)/);
  assert.match(html, /Open official calendar/);
  assert.doesNotMatch(html, /Board records from official sources/);
  assert.doesNotMatch(html, /matter_title_place|venue_line|boro_cd|Source: Unavailable|Join method: Unavailable/);
  assert.doesNotMatch(html, /No meetings exist/);
});

test("board dossier embeds the exact read-model money card without changing its architecture", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-01", {
    ...sources,
    communityBoardMoney,
  });
  assert.equal(view.money.board_id, "bronx-cb-01");
  assert.equal(view.money.state, "separate_fiscal_years");
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /data-community-board-money="1"/);
  assert.match(html, /Budget &amp; spending/);
  assert.match(html, /Payments posted through June 30, 2026/);
  assert.match(html, /Sources and coverage/);
  assert.match(html, /data-community-board-constellation-category="committees"/);
});

test("minutes freshness keeps an unchecked source in resident language", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", sources);
  view.minutes_freshness = {
    state: "unavailable",
    latest_date: null,
    label: "Minutes archive could not be checked",
    age_days: null,
  };
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /Minutes archive could not be checked/);
  assert.doesNotMatch(html, /Minutes source unavailable/);
});

test("board profile renders receipt-backed records without counting them as accepted meetings", () => {
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
  assert.equal(view.categories.find((category) => category.id === "meetings").status, "unknown");
  assert.equal(view.categories.find((category) => category.id === "meetings").count, null);
  assert.equal(view.categories.find((category) => category.id === "members").status, "unknown");
  const html = renderCommunityBoardConstellationDocument(view);
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  assert.match(visible, /Unjoined source records \(diagnostic\)/);
  assert.match(visible, /Full board minutes/);
  assert.match(visible, /Source observed/);
  assert.doesNotMatch(visible, /record_kind|source_record_id|observed_receipt|Source: Unavailable|Join method: Unavailable/);
});

test("indexed board events stay source records until accepted institution edges are supplied", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-06", {
    ...sources,
    sourceRecords: meetingIndex.by_board,
  });
  const meetings = view.categories.find((category) => category.id === "meetings");
  assert.equal(meetings.status, "unknown");
  assert.equal(meetings.count, null);
  assert.deepEqual(meetings.items, []);
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /Upcoming &amp; recent proceedings \(Records not shown\)/);
  assert.match(html, /Source observed/);
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(visible, /upcoming_meetings/);
  assert.match(visible, /Upcoming meetings/);
});

test("committee-hosted meeting is rendered through the board-local committee category", () => {
  const meetingEdge = {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from: "community-board-committee:manhattan-cb-06:transportation",
    to: "meeting:community_board:cb6-transport",
    target_kind: "meeting",
    target_id: "meeting:community_board:cb6-transport",
    target_name: "Transportation Committee Meeting",
    href: "/meetings/meeting%3Acommunity_board%3Acb6-transport",
    canonical_href: "/meetings/meeting%3Acommunity_board%3Acb6-transport",
    board_href: "/community-boards/manhattan-cb-06/",
    institution_refs: {
      board_ref: "community-board:manhattan-cb-06",
      committee_ref: "community-board-committee:manhattan-cb-06:transportation",
    },
    parent_board_ref: "community-board:manhattan-cb-06",
    provenance: { source_url: "https://cbsix.org/meetings-calendar/", observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" } },
  };
  const committeeEdge = {
    relation: "has_committee",
    edge_type: "has_committee",
    status: "promoted",
    promoted: true,
    from: "community-board:manhattan-cb-06",
    to: "community-board-committee:manhattan-cb-06:transportation",
    target_kind: "community-board-committee",
    target_id: "community-board-committee:manhattan-cb-06:transportation",
    target_name: "Transportation Committee",
    provenance: { source_url: "https://cbsix.org/meetings-calendar/", observed_on: "2026-08-25" },
  };
  const view = buildCommunityBoardConstellationView("manhattan-cb-06", {
    ...sources,
    institutionEdges: { "manhattan-cb-06": [committeeEdge, meetingEdge] },
  });
  const committees = view.categories.find((category) => category.id === "committees");
  const meetings = view.categories.find((category) => category.id === "meetings");
  assert.equal(committees.items[0].target_id, committeeEdge.target_id);
  assert.equal(meetings.items[0].target_id, meetingEdge.target_id);
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "has_committee").target_kind, "community-board-committee");
  const visible = renderCommunityBoardConstellationDocument(view).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  assert.match(visible, /Committees/);
  assert.match(visible, /Transportation Committee Meeting/);
});

test("board people constellation items expose generic refs without changing board-local identity", () => {
  const sourceDocument = {
    publisher_document_id: "cb6-roster-2026-08-25",
    document_url: "https://cbsix.org/about-us/board-members-and-staff/",
    date: "2026-08-25",
    observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
  };
  const view = buildCommunityBoardConstellationView("manhattan-cb-06", {
    ...sources,
    boardRelations: {
      "manhattan-cb-06": {
        relationships: [{
          board_id: "manhattan-cb-06",
          publisher_person_id: "jane-001",
          person_name: "Jane Doe",
          relation: "member_of",
          role: "appointed_member",
          relation_date: "2026-08-25",
          source_document: sourceDocument,
        }],
      },
    },
  });
  const member = view.categories.find((category) => category.id === "members").items[0];
  assert.equal(member.person_ref, "community-board-person:manhattan-cb-06:jane-001");
  assert.equal(member.generic_person_ref, "person:community-board:manhattan-cb-06:jane-001");
});

test("accepted meeting source rows render once through their semantic meeting object", () => {
  const meetingId = "meeting:community_board:cb6-transport";
  const meetingEdge = {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from: "community-board-committee:manhattan-cb-06:transportation",
    to: meetingId,
    target_kind: "meeting",
    target_id: meetingId,
    target_name: "Transportation Committee Meeting",
    href: "/meetings/meeting%3Acommunity_board%3Acb6-transport",
    canonical_href: "/meetings/meeting%3Acommunity_board%3Acb6-transport",
    committee_name: "Transportation Committee",
    source_record_id: "cb6-transport",
    join: { matched: true, event_date: "2026-09-02" },
    source_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
    provenance: { source_url: "https://cbsix.org/meetings-calendar/" },
  };
  const view = buildCommunityBoardConstellationView("manhattan-cb-06", {
    ...sources,
    sourceRecords: [{
      record_kind: "event",
      record_id: "cb6-transport",
      source_record_id: "cb6-transport",
      title: "Transportation Committee Meeting",
      date: "2026-09-02",
      source_role: "upcoming_meetings",
      source_url: "https://cbsix.org/meetings-calendar/",
    }],
    institutionEdges: { "manhattan-cb-06": [meetingEdge] },
  });
  assert.equal(view.source_records.length, 0, "accepted event was removed from diagnostic source rows");
  const visible = renderCommunityBoardConstellationDocument(view)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
  assert.equal((visible.match(/Transportation Committee Meeting/g) || []).length, 1);
  assert.match(visible, /Transportation Committee .*Published event/);
  assert.doesNotMatch(visible, /Board records from official sources|Unjoined source records/);
});
