// CBICS-04: Month and List over the Community Board's accepted proceedings
// population. This suite pins: Month appears only once the density rule
// qualifies (A1), Month and List project the same accepted meeting
// identities within the rendered range (A2), committee/full-board host and
// proceeding form stay visible in both projections (A3), unjoined /
// stale-rejected / parser-failed / diagnostic rows never reach the calendar
// (A4), coverage-unavailable stays distinct from no-scheduled-meetings (A5),
// sparse boards stay list-only with no empty calendar furniture (A6), and
// canonical board/meeting routes are untouched (A7). It also covers no-JS
// List usability and the switch's native keyboard/focus affordances.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommunityBoardConstellationView,
  communityBoardPath,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";

const TODAY = "2026-05-01";

function boardSources(bodyId, institutionEdges, overrides = {}) {
  return {
    sourceRegistry: { sources: [] },
    sourceInventory: { boards: [] },
    scorecard: { rows: [], as_of: TODAY },
    geography: {
      nodes: [{
        type: "community-board",
        id: `community-board:${bodyId}`,
        name: overrides.name || "Manhattan Community Board 4",
        properties: { body_id: bodyId, borough: "Manhattan", community_district_id: "M04" },
      }],
    },
    today: TODAY,
    institutionEdges: { [bodyId]: institutionEdges },
    ...overrides,
  };
}

function acceptedEdge({
  id,
  date,
  host = "board",
  form = null,
  boardId = "manhattan-cb-04",
  title,
}) {
  const to = `meeting:community_board:${id}`;
  const from = host === "committee"
    ? `community-board-committee:${boardId}:land-use`
    : `community-board:${boardId}`;
  return {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from,
    to,
    target_kind: "meeting",
    target_id: to,
    target_name: title || (host === "committee" ? "Land Use Committee Meeting" : "Full Board Meeting"),
    href: `/meetings/${encodeURIComponent(to)}`,
    canonical_href: `/meetings/${encodeURIComponent(to)}`,
    ...(host === "committee" ? { committee_name: "Land Use Committee" } : {}),
    ...(form ? { proceeding_form: form } : {}),
    join: { matched: true, event_date: date },
    source_url: "https://www.nyc.gov/site/cb4/calendar.page",
    source_receipt: { status: "ok", observed_at: "2026-04-01T00:00:00Z" },
    provenance: { source_url: "https://www.nyc.gov/site/cb4/calendar.page" },
  };
}

function heldEdge({ id, date, boardId = "manhattan-cb-04" }) {
  const to = `meeting:community_board:${id}`;
  return {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "held",
    promoted: false,
    reason: "evidence_held",
    from: `community-board:${boardId}`,
    to,
    target_kind: "meeting",
    target_id: to,
    target_name: "Unconfirmed board meeting",
    href: null,
    canonical_href: null,
    join: { matched: false, event_date: date },
    source_url: "https://www.nyc.gov/site/cb4/calendar.page",
  };
}

function denseEdges() {
  return [
    acceptedEdge({ id: "cb4-full-1", date: "2026-05-04", host: "board" }),
    acceptedEdge({ id: "cb4-lu-1", date: "2026-05-11", host: "committee", form: "meeting" }),
    acceptedEdge({ id: "cb4-hearing-1", date: "2026-05-18", host: "board", form: "public_hearing" }),
  ];
}

test("A1: a board with three accepted proceedings in-window shows Month and List", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", denseEdges()));
  assert.equal(view.proceedings_calendar.render, true);
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /data-board-proceedings-view="1"/);
  assert.match(html, /compact-month-grid/);
  assert.match(html, /data-board-proceedings-panel="list"/);
  assert.match(html, />Month</);
  assert.match(html, />List</);
});

test("A2: Month and List project the same accepted meeting identities in the rendered range", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", denseEdges()));
  const calendar = view.proceedings_calendar;
  assert.equal(calendar.render, true);
  const monthUids = new Set(
    calendar.weeks.flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]).map((occ) => occ.uid),
  );
  const acceptedInRange = view.categories.find((category) => category.id === "meetings").items
    .filter((item) => item.state === "official" && item.date >= calendar.grid_from && item.date <= calendar.grid_to)
    .map((item) => item.target_id);
  assert.equal(monthUids.size, 3);
  assert.deepEqual([...monthUids].sort(), acceptedInRange.sort());
  const html = renderCommunityBoardConstellationDocument(view);
  const listPanel = html.match(/data-board-proceedings-panel="list">([\s\S]*?)<\/div>\s*<\/div>/)[1];
  for (const uid of monthUids) {
    assert.match(listPanel, new RegExp(encodeURIComponent(uid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("A3: committee and full-board host and proceeding form remain visible in both projections", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", denseEdges()));
  const html = renderCommunityBoardConstellationDocument(view);
  const monthPanel = html.match(/data-board-proceedings-panel="month">([\s\S]*?)<\/div>\s*<div class="board-proceedings-panel board-proceedings-panel-list"/)[1];
  // Full board, committee, and public-hearing form are each distinguishable
  // in the Month panel, not merged into one indistinct "Event" label.
  assert.match(monthPanel, /Land Use Committee/);
  assert.match(monthPanel, /Full Board/);
  assert.match(monthPanel, /Public hearing/);
  // ...and the List keeps the same host/form vocabulary it always has.
  assert.match(html, /Land Use Committee.*·.*Meeting/);
  assert.match(html, /Full Board.*·.*Meeting/);
});

test("A4: unjoined, held, and diagnostic rows never inflate the calendar", () => {
  const edges = [
    ...denseEdges(),
    heldEdge({ id: "cb4-held-1", date: "2026-05-06" }),
    heldEdge({ id: "cb4-held-2", date: "2026-05-07" }),
  ];
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", {
    ...boardSources("manhattan-cb-04", edges),
    sourceRecords: [{
      record_kind: "event",
      record_id: "cb4-diagnostic-1",
      source_record_id: "cb4-diagnostic-1",
      title: "Unmatched publisher meeting row",
      date: "2026-05-08",
      source_role: "upcoming_meetings",
      source_url: "https://www.nyc.gov/site/cb4/calendar.page",
    }],
  });
  const calendar = view.proceedings_calendar;
  assert.equal(calendar.render, true);
  const monthUids = new Set(
    calendar.weeks.flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]).map((occ) => occ.uid),
  );
  assert.equal(monthUids.size, 3);
  assert.ok(![...monthUids].some((uid) => uid.includes("held") || uid.includes("diagnostic")));
  const html = renderCommunityBoardConstellationDocument(view);
  const monthPanel = html.match(/data-board-proceedings-panel="month">([\s\S]*?)<\/div>\s*<div class="board-proceedings-panel board-proceedings-panel-list"/)[1];
  assert.doesNotMatch(monthPanel, /Unconfirmed board meeting/);
  assert.doesNotMatch(monthPanel, /Unmatched publisher meeting row/);
  // The List still keeps the held rows visible (unchanged prior behavior) —
  // Month is a stricter projection of the same accepted population, not a
  // second, looser one.
  assert.match(html, /Unconfirmed board meeting/);
});

test("A5: coverage unavailable remains distinct from no scheduled meetings", () => {
  const noMeetings = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", []));
  assert.equal(noMeetings.proceedings_calendar.render, false);
  assert.equal(noMeetings.proceedings_calendar.reason, "unavailable-no-occurrences");
  const meetingsCategory = noMeetings.categories.find((category) => category.id === "meetings");
  assert.equal(meetingsCategory.status, "unknown");
  const html = renderCommunityBoardConstellationDocument(noMeetings);
  assert.doesNotMatch(html, /data-board-proceedings-view="1"/);
  assert.match(html, /Not yet established from checked sources:.*proceedings/);
});

test("A6: sparse boards remain list-only with no empty calendar furniture", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", [
    acceptedEdge({ id: "cb4-sparse-1", date: "2026-05-04", host: "board" }),
  ]));
  assert.equal(view.proceedings_calendar.render, false);
  assert.equal(view.proceedings_calendar.reason, "sparse-too-few-occurrences");
  const html = renderCommunityBoardConstellationDocument(view);
  assert.doesNotMatch(html, /data-board-proceedings-view="1"/);
  assert.doesNotMatch(html, /compact-month/);
  assert.doesNotMatch(html, />Month</);
  assert.match(html, /Full Board/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("A7: canonical board and meeting routes are unchanged for direct visits and deep links", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", denseEdges()));
  assert.equal(communityBoardPath("manhattan-cb-04"), "/community-boards/manhattan-cb-04/");
  assert.equal(view.path, "/community-boards/manhattan-cb-04/");
  const calendar = view.proceedings_calendar;
  const cellByDate = new Map(calendar.weeks.flat().map((day) => [day.date, day]));
  const meetingsCategory = view.categories.find((category) => category.id === "meetings");
  for (const item of meetingsCategory.items.filter((row) => row.state === "official")) {
    const cell = cellByDate.get(item.date);
    if (!cell) continue;
    const occurrence = [...cell.visible_occurrences, ...cell.overflow_occurrences].find((occ) => occ.uid === item.target_id);
    assert.ok(occurrence, `expected ${item.target_id} in the month grid`);
    // Same canonical destination behind both the List link and the Month
    // link — one meeting route, never a calendar-specific fork of it.
    assert.equal(occurrence.canonical_url, `https://cityscroll.org${item.href}`);
  }
  // The document never introduces hash/query view state: a direct visit or a
  // refresh always lands on the same default (List) rendering.
  const html = renderCommunityBoardConstellationDocument(view);
  assert.doesNotMatch(html, /#month|#list|\?view=/);
});

test("the List stays fully usable with no JavaScript: it is present, checked by default, and complete", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", denseEdges()));
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /class="board-proceedings-view-radio board-proceedings-view-radio-list" checked/);
  const listPanel = html.match(/data-board-proceedings-panel="list">([\s\S]*?)<\/div>\s*<\/div>/)[1];
  assert.match(listPanel, /Full Board/);
  assert.match(listPanel, /Land Use Committee/);
  assert.match(listPanel, /Public hearing/);
});

test("the Month/List switch uses native, keyboard-operable radios with a legend and labelled controls", () => {
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", denseEdges()));
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, /<fieldset class="board-proceedings-view-switch"><legend class="board-proceedings-view-switch-legend">Show proceedings as<\/legend>/);
  const monthId = html.match(/<input type="radio" id="(board-proceedings-view-month-[^"]+)"/)?.[1];
  const listId = html.match(/<input type="radio" id="(board-proceedings-view-list-[^"]+)"/)?.[1];
  assert.ok(monthId && listId);
  assert.match(html, new RegExp(`<label class="board-proceedings-view-tab" for="${monthId}">Month</label>`));
  assert.match(html, new RegExp(`<label class="board-proceedings-view-tab" for="${listId}">List</label>`));
});

test("a reschedule or cancellation that drops a meeting from accepted evidence removes it from both projections", () => {
  const edges = denseEdges();
  const view = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", edges));
  const droppedUid = edges[1].to;
  // The board's own source join is the single admission gate (Theory /
  // mechanism): once a meeting is no longer accepted evidence — the
  // published outcome of a reschedule or cancellation — it simply is not in
  // the accepted population either projection draws from.
  const stillAccepted = edges.filter((edge) => edge.to !== droppedUid);
  const after = buildCommunityBoardConstellationView("manhattan-cb-04", boardSources("manhattan-cb-04", stillAccepted));
  const afterUids = new Set(
    (after.proceedings_calendar.weeks || []).flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]).map((occ) => occ.uid),
  );
  assert.ok(!afterUids.has(droppedUid));
  const afterHtml = renderCommunityBoardConstellationDocument(after);
  assert.doesNotMatch(afterHtml, /Land Use Committee/);
  assert.notEqual(view.proceedings_calendar.render, undefined);
});
