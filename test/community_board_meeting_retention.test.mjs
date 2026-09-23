import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchCommunityBoardSource, parseHtmlPdfSource } from "../site/community_board_source_adapters.mjs";
import {
  MEETING_TIMING_PAST,
  RETENTION_BASIS_KNOWN_LINKED_EVENT_URL,
  RETENTION_BASIS_PREVIOUSLY_ADMITTED,
  knownLinkedEventUrlsFromHearingContext,
  meetingTimingStatus,
  publisherIdentityOf,
  unionRetainedMeetingDetailRecords,
  upcomingCollectionRecords,
} from "../site/community_board_retained_meeting_details.mjs";
import { MEETING_COLLECTION_SUPPRESSED } from "../site/meeting_same_proceeding.mjs";
import { buildCommunityBoardMeetingIndex } from "../tools/build_community_board_meeting_index.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import edgeWorker, { isMeetingDocumentHtml } from "../site/pages_edge.mjs";

const FIXTURE_HTML = readFileSync(
  new URL("./fixtures/community_board_meeting_retention/september-2026-board-meeting.html", import.meta.url),
);
const FIXTURE_SHA256 = createHash("sha256").update(FIXTURE_HTML).digest("hex");
const EXPECTED_HTML_SHA256 = "0fcab5cd4a67004d7e76513a1ac321efc9bae6f7fe6f1e6ace3928529cd7fff5";
const SEP14_URL = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const SEP23_URL = "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const BOARD_ID = "brooklyn-cb-14";
const AS_OF = "2026-09-23";
const OBSERVED_AT = "2026-09-23T16:00:00.000Z";
const MEETING_ID = `meeting:community_board:${SEP14_URL}`;

const board = {
  id: BOARD_ID,
  name: "Brooklyn Community Board 14",
  borough: "Brooklyn",
  district: 14,
  upcoming: {
    source_type: "upcoming_meetings",
    publisher: "Brooklyn Community Board 14",
    publisher_kind: "board_owned_official",
    url: "https://cb14brooklyn.com/meetings/",
    format: "board-owned HTML/event calendar",
    status: "verified",
    verification: {
      status: "observed",
      fetchability: "machine_fetchable",
    },
  },
  minutes: {
    source_type: "minutes",
    url: null,
    status: "absent_in_pass",
    verification: { status: "not_observed", fetchability: "unknown" },
  },
};

const hearingContext = {
  boards: [{
    board_id: BOARD_ID,
    hearing: {
      meeting_date: "2026-09-14",
      source_url: SEP14_URL,
    },
  }],
};

function eventJsonLd({ url, name, startDate, location }) {
  return `<script type="application/ld+json">${JSON.stringify({
    "@type": "Event",
    name,
    url,
    startDate,
    ...(location ? { location: { "@type": "Place", name: location.name, address: location.address } } : {}),
  })}</script>`;
}

function parseSep14Detail(observedAt = OBSERVED_AT) {
  return parseHtmlPdfSource(FIXTURE_HTML.toString("utf8"), {
    adapter: "html_pdf_v1",
    role: "event_detail",
    source_role: "event_detail",
    event_detail: true,
    board_id: BOARD_ID,
    body_name: board.name,
    url: SEP14_URL,
    format: "board-owned HTML/event calendar",
  }, {
    observedAt,
    receipt: {
      status: "ok",
      observed_at: observedAt,
      fetch_status: "200",
      content_type: "text/html; charset=UTF-8",
      content_length: FIXTURE_HTML.byteLength,
      content_sha256: FIXTURE_SHA256,
    },
  });
}

test("A4 source fixture retains the official September 14 HTML hash and adapter parse", () => {
  assert.equal(FIXTURE_SHA256, EXPECTED_HTML_SHA256);
  const records = parseSep14Detail();
  assert.equal(records.length, 1);
  const event = records[0];
  assert.equal(event.record_kind, "event");
  assert.equal(event.record_id, SEP14_URL);
  assert.equal(event.date, "2026-09-14");
  assert.equal(event.start_at, "2026-09-14T18:30:00-04:00");
  assert.match(event.address, /1625 Ocean Avenue/i);
  assert.doesNotMatch(String(event.address || ""), /810 East 16th/i);
  assert.match(String(event.description || ""), /461 Coney Island Avenue/i);
  assert.equal(event.observed_receipt.content_sha256, EXPECTED_HTML_SHA256);
});

test("A1 known linked September 14 detail keeps venue, 6:30 start, official source, and past status as of September 23", () => {
  const [event] = parseSep14Detail();
  const linked = knownLinkedEventUrlsFromHearingContext(hearingContext);
  assert.deepEqual(linked, [{
    board_id: BOARD_ID,
    source_url: SEP14_URL,
    meeting_date: "2026-09-14",
    linked_from: "community_board_hearing_context",
  }]);

  const unioned = unionRetainedMeetingDetailRecords({
    currentRecords: [],
    knownLinkedRecords: [{ ...event, source_role: "upcoming_meetings", linked_from: "community_board_hearing_context" }],
    asOfDay: AS_OF,
  });
  assert.equal(unioned.length, 1);
  assert.equal(publisherIdentityOf(unioned[0]), SEP14_URL);
  assert.equal(unioned[0].start_at, "2026-09-14T18:30:00-04:00");
  assert.match(unioned[0].address, /1625 Ocean Avenue/i);
  assert.equal(unioned[0].record_url || unioned[0].source_url, SEP14_URL);
  assert.equal(meetingTimingStatus(unioned[0], AS_OF), MEETING_TIMING_PAST);
  assert.equal(unioned[0].timing_status, MEETING_TIMING_PAST);
  assert.equal(unioned[0].detail_retention.basis, RETENTION_BASIS_KNOWN_LINKED_EVENT_URL);
  assert.equal(unioned[0].detail_retention.cancellation_inferred, false);
  assert.equal(unioned[0].collection_visibility, MEETING_COLLECTION_SUPPRESSED);
});

test("A2 successful calendar with September 23 omits September 14 from upcoming while detail still resolves", async () => {
  const [sep14] = parseSep14Detail("2026-09-14T12:00:00.000Z");
  const previousIndex = {
    generated_at: "2026-09-14T12:00:00.000Z",
    source_records_by_board: {
      [BOARD_ID]: [{
        ...sep14,
        source_role: "upcoming_meetings",
        source_url: board.upcoming.url,
      }],
    },
  };

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === board.upcoming.url || href.startsWith(`${board.upcoming.url}?`)) {
      return new Response(eventJsonLd({
        url: SEP23_URL,
        name: "Housing and Land Use Committee Meeting",
        startDate: "2026-09-23T18:30:00-04:00",
        location: {
          name: "Brooklyn CB14 District Office",
          address: "810 East 16th Street, Brooklyn, NY, 11230",
        },
      }), { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (href === SEP23_URL || href.startsWith(`${SEP23_URL}?`)) {
      return new Response(eventJsonLd({
        url: SEP23_URL,
        name: "Housing and Land Use Committee Meeting",
        startDate: "2026-09-23T18:30:00-04:00",
        location: {
          name: "Brooklyn CB14 District Office",
          address: "810 East 16th Street, Brooklyn, NY, 11230",
        },
      }), { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (href === SEP14_URL || href.startsWith(`${SEP14_URL}?`)) {
      return new Response(FIXTURE_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const index = await buildCommunityBoardMeetingIndex({
    inventory: { boards: [board] },
    registry: { sources: [{ body_type: "community_board", body_id: BOARD_ID, name: board.name }] },
    committeeRegistry: {},
    retainedSnapshots: new Map(),
    previousIndex,
    hearingContext,
    fetchImpl,
    observedAt: OBSERVED_AT,
  });

  const sep14Row = index.rows.find((row) => row.meeting_id === MEETING_ID);
  const sep23Row = index.rows.find((row) => row.meeting_id === `meeting:community_board:${SEP23_URL}`);
  assert.ok(sep14Row, "historical September 14 detail remains materialized");
  assert.ok(sep23Row, "September 23 remains on the successful calendar");
  assert.match(sep14Row.venue?.address || "", /1625 Ocean Avenue/i);
  assert.equal(sep14Row.timing_status, MEETING_TIMING_PAST);
  assert.equal(sep14Row.detail_retention?.cancellation_inferred, false);

  const upcoming = upcomingCollectionRecords(index.rows, { asOfDay: AS_OF });
  assert.ok(upcoming.some((row) => row.meeting_id === `meeting:community_board:${SEP23_URL}`));
  assert.equal(
    upcoming.some((row) => row.meeting_id === MEETING_ID),
    false,
    "expired September 14 is absent from the upcoming collection",
  );

  const model = buildSharedMeetingReadModel({
    communityBoardIndex: index,
    now: OBSERVED_AT,
    generatedAt: OBSERVED_AT,
  });
  const env = { ASSETS: { fetch: async () => new Response(JSON.stringify(model)) } };
  const path = `https://cityscroll.org/meetings/${encodeURIComponent(MEETING_ID)}/`;
  const response = await edgeWorker.fetch(new Request(path), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(isMeetingDocumentHtml(html, MEETING_ID), true);
  assert.match(html, /1625 Ocean Avenue/);
  assert.match(html, /Official source/);
  assert.match(html, /6:30|18:30/);
  assert.doesNotMatch(html, /data-meeting-cancelled="1"/);
});

test("A3 omission is not cancellation; footer 810 East 16th never replaces the 1625 Ocean venue", async () => {
  const [sep14] = parseSep14Detail();
  assert.match(sep14.address, /1625 Ocean Avenue/i);
  assert.doesNotMatch(String(sep14.address || ""), /810 East 16th/i);
  assert.equal(String(FIXTURE_HTML).includes("810 East 16th"), true, "footer address remains in source HTML");

  const omitted = unionRetainedMeetingDetailRecords({
    currentRecords: [{
      schema: "cityscroll.community_board_source_record.v1",
      record_kind: "event",
      record_id: SEP23_URL,
      publisher_identifier: SEP23_URL,
      date: "2026-09-23",
      start_at: "2026-09-23T18:30:00-04:00",
      address: "810 East 16th Street, Brooklyn, NY, 11230",
      source_role: "upcoming_meetings",
      observed_receipt: { status: "ok", observed_at: OBSERVED_AT },
    }],
    previousRecords: [{
      ...sep14,
      source_role: "upcoming_meetings",
    }],
    asOfDay: AS_OF,
  });

  const retained = omitted.find((row) => publisherIdentityOf(row) === SEP14_URL);
  assert.ok(retained);
  assert.equal(retained.detail_retention.basis, RETENTION_BASIS_PREVIOUSLY_ADMITTED);
  assert.equal(retained.detail_retention.cancellation_inferred, false);
  assert.equal(retained.detail_retention.omitted_from_upcoming, true);
  assert.match(retained.address, /1625 Ocean Avenue/i);
  assert.doesNotMatch(String(retained.address || ""), /810 East 16th/i);

  const cancelled = await buildCommunityBoardMeetingIndex({
    inventory: { boards: [board] },
    registry: { sources: [{ body_type: "community_board", body_id: BOARD_ID, name: board.name }] },
    committeeRegistry: {},
    retainedSnapshots: new Map(),
    hearingContext: { boards: [] },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("meetings")) {
        return new Response(eventJsonLd({
          url: "https://cb14brooklyn.com/meeting/cancelled-example/",
          name: "Board meeting cancelled",
          startDate: "2026-10-01T18:30:00-04:00",
        }), { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(eventJsonLd({
        url: "https://cb14brooklyn.com/meeting/cancelled-example/",
        name: "Board meeting cancelled",
        startDate: "2026-10-01T18:30:00-04:00",
      }), { status: 200, headers: { "content-type": "text/html" } });
    },
    observedAt: OBSERVED_AT,
  });
  const cancelledRow = cancelled.rows.find((row) => /cancelled/i.test(row.title || ""));
  assert.ok(cancelledRow, "explicit publisher cancellation remains a distinct admitted record");
  assert.equal(cancelledRow.detail_retention?.cancellation_inferred || false, false);
});

test("A3 errored acquisition admits neither occurrence nor cancellation", async () => {
  const detailDescriptor = {
    adapter: "html_pdf_v1",
    role: "event_detail",
    source_role: "event_detail",
    event_detail: true,
    board_id: BOARD_ID,
    body_name: board.name,
    url: SEP14_URL,
    format: "board-owned HTML/event calendar",
  };

  const errored = await fetchCommunityBoardSource(detailDescriptor, {
    observedAt: OBSERVED_AT,
    fetchImpl: async () => new Response("Gateway Timeout", { status: 504 }),
  });
  assert.equal(errored.records.length, 0, "an errored fetch yields no adapter records");
  assert.notEqual(errored.receipt.status, "ok");
  assert.equal(errored.receipt.reason, "http_error");

  // Replay the real publisher HTML through the adapter while attaching the
  // errored receipt. Structure may still parse, but admission must refuse it.
  const poisoned = parseHtmlPdfSource(FIXTURE_HTML.toString("utf8"), detailDescriptor, {
    observedAt: OBSERVED_AT,
    receipt: {
      status: "unknown",
      reason: "http_error",
      fetch_status: "504",
      observed_at: OBSERVED_AT,
      content_type: "text/html; charset=UTF-8",
      content_length: FIXTURE_HTML.byteLength,
      content_sha256: FIXTURE_SHA256,
    },
  });
  assert.ok(poisoned.length >= 1, "the publisher page still parses under an error receipt");
  assert.notEqual(poisoned[0].observed_receipt.status, "ok");
  assert.equal(poisoned[0].observed_receipt.reason, "http_error");

  const refused = unionRetainedMeetingDetailRecords({
    currentRecords: [],
    knownLinkedRecords: poisoned.map((row) => ({
      ...row,
      source_role: "upcoming_meetings",
      linked_from: "community_board_hearing_context",
    })),
    previousRecords: poisoned.map((row) => ({
      ...row,
      source_role: "upcoming_meetings",
    })),
    asOfDay: AS_OF,
  });
  assert.equal(refused.length, 0, "an errored receipt is not an occurrence assertion");
  assert.equal(
    refused.some((row) => row.detail_retention?.cancellation_inferred === true),
    false,
    "an errored receipt is not a cancellation assertion",
  );

  const index = await buildCommunityBoardMeetingIndex({
    inventory: { boards: [board] },
    registry: { sources: [{ body_type: "community_board", body_id: BOARD_ID, name: board.name }] },
    committeeRegistry: {},
    retainedSnapshots: new Map(),
    // Isolate the errored known-linked fetch from any previously admitted
    // September 14 row that may already exist in the committed index.
    previousIndex: { generated_at: OBSERVED_AT, source_records_by_board: { [BOARD_ID]: [] } },
    hearingContext,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href === board.upcoming.url || href.startsWith(`${board.upcoming.url}?`)) {
        return new Response(eventJsonLd({
          url: SEP23_URL,
          name: "Housing and Land Use Committee Meeting",
          startDate: "2026-09-23T18:30:00-04:00",
          location: {
            name: "Brooklyn CB14 District Office",
            address: "810 East 16th Street, Brooklyn, NY, 11230",
          },
        }), { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
      }
      if (href === SEP23_URL || href.startsWith(`${SEP23_URL}?`)) {
        return new Response(eventJsonLd({
          url: SEP23_URL,
          name: "Housing and Land Use Committee Meeting",
          startDate: "2026-09-23T18:30:00-04:00",
          location: {
            name: "Brooklyn CB14 District Office",
            address: "810 East 16th Street, Brooklyn, NY, 11230",
          },
        }), { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
      }
      if (href === SEP14_URL || href.startsWith(`${SEP14_URL}?`)) {
        return new Response("Gateway Timeout", { status: 504 });
      }
      return new Response("not found", { status: 404 });
    },
    observedAt: OBSERVED_AT,
  });

  assert.equal(
    index.rows.some((row) => row.meeting_id === MEETING_ID),
    false,
    "a failed known-linked detail fetch does not invent the September 14 occurrence",
  );
  assert.ok(
    index.rows.every((row) => row.detail_retention?.cancellation_inferred !== true),
    "a failed acquisition does not mark any retained row cancelled",
  );
  assert.ok(
    index.rows.some((row) => row.meeting_id === `meeting:community_board:${SEP23_URL}`),
    "the successful calendar item remains admitted on its own ok receipt",
  );
});

test("meeting.ics reads the shared projection from ASSETS only", async () => {
  const [sep14] = parseSep14Detail();
  const model = {
    schema: "cityscroll.shared_meeting_read_model.v1",
    rows: [{
      meeting_id: MEETING_ID,
      title: sep14.title || "September 2026 Board Meeting",
      event_date: "2026-09-14",
      start_at: sep14.start_at,
      venue: { address: sep14.address },
      source_system: "community_board",
    }],
  };
  const withAssets = {
    ASSETS: {
      fetch: async () => new Response(JSON.stringify(model), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
  };
  const ok = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/meeting.ics?id=${encodeURIComponent(MEETING_ID)}`),
    withAssets,
  );
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") || "", /text\/calendar/);
  assert.match(await ok.text(), /BEGIN:VCALENDAR/);

  const missing = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/meeting.ics?id=${encodeURIComponent(MEETING_ID)}`),
    { ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } },
  );
  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /meeting projection unavailable/);
});

test("A4 two acquisition passes retain the same publisher identity without inventing cancellation", async () => {
  const passOneHtml = FIXTURE_HTML;
  const passTwoCalendar = eventJsonLd({
    url: SEP23_URL,
    name: "Housing and Land Use Committee Meeting",
    startDate: "2026-09-23T18:30:00-04:00",
    location: { name: "Brooklyn CB14 District Office", address: "810 East 16th Street, Brooklyn, NY, 11230" },
  });

  const fetchPass = (mode) => async (url) => {
    const href = String(url);
    if (mode === "seed" && (href === SEP14_URL || href.includes("september-2026-board-meeting"))) {
      return new Response(passOneHtml, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (mode === "seed" && href.includes("/meetings")) {
      return new Response(eventJsonLd({
        url: SEP14_URL,
        name: "September 2026 Board Meeting",
        startDate: "2026-09-14T18:30:00-04:00",
      }), { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (mode === "refresh" && href.includes("/meetings")) {
      return new Response(passTwoCalendar, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (href === SEP23_URL) {
      return new Response(passTwoCalendar, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    if (href === SEP14_URL) {
      return new Response(passOneHtml, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    return new Response("missing", { status: 404 });
  };

  const first = await buildCommunityBoardMeetingIndex({
    inventory: { boards: [board] },
    registry: { sources: [{ body_type: "community_board", body_id: BOARD_ID, name: board.name }] },
    committeeRegistry: {},
    retainedSnapshots: new Map(),
    hearingContext,
    fetchImpl: fetchPass("seed"),
    observedAt: "2026-09-14T18:00:00.000Z",
  });
  assert.ok(first.rows.some((row) => row.meeting_id === MEETING_ID));

  const second = await buildCommunityBoardMeetingIndex({
    inventory: { boards: [board] },
    registry: { sources: [{ body_type: "community_board", body_id: BOARD_ID, name: board.name }] },
    committeeRegistry: {},
    retainedSnapshots: new Map(),
    previousIndex: first,
    hearingContext,
    fetchImpl: fetchPass("refresh"),
    observedAt: OBSERVED_AT,
  });
  const retained = second.rows.find((row) => row.meeting_id === MEETING_ID);
  assert.ok(retained);
  assert.equal(retained.detail_retention?.cancellation_inferred, false);
  assert.match(retained.venue?.address || retained.address || "", /1625 Ocean Avenue/i);
  assert.equal(
    upcomingCollectionRecords(second.rows, { asOfDay: AS_OF }).some((row) => row.meeting_id === MEETING_ID),
    false,
  );
});
