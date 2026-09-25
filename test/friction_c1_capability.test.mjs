/**
 * Friction capability: segmented meeting detail on the generic meeting document
 * (alias cb0c04802e711).
 *
 * Renders R3's admitted agenda segments with stable anchors, source-supported
 * participation actions, and historical labeling — without loading the full
 * hearings corpus on the detail path.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  isHistoricalMeeting,
  stableAgendaSegmentId,
} from "../site/meeting_agenda_segments.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import edgeWorker, {
  attachHearingContextAgendaSegments,
  isMeetingDocumentHtml,
} from "../site/pages_edge.mjs";
import { buildConsequenceProjection } from "../site/consequence_projection.mjs";
import { participationActionVerbs } from "../site/participation_action_verbs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const ARTIFACT = read("site/data/community_board_hearing_context.json");
const SHARED = read("site/data/shared_meeting_read_model.json");
const CB5 = read("site/data/non_council_outcome_sources/retained_snapshots/manhattan-cb-05.upcoming_meetings.json");
const CAPTURE_MANIFEST = join(ROOT, "docs/evidence/segmented-meeting-detail/capture-manifest.json");

const M1 = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const M2 = "https://cb14brooklyn.com/meeting/public-hearing-on-ulurp-application-and-executive-committee-meeting-september-2026/";
const M3 = "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";

const meetingIdForSource = (url) => `meeting:community_board:${url}`;

function bySource(url) {
  return ARTIFACT.boards.find((row) => row.hearing?.source_url === url);
}

function sharedRow(url) {
  return SHARED.rows.find((row) => row.meeting_id === meetingIdForSource(url));
}

function extractAgendaSection(html) {
  return html.match(/<section[^>]*data-meeting-agenda-segments="(\d+)"[^>]*>([\s\S]*?)<\/section>/);
}

function extractRenderedSegments(html) {
  const section = extractAgendaSection(html);
  if (!section) return [];
  const items = [];
  const rowRe = /<li[^>]*class="meeting-agenda-segment"[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = rowRe.exec(section[2]))) {
    const row = match[0];
    const id = row.match(/\bid="([^"]+)"/)?.[1] || null;
    const href = row.match(/href="#([^"]+)"/)?.[1] || null;
    const title = row.match(/<p class="meeting-agenda-segment-title">([\s\S]*?)<\/p>/)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim() || null;
    const start = row.match(/data-agenda-segment-start="([^"]*)"/)?.[1] || null;
    const kind = row.match(/data-agenda-segment-kind="([^"]*)"/)?.[1] || null;
    const orderRaw = row.match(/data-agenda-segment="([^"]*)"/)?.[1];
    const segmentId = row.match(/data-agenda-segment-id="([^"]*)"/)?.[1] || id;
    items.push({
      order: orderRaw ? Number(orderRaw) : null,
      start_time: start,
      kind,
      title,
      id,
      href,
      segment_id: segmentId,
    });
  }
  return items;
}

async function loadMeetingDetail(url, { currentHref } = {}) {
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
  const path = currentHref
    || `https://cityscroll.org/meetings/${encodeURIComponent(meetingId)}/`;
  const response = await edgeWorker.fetch(new Request(path), env);
  const html = await response.text();
  return {
    meetingId,
    path,
    response,
    html,
    segments: extractRenderedSegments(html),
  };
}

test("A1 M1 exposes cannabis, budget, and regular-meeting segments with distinct stable links, venue, and source-supported participation", async () => {
  const detail = await loadMeetingDetail(M1);
  assert.equal(detail.response.status, 200);
  assert.equal(isMeetingDocumentHtml(detail.html, detail.meetingId), true);
  assert.equal(detail.segments.length, 3);

  assert.match(detail.segments[0].title || "", /Cannabis/i);
  assert.equal(detail.segments[0].start_time, "18:30");
  assert.match(detail.segments[1].title || "", /Budget Recommendations/i);
  assert.equal(detail.segments[1].start_time, "18:45");
  assert.match(detail.segments[2].title || "", /Regular Monthly Meeting/i);
  assert.equal(detail.segments[2].start_time, "19:00");

  const ids = detail.segments.map((segment) => segment.segment_id || segment.id);
  assert.equal(new Set(ids).size, 3, "each segment has a distinct stable id");
  for (const segment of detail.segments) {
    assert.match(segment.id || "", /^agenda-segment-[0-9a-f]+$/i);
    assert.equal(segment.href, segment.id, "segment self-link targets its stable id");
    const recomputed = stableAgendaSegmentId({
      kind: segment.kind,
      start_time: segment.start_time,
      title: segment.title,
    });
    assert.equal(segment.id, recomputed, "anchor is content-stable, not display-index-based");
  }
  // Reordering the source list must not change content-derived anchors.
  const m1 = bySource(M1);
  const reversed = [...m1.hearing.segments].reverse();
  assert.equal(
    stableAgendaSegmentId(reversed[0]),
    stableAgendaSegmentId(m1.hearing.segments[2]),
  );

  assert.match(detail.html, /1625 Ocean Avenue/i);
  assert.match(detail.html, /budget recommendations under consideration/i);
  assert.doesNotMatch(detail.html, /\badopted\b/i);
  assert.match(detail.html, /data-meeting-historical="1"/);
  assert.match(detail.html, /held on/i);

  assert.match(detail.html, /data-participation-mode="attend_in_person"/);
  assert.match(detail.html, /data-participation-mode="register_to_testify"/);
  assert.match(detail.html, /data-participation-mode="submit_written"/);
  assert.match(detail.html, /data-participation-invitation="historical"/);
  assert.doesNotMatch(
    detail.html,
    /data-participation-mode="register_to_testify"[^>]*>\s*<a[^>]*>Register to testify<\/a>/i,
  );
  assert.doesNotMatch(
    detail.html,
    /data-participation-mode="submit_written"[^>]*>\s*<a[^>]*>Submit written testimony<\/a>/i,
  );
});

test("A2 M2 distinguishes hearing and executive session; M3 lists untimed items without assigning the meeting start", async () => {
  const m2 = await loadMeetingDetail(M2);
  assert.equal(m2.response.status, 200);
  assert.equal(m2.segments.length, 2);
  assert.match(m2.segments[0].title || "", /1584 Flatbush|ULURP/i);
  assert.equal(m2.segments[0].start_time, "18:30");
  assert.match(m2.segments[1].title || "", /Executive/i);
  assert.equal(m2.segments[1].start_time, "19:00");
  assert.notEqual(m2.segments[0].id, m2.segments[1].id);

  const m3 = await loadMeetingDetail(M3);
  assert.equal(m3.response.status, 200);
  assert.equal(m3.segments.length, 4);
  assert.ok(m3.segments.every((segment) => segment.start_time == null));
  assert.match(m3.html, /18:30|6:30/i);
  assert.match(m3.segments[0].title || "", /Summer Presentations/i);
  assert.match(m3.segments[3].title || "", /Other Business/i);
});

test("A3 M3 does not acquire written-testimony from M1/M2; ordinary attendance stays distinct from registration", async () => {
  const m1Hearing = bySource(M1).hearing.participation;
  const m3Hearing = bySource(M3).hearing.participation;
  assert.ok(m1Hearing.speaking_registration_url);
  assert.ok(m1Hearing.written_testimony_passage);
  assert.equal(m3Hearing.speaking_registration_url, null);
  assert.equal(m3Hearing.written_testimony_passage, null);

  const m3Detail = await loadMeetingDetail(M3);
  assert.doesNotMatch(m3Detail.html, /data-participation-mode="submit_written"/);
  assert.doesNotMatch(m3Detail.html, /data-participation-mode="register_to_testify"/);
  assert.doesNotMatch(m3Detail.html, /airtable\.com/i);

  const m3Row = attachHearingContextAgendaSegments(sharedRow(M3), ARTIFACT);
  const projection = buildConsequenceProjection("meeting", m3Row, {});
  const modes = new Set(projection.participation_modes || []);
  assert.equal(modes.has("submit_written"), false);
  assert.equal(modes.has("register_to_testify"), false);
  assert.equal(modes.has("attend_in_person"), true);

  const m1Row = attachHearingContextAgendaSegments(sharedRow(M1), ARTIFACT);
  const m1Projection = buildConsequenceProjection("meeting", m1Row, {});
  const m1Modes = new Set(m1Projection.participation_modes || []);
  assert.equal(m1Modes.has("attend_in_person"), true);
  assert.equal(m1Modes.has("register_to_testify"), true);
  assert.equal(m1Modes.has("submit_written"), true);
  const verbs = participationActionVerbs(m1Projection);
  assert.ok(verbs.some((action) => action.mode === "attend_in_person"));
  assert.ok(verbs.some((action) => action.mode === "register_to_testify"));
  assert.ok(verbs.some((action) => action.mode === "submit_written"));
});

test("A4 calendar-only CB5 and BSA pages stay useful; missing agenda yields no empty panel; failed detail offers retry or official source", async () => {
  const events = CB5?.source_records || [];
  assert.ok(events.length >= 1);
  assert.equal(
    ARTIFACT.boards.some((board) => board.board_id === "manhattan-cb-05"),
    false,
  );

  const bareBoard = {
    meeting_id: "meeting:community_board:https://example.test/cb5-calendar-only/",
    source_system: "community_board",
    title: "Calendar-only board meeting",
    event_date: "2026-10-01T18:30:00-04:00",
    source_url: "https://example.test/cb5-calendar-only/",
    venue: { name: "District Office", address: "1 Example Street", mode: "in-person" },
    participation: { links: [{ label: "Meeting information", url: "https://example.test/cb5-calendar-only/" }] },
  };
  const bareHtml = renderMeetingDocument(bareBoard, { rows: [bareBoard] }, {});
  assert.ok(bareHtml);
  assert.equal(extractAgendaSection(bareHtml), null);
  assert.doesNotMatch(bareHtml, /data-meeting-agenda-segments="0"/);
  assert.doesNotMatch(bareHtml, /agenda.?parse|diagnostic/i);

  const bsa = {
    meeting_id: "meeting:bsa_calendar:fixture-day",
    source_system: "bsa_calendar",
    title: "BSA calendar day",
    event_date: "2026-10-06",
    source_url: "https://www.nyc.gov/site/bsa/index.page",
    agenda_items: [
      {
        item_id: "bsa:2026-10-06:1",
        case_id: "2026-10-BZ",
        section: "Calendar",
        status: "pending",
        affected_area: { addresses: ["100 Example Ave"] },
      },
    ],
  };
  const bsaHtml = renderMeetingDocument(bsa, { rows: [bsa] }, {});
  assert.match(bsaHtml, /data-agenda-items="1"/);
  assert.match(bsaHtml, /2026-10-BZ/);
  assert.match(bsaHtml, /Cases on this day/);

  const missingId = "meeting:community_board:https://cb14brooklyn.com/meeting/does-not-exist-on-purpose/";
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
  const missingPath = `https://cityscroll.org/meetings/${encodeURIComponent(missingId)}/`;
  const missing = await edgeWorker.fetch(new Request(missingPath), env);
  const missingHtml = await missing.text();
  assert.equal(missing.status, 404);
  assert.match(missingHtml, /Try again|try again|Retry|retry/i);
  assert.match(missingHtml, /cb14brooklyn\.com\/meeting\/does-not-exist-on-purpose/i);
});

test("A5 capture manifest covers M1–M3 routes across viewports with revision, vintage, assertion, and sha256", () => {
  assert.ok(existsSync(CAPTURE_MANIFEST), "segmented meeting detail capture manifest is retained");
  const manifest = JSON.parse(readFileSync(CAPTURE_MANIFEST, "utf8"));
  assert.equal(manifest.schema, "cityscroll.segmented_meeting_detail_capture_manifest.v1");
  assert.equal(manifest.public_alias, "cb0c04802e711");
  assert.equal(manifest.image_binaries_committed, false);
  assert.ok(Array.isArray(manifest.captures) && manifest.captures.length >= 12);

  const routes = new Set(manifest.captures.map((capture) => capture.route));
  for (const url of [M1, M2, M3]) {
    const route = `/meetings/${encodeURIComponent(meetingIdForSource(url))}/`;
    assert.ok(routes.has(route), `manifest covers ${route}`);
  }

  const viewports = new Set(
    manifest.captures.map((capture) => `${capture.viewport?.width}x${capture.viewport?.height}`),
  );
  assert.ok(viewports.has("1440x900"), "desktop viewport present");
  assert.ok(viewports.has("390x844"), "narrow touch viewport present");

  const scripting = new Set(manifest.captures.map((capture) => capture.javascript || capture.scripting));
  assert.ok(
    [...scripting].some((value) => value === "enabled" || value === true),
    "keyboard/scripted captures present",
  );
  assert.ok(
    [...scripting].some((value) => value === "disabled" || value === false || value === "no-js"),
    "no-JavaScript captures present",
  );

  for (const capture of manifest.captures) {
    assert.ok(capture.route, "capture names route");
    assert.ok(capture.viewport?.width > 0 && capture.viewport?.height > 0, "capture names viewport");
    assert.match(String(capture.revision || ""), /^[0-9a-f]{7,}$/);
    assert.ok(capture.data_vintage, "capture names data vintage");
    assert.ok(String(capture.assertion || "").length > 12, "capture names assertion");
    assert.match(String(capture.sha256 || capture.render_sha256 || ""), /^[0-9a-f]{64}$/);
    if (capture.screenshot) {
      assert.match(capture.screenshot, /^\.artifacts\//);
      assert.doesNotMatch(capture.screenshot, /^docs\//);
    }
  }

  // Journey capture: calendar → detail → Back preserves observe return.
  const journey = manifest.captures.find((capture) => capture.name === "calendar-detail-back-journey");
  assert.ok(journey, "calendar→detail→Back journey capture is retained");
  assert.match(String(journey.assertion || ""), /Back|return|observe/i);
});

test("lean detail path attaches bounded hearing-context slices and never imports the hearings corpus", () => {
  const pagesEdge = readFileSync(join(ROOT, "site/pages_edge.mjs"), "utf8");
  assert.match(pagesEdge, /attachHearingContextAgendaSegments/);
  assert.match(pagesEdge, /community_board_hearing_context\.json/);
  assert.doesNotMatch(pagesEdge, /hearings:location:v1/);
  assert.doesNotMatch(pagesEdge, /parseHearingAgendaSegments/);

  const attached = attachHearingContextAgendaSegments(sharedRow(M1), ARTIFACT);
  assert.equal(attached.agenda_segments?.length, 3);
  assert.ok(attached.hearing_participation?.speaking_registration_url);
  assert.ok(attached.agenda_segments.every((segment) => segment.segment_id));
  assert.equal(
    Array.isArray(sharedRow(M1).agenda_segments) ? sharedRow(M1).agenda_segments.length : 0,
    0,
    "shared catalog stays free of agenda segments",
  );

  assert.equal(isHistoricalMeeting(sharedRow(M1), "2026-09-25"), true);
  assert.equal(isHistoricalMeeting(sharedRow(M1), "2026-09-01"), false);

  // Sanity: sha helper available for capture tooling in this suite's process.
  assert.match(createHash("sha256").update("segmented").digest("hex"), /^[0-9a-f]{64}$/);
});
