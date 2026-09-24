/**
 * Friction capability: materialize board agenda segments without a budget
 * worked example (alias c13ef9aaec82b).
 *
 * A5 honesty: untimed agenda-ol support was added because the M3 brief needs
 * it. M3 therefore proves the data/config-only ADDITION property (admitting M3
 * touches no parser/renderer/adapter source), not a blind held-out generalization
 * of untimed parsing. Untimed parsing itself is exercised with a synthetic
 * agenda-ol page in every run; the product M3 fixture is the data-only admit.
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseHearingAgendaSegments } from "../warehouse/lib/community_board_hearing_context.mjs";
import { meetingForSource } from "../tools/build_community_board_hearing_context.mjs";
import edgeWorker, {
  attachHearingContextAgendaSegments,
  isMeetingDocumentHtml,
} from "../site/pages_edge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const ARTIFACT = read("site/data/community_board_hearing_context.json");
const MANIFEST = read("warehouse/fixtures/community-board-hearing-context/manifest.json");
const INDEX = read("site/data/community_board_meeting_index.json");
const SHARED = read("site/data/shared_meeting_read_model.json");
const CB5 = read("site/data/non_council_outcome_sources/retained_snapshots/manhattan-cb-05.upcoming_meetings.json");

const M1 = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const M2 = "https://cb14brooklyn.com/meeting/public-hearing-on-ulurp-application-and-executive-committee-meeting-september-2026/";
const M3 = "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";

const byKey = (key) => ARTIFACT.boards.find((row) => row.meeting_key === key);
const bySource = (url) => ARTIFACT.boards.find((row) => row.hearing?.source_url === url);
const m3Admitted = MANIFEST.boards.some((row) => row.meeting_key === "m3")
  && existsSync(join(ROOT, "warehouse/fixtures/community-board-hearing-context/m3.json"));

const DETAIL_EVIDENCE_DIR = join(ROOT, "docs/evidence/community-board-agenda-detail-routes");
const DETAIL_EVIDENCE_PATH = join(DETAIL_EVIDENCE_DIR, "read-back.json");

function meetingIdForSource(url) {
  return `meeting:community_board:${url}`;
}

function extractRenderedAgendaSegments(html) {
  const section = html.match(
    /<section[^>]*data-meeting-agenda-segments="(\d+)"[^>]*>([\s\S]*?)<\/section>/,
  );
  if (!section) return [];
  const items = [];
  const rowRe = /<li[^>]*class="meeting-agenda-segment"[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = rowRe.exec(section[2]))) {
    const row = match[0];
    const title = row.match(/<p class="meeting-agenda-segment-title">([\s\S]*?)<\/p>/)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim() || null;
    const start = row.match(/data-agenda-segment-start="([^"]*)"/)?.[1] || null;
    const kind = row.match(/data-agenda-segment-kind="([^"]*)"/)?.[1] || null;
    const orderRaw = row.match(/data-agenda-segment="([^"]*)"/)?.[1];
    const order = orderRaw ? Number(orderRaw) : null;
    items.push({ order, start_time: start, kind, title });
  }
  return items;
}

async function loadMeetingDetail(url) {
  const meetingId = meetingIdForSource(url);
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const href = typeof request === "string" ? request : String(request.url || "");
        if (href.includes("/data/community_board_hearing_context.json")) {
          return new Response(JSON.stringify(ARTIFACT));
        }
        if (href.includes("/data/shared_meeting_read_model.json")) {
          return new Response(JSON.stringify(SHARED));
        }
        return new Response("missing", { status: 404 });
      },
    },
  };
  const path = `https://cityscroll.org/meetings/${encodeURIComponent(meetingId)}/`;
  const response = await edgeWorker.fetch(new Request(path), env);
  const html = await response.text();
  return { meetingId, path, response, html, segments: extractRenderedAgendaSegments(html) };
}
test("A1 M1 and M2 materialize timed segments through the same acquisition and materialization path", () => {
  const m1 = byKey("m1") || bySource(M1);
  const m2 = byKey("m2") || bySource(M2);
  assert.ok(m1, "M1 is materialized");
  assert.ok(m2, "M2 is materialized");
  assert.equal(m1.hearing.segments.length, 3);
  assert.ok(m1.hearing.segments.every((segment) => segment.start_time));
  assert.equal(m2.hearing.segments.length, 2);
  assert.ok(m2.hearing.segments.every((segment) => segment.start_time));
  assert.match(m2.hearing.segments[0].title, /ULURP|1584 Flatbush/i);
  assert.match(m2.hearing.segments[1].title, /Executive Committee/i);
  assert.ok(m1.previous_cycle, "M1 may keep previous-cycle budget context");
  assert.equal(m2.previous_cycle, undefined, "M2 has no budget worked example");
});

test(
  "A2 held-out M3 yields four untimed items without a budget record or September 14 participation copy",
  { skip: !m3Admitted && "M3 product admission is the follow-on data/config-only change" },
  () => {
    const m3 = byKey("m3") || bySource(M3);
    assert.ok(m3, "M3 is materialized");
    assert.equal(m3.hearing.segments.length, 4);
    assert.ok(m3.hearing.segments.every((segment) => segment.start_time == null));
    assert.equal(m3.previous_cycle, undefined);
    const m1 = byKey("m1") || bySource(M1);
    if (m1.hearing.participation?.speaking_registration_url) {
      assert.notEqual(
        m3.hearing.participation?.speaking_registration_url,
        m1.hearing.participation.speaking_registration_url,
      );
    }
    const m3Participation = JSON.stringify(m3.hearing.participation || {});
    assert.ok(!m3Participation.includes("September 14"));
    assert.equal(MANIFEST.boards.find((row) => row.meeting_key === "m3")?.has_previous_cycle, false);
  },
);

test("A3 calendar-only CB5 stays a meeting with a source link and no fabricated agenda", () => {
  const events = CB5?.source_records || [];
  assert.ok(Array.isArray(events) && events.length >= 1, "CB5 retained snapshot has meetings");
  const sample = events[0];
  const source = sample.record_url || sample.source_url || sample.url;
  assert.ok(source, "CB5 meeting keeps a source link");
  assert.equal(sample.record_kind, "event");
  // Calendar-only CB5 is not published as a hearing-context agenda reading.
  for (const board of ARTIFACT.boards) {
    assert.notEqual(board.board_id, "manhattan-cb-05");
  }
  assert.equal(
    ARTIFACT.boards.some((board) => (board.hearing?.segments || []).length && board.board_id === "manhattan-cb-05"),
    false,
  );
});

test("A4 M2 keeps 810 East 16th venue separate from 1584 Flatbush subject", () => {
  const m2 = byKey("m2") || bySource(M2);
  assert.ok(m2);
  const shared = SHARED.rows.find((row) => String(row.meeting_id).includes("public-hearing-on-ulurp"));
  assert.ok(shared, "M2 detail route identity exists in the shared meeting catalog");
  const venue = shared.venue?.address || shared.address || "";
  assert.match(venue, /810 East 16th/i);
  assert.ok(!/1584 Flatbush/i.test(venue), "venue is not replaced by the application subject");
  const subject = m2.hearing.segments.map((segment) => segment.title).join(" ");
  assert.match(subject, /1584 Flatbush/i);
  const join = meetingForSource({ boardId: "brooklyn-cb-14", sourceUrl: M2, index: INDEX });
  assert.ok(join?.meeting_id, "M2 joins a published meeting identity");
  assert.ok(join.href, "M2 has a generated detail route");
});

test("A5 untimed path is shared; M3 admission is data/config-only; detail routes render agenda segments", async () => {
  // Untimed support was built for the M3 brief. A synthetic agenda-ol page
  // exercises that shared parser path without treating product M3 as a blind
  // hold-out for the parser itself.
  const synthetic = parseHearingAgendaSegments(
    '<ol class="wp-block-list agenda-ol"><li>One</li><li>Two</li><li>Three</li><li>Four</li></ol>',
  );
  assert.equal(synthetic.length, 4);
  assert.ok(synthetic.every((segment) => segment.start_time == null));

  const adapterSources = [
    "warehouse/lib/community_board_hearing_context.mjs",
    "tools/acquire_community_board_hearing_context.mjs",
    "tools/build_community_board_hearing_context.mjs",
    "site/community_board_hearing_context.mjs",
  ];

  if (!m3Admitted) {
    assert.equal(MANIFEST.boards.some((row) => row.meeting_key === "m3"), false);
    assert.ok(MANIFEST.boards.some((row) => row.meeting_key === "m2" && row.has_previous_cycle === false));
    return;
  }

  const receiptPath = join(ROOT, "warehouse/receipts/proof/community_board_agenda_m3_data_only_admission.json");
  assert.ok(existsSync(receiptPath), "M3 data-only admission receipt is retained");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.admission, "data_config_only");
  assert.equal(receipt.untimed_support_origin, "m3_brief");
  assert.deepEqual(receipt.code_paths_unchanged_by_m3_admission, adapterSources);
  assert.equal(receipt.pre_admission_revision?.sha, "0ffa4b220e054d3b80bd3f58ef867999c1374ada");
  assert.equal(receipt.admission_revision?.sha, "b68323332c12ded48f4f69985025020861145cf4");
  assert.deepEqual(receipt.admission_revision?.parser_renderer_adapter_paths_touched, []);
  assert.ok(Array.isArray(receipt.admission_revision?.files));
  assert.ok(receipt.admission_revision.files.every((path) => (
    path.startsWith("site/data/")
    || path.startsWith("warehouse/fixtures/")
    || path.startsWith("warehouse/receipts/")
  )), "admission file list stays data/configuration only");
  assert.ok(byKey("m3") || bySource(M3));

  const catalogRow = SHARED.rows.find((row) => row.meeting_id === meetingIdForSource(M2));
  assert.equal(
    Array.isArray(catalogRow?.agenda_segments) ? catalogRow.agenda_segments.length : 0,
    0,
    "shared meeting catalog keeps agenda segments off the published payload",
  );
  const attached = attachHearingContextAgendaSegments(catalogRow, ARTIFACT);
  assert.equal(attached.agenda_segments?.length, 2);

  const expectations = [
    {
      key: "m1",
      url: M1,
      count: 3,
      titles: [
        /Public Hearing on Retail Cannabis Application/i,
        /Community Budget Recommendations/i,
        /Regular Monthly Meeting of Brooklyn Community Board 14/i,
      ],
      timed: true,
    },
    {
      key: "m2",
      url: M2,
      count: 2,
      titles: [
        /1584 Flatbush/i,
        /Executive Committee Meeting/i,
      ],
      timed: true,
    },
    {
      key: "m3",
      url: M3,
      count: 4,
      titles: [
        /Report on Summer Presentations/i,
        /South of Prospect Neighborhood Plan Kick-Off/i,
        /Neighborhood Plan Strategy Session/i,
        /Other Business/i,
      ],
      timed: false,
    },
  ];

  const loaded = [];
  for (const expectation of expectations) {
    const detail = await loadMeetingDetail(expectation.url);
    assert.equal(detail.response.status, 200, `${expectation.key} detail route loads`);
    assert.equal(isMeetingDocumentHtml(detail.html, detail.meetingId), true);
    assert.equal(detail.segments.length, expectation.count, `${expectation.key} renders agenda segments`);
    for (let index = 0; index < expectation.titles.length; index += 1) {
      assert.match(detail.segments[index].title || "", expectation.titles[index]);
      if (expectation.timed) {
        assert.match(detail.segments[index].start_time || "", /^\d{2}:\d{2}$/);
      } else {
        assert.equal(detail.segments[index].start_time, null);
      }
    }
    loaded.push({
      meeting_key: expectation.key,
      meeting_id: detail.meetingId,
      route: `/meetings/${encodeURIComponent(detail.meetingId)}/`,
      status: detail.response.status,
      rendered_agenda_segments: detail.segments,
    });
  }

  assert.ok(existsSync(DETAIL_EVIDENCE_PATH), "detail-route read-back evidence is retained");
  const committed = JSON.parse(readFileSync(DETAIL_EVIDENCE_PATH, "utf8"));
  assert.equal(committed.schema, "cityscroll.community_board_agenda_detail_route_read_back.v1");
  assert.equal(committed.alias, "c13ef9aaec82b");
  assert.equal(committed.routes.length, 3);
  for (let index = 0; index < loaded.length; index += 1) {
    const expected = loaded[index];
    const recorded = committed.routes[index];
    assert.equal(recorded.meeting_key, expected.meeting_key);
    assert.equal(recorded.meeting_id, expected.meeting_id);
    assert.equal(recorded.status, 200);
    assert.deepEqual(
      recorded.rendered_agenda_segments.map((segment) => segment.title),
      expected.rendered_agenda_segments.map((segment) => segment.title),
    );
  }
});
