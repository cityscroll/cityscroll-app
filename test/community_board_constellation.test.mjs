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
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { entityPivotRouteStatus } from "../site/edge_summary.mjs";
import { readCommunityBoardMeetingIndex } from "../tools/lib/community_board_meeting_index_io.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url)));
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const communityBoardMoney = JSON.parse(readFileSync(new URL("../site/data/community_board_money.json", import.meta.url)));
const communityBoardParticipation = JSON.parse(readFileSync(new URL("../site/data/community_board_participation.json", import.meta.url)));
const communityBoardPayrollContext = JSON.parse(readFileSync(new URL("../site/data/community_board_payroll_staff_count.json", import.meta.url)));
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
  const categorySections = html.split('<section class="edge-summary-rail')[0];
  const categoryText = categorySections.replace(/<[^>]+>/g, "");
  assert.match(html, /Connected civic objects/);
  assert.match(html, /About this board/);
  assert.match(html, /District coverage/);
  assert.match(html, /Sources &amp; coverage/);
  assert.match(categorySections, /data-community-board-empty-coverage="1"/);
  assert.match(categoryText, /Not yet established from checked sources: committees, proceedings, people, and matters &amp; actions\./);
  for (const id of ["committees", "meetings", "members", "recommendations"]) {
    assert.match(categorySections, new RegExp(`data-community-board-constellation-category="${id}"`));
  }
  assert.doesNotMatch(categorySections, /Committees \(Records not shown\)|Upcoming &amp; recent proceedings \(Records not shown\)|People \(Records not shown\)|Matters &amp; actions \(Records not shown\)/);
  assert.doesNotMatch(categorySections, /<section[^>]+data-community-board-constellation-category="(committees|meetings|members|recommendations)"/);
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

test("board dossier renders owner-approved payroll context for a two-row board", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", {
    ...sources,
    communityBoardPayrollContext,
  });
  const html = renderCommunityBoardConstellationDocument(view);
  assert.equal(view.payroll.active_row_count, 2);
  assert.match(html, /data-community-board-payroll="1"/);
  assert.match(html, /DISTRICT MANAGER/);
  assert.match(html, /Regular gross paid/);
  assert.match(html, /not unique people/);
  assert.doesNotMatch(html, /too few|k-suppress|employee_id|last_name/i);
});

test("Queens CB12 renders an honest zero-ACTIVE payroll state", () => {
  const view = buildCommunityBoardConstellationView("queens-cb-12", {
    ...sources,
    communityBoardPayrollContext,
  });
  const html = renderCommunityBoardConstellationDocument(view);
  assert.equal(view.payroll.state, "zero_active");
  assert.match(html, /0 ACTIVE payroll rows; 3 non-ACTIVE published rows/);
  assert.match(html, /No ACTIVE title rows were published/);
});

test("partial board dossier keeps the money card inside the existing hierarchy", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-03", {
    ...sources,
    communityBoardMoney,
  });
  assert.equal(view.money.board_id, "bronx-cb-03");
  assert.equal(view.money.state, "unmatched_identity");
  const html = renderCommunityBoardConstellationDocument(view);
  const about = html.indexOf("data-community-board-about");
  const money = html.indexOf('id="community-board-money"');
  const governance = html.indexOf("data-community-board-governance");
  const committees = html.indexOf('data-community-board-constellation-category="committees"');
  const meetings = html.indexOf('data-community-board-constellation-category="meetings"');
  const members = html.indexOf('data-community-board-constellation-category="members"');
  const sourcesIdx = html.indexOf('data-community-board-constellation-category="sources"');
  const map = html.indexOf("community-board-local-constellation-heading");
  assert.ok(about > 0 && money > about);
  assert.ok(governance === -1 || money < governance);
  assert.ok(committees > money && meetings > money && members > money && sourcesIdx > money);
  assert.ok(map > money);
  assert.match(html, /data-money-state="unmatched_identity"/);
  assert.match(html, /\$340,425\.00/);
  assert.match(html, /does not establish an accepted exact financial identity/);
  assert.match(html, /Sources and coverage/);
  assert.doesNotMatch(html, /Spending in your district|View payments|remaining budget/i);
});

test("populated committee data keeps its category section and source-backed record", () => {
  const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("bronx-cb-01", {
    ...sources,
    institutionEdges: {
      "bronx-cb-01": [{
        relation: "has_committee",
        edge_type: "has_committee",
        status: "promoted",
        promoted: true,
        from: "community-board:bronx-cb-01",
        to: "community-board-committee:bronx-cb-01:land-use",
        target_kind: "community-board-committee",
        target_id: "community-board-committee:bronx-cb-01:land-use",
        committee_id: "land-use",
        target_name: "Land Use Committee",
        provenance: { source_url: "https://board.example/committees", observed_on: "2026-08-27" },
      }],
    },
  }));
  assert.match(html, /<section[^>]+data-community-board-constellation-category="committees"[^>]*><h2>Committees \(Available: 1 record\)<\/h2>/);
  assert.match(html, /Land Use Committee/);
  assert.match(html, /data-community-board-empty-coverage="1"/);
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
  assert.match(visible, /Official documents/);
  assert.doesNotMatch(visible, /\(diagnostic\)/);
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
  assert.match(html, /data-community-board-empty-coverage="1"/);
  assert.match(html, /proceedings/);
  assert.doesNotMatch(html, /Upcoming &amp; recent proceedings \(Records not shown\)/);
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
          person_name: "Ada Lovelace",
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

test("Manhattan CB2 board document composes source-backed ways to participate without an Apply now CTA", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-02", {
    ...sources,
    communityBoardParticipation,
    institutionEdges: {
      "manhattan-cb-02": [{
        relation: "hosts_meeting",
        edge_type: "hosts_meeting",
        status: "promoted",
        promoted: true,
        from: "community-board:manhattan-cb-02",
        to: "meeting:community_board:cb2-full-board",
        target_kind: "meeting",
        target_id: "meeting:community_board:cb2-full-board",
        target_name: "Manhattan CB2 Full Board",
        href: "/meetings/meeting%3Acommunity_board%3Acb2-full-board",
        canonical_href: "/meetings/meeting%3Acommunity_board%3Acb2-full-board",
        join: { matched: true, event_date: "2026-09-10" },
        source_receipt: { status: "ok", observed_at: "2026-08-27T00:00:00Z" },
        provenance: { source_url: "https://cbmanhattan.cityofnewyork.us/cb2/calendar/" },
      }],
    },
  });
  const html = renderCommunityBoardConstellationDocument(view);
  assert.equal(view.participation.board_id, "manhattan-cb-02");
  assert.match(html, /data-community-board-participation="1"/);
  assert.match(html, /Ways to participate/);
  assert.match(html, /Attend the next board meeting/);
  assert.match(html, /Add to calendar/);
  assert.match(html, /Follow Manhattan Community Board 2/);
  assert.match(html, /Contact this board/);
  assert.match(html, /Public committee membership/);
  assert.match(html, /participation-source:manhattan-bp:2026/);
  assert.match(html, /About this board/);
  assert.match(html, /Sources &amp; coverage/);
  assert.match(html, /Open this board’s place view/);
  assert.doesNotMatch(html, /Apply now/);
  assert.doesNotMatch(html, /Speak or comment/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("a board without equivalent participation evidence keeps records and omits unsupported applications", () => {
  const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("bronx-cb-02", {
    ...sources,
    communityBoardParticipation,
  }));
  assert.match(html, /data-community-board-participation="1"/);
  assert.match(html, /Follow Bronx Community Board 2/);
  assert.match(html, /Contact this board/);
  assert.match(html, /About this board/);
  assert.match(html, /Sources &amp; coverage/);
  assert.match(html, /District coverage/);
  assert.match(html, /participation-source:bronx-bp:2026/);
  assert.match(html, /The published application window is closed/);
  assert.doesNotMatch(html, /Apply now/);
  assert.doesNotMatch(html, /Public committee membership/);
  assert.doesNotMatch(html, /Attend the next/);
  assert.doesNotMatch(html, /Speak or comment/);
  assert.doesNotMatch(html, /participation-source:manhattan-bp:2026/);
  assert.doesNotMatch(html, /No meetings exist/);
  assert.deepEqual(detectNodePageCruft(html), []);
});
