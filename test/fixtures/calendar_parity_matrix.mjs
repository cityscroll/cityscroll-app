/**
 * Cross-surface calendar parity fixture matrix (CBICS-10).
 *
 * Every mounted calendar (rules, Community Boards, Now, land, procurement,
 * property, exams, legislative matters) is an alternate presentation of an
 * existing list/object population, gated by the shared CBICS-01 bounded
 * display-occurrence boundary (`calendar_display.mjs`) and the shared
 * CBICS-02 compact month component (`compact_calendar.mjs`). This module
 * supplies one committed raw-record fixture per surface for each case named
 * in the CBICS-10 card's required-fixtures list, built with the same input
 * shapes each surface's own production adapter already consumes. It invents
 * no calendar behavior of its own — `test/calendar_parity_matrix.test.mjs`
 * drives every fixture through the real domain adapter.
 */

export const PARITY_TODAY = "2026-06-01";

/* ================= rules (CBICS-03) ================= */

const RULE_REQUEST_ID = "20260601001";
const RULE_SOURCE_URL = "https://rules.cityofnewyork.us/?p=9001";

function ruleEvent(type, date, status = "occurred") {
  return {
    event_type: type,
    valid_at: date,
    source_url: RULE_SOURCE_URL,
    request_id: RULE_REQUEST_ID,
    status,
  };
}

export const RULES_FIXTURES = {
  // Proposal -> hearing -> comment-close inside one rolling 42-day window.
  denseParticipationCluster: {
    requestId: RULE_REQUEST_ID,
    events: [
      ruleEvent("proposal_published", "2026-06-04"),
      ruleEvent("public_hearing", "2026-06-18", "scheduled"),
      ruleEvent("comment_close", "2026-07-02", "scheduled"),
    ],
    today: PARITY_TODAY,
  },
  // One known date only: never meets the density rule.
  sparseRule: {
    requestId: "20260601002",
    events: [ruleEvent("proposal_published", "2026-06-10")],
    today: PARITY_TODAY,
  },
  // All five history-timeline stages observed and dated.
  completeRuleHistory: {
    requestId: "20260601003",
    events: [
      ruleEvent("proposal_published", "2026-01-05"),
      ruleEvent("public_hearing", "2026-01-20", "scheduled"),
      ruleEvent("comment_close", "2026-02-03", "scheduled"),
      ruleEvent("adoption", "2026-02-20", "scheduled"),
      ruleEvent("effective", "2026-03-06", "scheduled"),
    ],
    today: PARITY_TODAY,
  },
  // Only the early stages are observed; adoption/effective are still
  // pending and must never receive an invented date.
  partialRuleHistory: {
    requestId: "20260601004",
    events: [
      ruleEvent("proposal_published", "2026-06-01"),
      ruleEvent("public_hearing", "2026-06-15", "scheduled"),
    ],
    today: PARITY_TODAY,
  },
};

/* ================= Community Boards (CBICS-04) ================= */

const CB_BODY_ID = "brooklyn-cb-99";

function cbAcceptedEdge({ id, date, host = "board", form = null }) {
  const to = `meeting:community_board:${id}`;
  const from = host === "committee" ? `community-board-committee:${CB_BODY_ID}:land-use` : `community-board:${CB_BODY_ID}`;
  return {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from,
    to,
    target_kind: "meeting",
    target_id: to,
    target_name: host === "committee" ? "Land Use Committee Meeting" : "Full Board Meeting",
    href: `/meetings/${encodeURIComponent(to)}`,
    canonical_href: `/meetings/${encodeURIComponent(to)}`,
    ...(form ? { proceeding_form: form } : {}),
    join: { matched: true, event_date: date },
    source_url: "https://www.nyc.gov/site/cbparity/calendar.page",
  };
}

function cbHeldEdge({ id, date }) {
  const to = `meeting:community_board:${id}`;
  return {
    relation: "hosts_meeting",
    edge_type: "hosts_meeting",
    status: "held",
    promoted: false,
    reason: "evidence_held",
    from: `community-board:${CB_BODY_ID}`,
    to,
    target_kind: "meeting",
    target_id: to,
    target_name: "Unconfirmed board meeting",
    href: null,
    canonical_href: null,
    join: { matched: false, event_date: date },
  };
}

function cbSources(institutionEdges) {
  return {
    sourceRegistry: { sources: [] },
    sourceInventory: { boards: [] },
    scorecard: { rows: [], as_of: PARITY_TODAY },
    geography: {
      nodes: [{
        type: "community-board",
        id: `community-board:${CB_BODY_ID}`,
        name: "Fixture Community Board",
        properties: { body_id: CB_BODY_ID, borough: "Brooklyn", community_district_id: "K99" },
      }],
    },
    today: PARITY_TODAY,
    ...(institutionEdges === undefined ? {} : { institutionEdges: { [CB_BODY_ID]: institutionEdges } }),
  };
}

export const COMMUNITY_BOARD_FIXTURES = {
  bodyId: CB_BODY_ID,
  // Three accepted proceedings in-window, plus one held (unaccepted)
  // edge that must never reach the calendar.
  denseMonth: {
    bodyId: CB_BODY_ID,
    sources: cbSources([
      cbAcceptedEdge({ id: "cbp-full-1", date: "2026-06-04", host: "board" }),
      cbAcceptedEdge({ id: "cbp-lu-1", date: "2026-06-11", host: "committee", form: "meeting" }),
      cbAcceptedEdge({ id: "cbp-hearing-1", date: "2026-06-18", host: "board", form: "public_hearing" }),
      cbHeldEdge({ id: "cbp-held-1", date: "2026-06-09" }),
    ]),
    acceptedIds: ["meeting:community_board:cbp-full-1", "meeting:community_board:cbp-lu-1", "meeting:community_board:cbp-hearing-1"],
  },
  // Institution edges never resolved for this board at all: coverage
  // unavailable, distinct from a board with zero scheduled meetings.
  unavailableSource: {
    bodyId: CB_BODY_ID,
    sources: cbSources(undefined),
  },
};

/* ================= Now (CBICS-05) ================= */

function nowItem({ id, day, route, title = "Fixture item", domain = "money", cancelled = false, basis = "publisher_record" }) {
  return {
    id,
    title,
    route,
    domain,
    cancelled,
    time: { day, value: day, precision: "date", basis, verified: true },
  };
}

export const NOW_FIXTURES = {
  // A scoped Now surface with a dated act-by deadline, an undated open
  // opportunity (must never receive an invented cell), and a happening-soon
  // event.
  scopedDatedAndUndated: {
    today: PARITY_TODAY,
    surface: {
      act_by: {
        dated: [nowItem({ id: "money:bid-open:2026-06-08", day: "2026-06-08", route: "/notices/bid-open", title: "Bridge inspection services due" })],
        open_without_date: [{ id: "money:rolling-open", title: "Continuously open solicitation", route: "/notices/rolling-open" }],
      },
      happening_soon: {
        items: [nowItem({ id: "meeting:cb-parity-1", day: "2026-06-15", route: "/meetings/cb-parity-1", title: "Full board meeting", domain: "meetings" })],
      },
    },
    datedUids: ["money:bid-open", "meeting:cb-parity-1"],
  },
  // Five happening-soon items on the same calendar day, plus one item on a
  // second date so the bundle still meets the two-distinct-dates density
  // rule: proves the crowded day path keeps every occurrence in the
  // document behind disclosure rather than dropping or truncating any of
  // them.
  crowdedDay: {
    today: PARITY_TODAY,
    surface: {
      act_by: { dated: [], open_without_date: [] },
      happening_soon: {
        items: [
          ...Array.from({ length: 5 }, (_, index) => nowItem({
            id: `meeting:crowded-${index}:2026-06-22`,
            day: "2026-06-22",
            route: `/meetings/crowded-${index}`,
            title: `Crowded-day meeting ${index + 1}`,
            domain: "meetings",
          })),
          nowItem({ id: "meeting:crowded-spread:2026-06-29", day: "2026-06-29", route: "/meetings/crowded-spread", title: "Later meeting", domain: "meetings" }),
        ],
      },
    },
  },
  // Two source rows for the same stable identity: the later date wins and
  // the survivor is flagged rescheduled -- never a stale duplicate cell.
  rescheduledOccurrence: {
    today: PARITY_TODAY,
    surface: {
      act_by: {
        dated: [
          nowItem({ id: "rules:hearing-9:2026-06-05", day: "2026-06-05", route: "/notices/hearing-9", title: "Public hearing (original)", domain: "rules" }),
          nowItem({ id: "rules:hearing-9:2026-06-19", day: "2026-06-19", route: "/notices/hearing-9", title: "Public hearing (rescheduled)", domain: "rules" }),
        ],
        open_without_date: [],
      },
      happening_soon: { items: [] },
    },
  },
  // A record whose retained entry is itself the cancellation: the survivor
  // reads as cancelled, not as a second scheduled cell. Both rows share the
  // same stable identity once the trailing `:YYYY-MM-DD` disambiguator is
  // stripped, exactly as a real property auction's two source rows would.
  cancelledOccurrence: {
    today: PARITY_TODAY,
    surface: {
      act_by: {
        dated: [
          nowItem({ id: "property:auction-3:2026-06-07", day: "2026-06-07", route: "/notices/auction-3", title: "Public auction (original)", domain: "property" }),
          nowItem({ id: "property:auction-3:2026-06-08", day: "2026-06-08", route: "/notices/auction-3", title: "Public auction (cancelled)", domain: "property", cancelled: true }),
        ],
        open_without_date: [],
      },
      happening_soon: { items: [] },
    },
  },
};

/* ================= Land project connected dates (CBICS-06) ================= */

const LAND_PROJECT_REF = "project:2026M0099";

function landAcceptedConnection({ id, date, title }) {
  return {
    status: "matched",
    items: [{
      state: "matched",
      confidence: "strong",
      relation: "project_hearing_decision",
      calendar_record: {
        object_ref: `notice:${id}`,
        title,
        event_date: date,
        canonical_url: `https://cityscroll.org/notices/${id}`,
        source: { system: "city_record", record_id: id, url: `https://records.example/${id}` },
      },
    }],
  };
}

function landRejectedConnection({ id, date, title }) {
  return {
    status: "matched",
    items: [{
      state: "held",
      relation: "project_proceeding_held",
      calendar_record: {
        object_ref: `notice:${id}`,
        title,
        event_date: date,
        canonical_url: `https://cityscroll.org/notices/${id}`,
        source: { system: "city_record", record_id: id, url: `https://records.example/${id}` },
      },
    }],
  };
}

// An accepted connection whose only date is a publication timestamp, never
// a semantic event date: must contribute zero occurrences even though the
// relation itself is accepted (A2).
function landPublicationOnlyConnection({ id }) {
  return {
    status: "matched",
    items: [{
      state: "matched",
      confidence: "strong",
      relation: "project_filing_notice",
      calendar_record: {
        object_ref: `notice:${id}`,
        title: "Filing notice (publication only)",
        start_date: "2026-05-15",
        canonical_url: `https://cityscroll.org/notices/${id}`,
        source: { system: "city_record", record_id: id, url: `https://records.example/${id}` },
      },
    }],
  };
}

export const LAND_FIXTURES = {
  projectRef: LAND_PROJECT_REF,
  // Accepted and rejected relations side by side, plus a month-boundary
  // cluster (late May into early June) and a publication-only accepted
  // relation that must still contribute zero occurrences.
  acceptedAndRejectedRelations: {
    today: PARITY_TODAY,
    record: {
      project_id: "2026M0099",
      project_connections: {
        status: "bounded",
        project_ref: LAND_PROJECT_REF,
        groups: [
          landAcceptedConnection({ id: "2026m0099-hearing-1", date: "2026-05-28T19:00:00-04:00", title: "Commission public hearing" }),
          landAcceptedConnection({ id: "2026m0099-vote-1", date: "2026-06-04T13:00:00-04:00", title: "Commission vote" }),
          landAcceptedConnection({ id: "2026m0099-approval-1", date: "2026-06-11T13:00:00-04:00", title: "Council approval hearing" }),
          landRejectedConnection({ id: "2026m0099-dropped-1", date: "2026-06-02T19:00:00-04:00", title: "Dropped hearing" }),
          landPublicationOnlyConnection({ id: "2026m0099-filing-1" }),
        ],
      },
    },
    acceptedIds: ["notice:2026m0099-hearing-1", "notice:2026m0099-vote-1", "notice:2026m0099-approval-1"],
  },
};

/* ================= Procurement + property opportunities (CBICS-07) ================= */

const PROCUREMENT_ID = "procurement:epin-parity-01";
const PROCUREMENT_REF = "city_record:20260601099";

export const PROCUREMENT_FIXTURES = {
  procurementId: PROCUREMENT_ID,
  // Pre-bid conference, questions deadline, and proposal deadline, spanning
  // a month boundary (late June into early July), plus a second bid with a
  // low-confidence-flagged deadline that must be excluded.
  conferenceQuestionsDeadlineBundle: {
    today: PARITY_TODAY,
    object: { procurement_id: PROCUREMENT_ID, source_observation_refs: [PROCUREMENT_REF, "city_record:20260601199"] },
    observations: [
      {
        source_observation_ref: PROCUREMENT_REF,
        source_system: "city_record",
        source_system_id: "20260601099",
        ingested_at: "2026-06-01T10:00:00Z",
        snapshot: {
          request_id: "20260601099",
          short_title: "Fixture playground reconstruction solicitation",
          type_of_notice_description: "Solicitation Notice",
          additional_description_1: "Pre-bid conference: 06/24/2026 at 10:00 a.m. Questions deadline: 07/01/2026.",
          due_date: "07/08/2026",
          official_url: "https://records.example/procurement/parity-01",
        },
      },
      {
        source_observation_ref: "city_record:20260601199",
        source_system: "city_record",
        source_system_id: "20260601199",
        ingested_at: "2026-06-01T10:00:00Z",
        snapshot: {
          request_id: "20260601199",
          short_title: "Fixture low-confidence deadline",
          due_date: "07/10/2026",
          low_confidence: true,
        },
      },
    ],
    includedTitleMatches: [/Pre-bid conference/, /Questions due/, /Bids due/],
    excludedRequestId: "20260601199",
  },
};

export const PROPERTY_FIXTURES = {
  requestId: "20260601098",
  // Two showings plus a bid deadline, with a fourth same-day showing to
  // exercise the crowded-day disclosure on the same fixture.
  showingsAndDeadlineBundle: {
    today: PARITY_TODAY,
    row: {
      request_id: "20260601098",
      short_title: "Sale of fixture city-owned property",
      additional_description_1: "A public hearing will be held on June 17, 2026 at 11:00 a.m. concerning the sale of "
        + "city-owned real property. Show Dates: June 18, 2026 at 10:00 a.m. and June 20, 2026 at 10:00 a.m. "
        + "Sealed bids will be received no later than June 26, 2026 at 2:00 p.m.",
    },
  },
};

/* ================= Exams (CBICS-08) — reuses the committed exam corpus ================= */

export { EXAM_CALENDAR_FIXTURES, FIXTURE_TODAY as EXAM_FIXTURE_TODAY, fixtureExam } from "./exam_calendar_fixtures.mjs";

// Two additional exam states exercised for CBICS-10's cross-cutting cases
// (rescheduled/cancelled) on top of the committed two-date/three-date corpus.
export function fixtureExamPostponed() {
  return {
    exam_number: "9101",
    title: "Fixture Postponed Exam",
    title_code: "91010",
    eligibility: "open_competitive",
    schedule_status: "postponed",
    application_start: "2026-03-02",
    application_end: "2026-03-23",
    exam_date: "2026-04-08",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/exams/example-noe.pdf",
    official_application_url: "https://www.nyc.gov/examsforjobs",
  };
}

export function fixtureExamCancelled() {
  return {
    exam_number: "9102",
    title: "Fixture Cancelled Exam",
    title_code: "91020",
    eligibility: "open_competitive",
    schedule_status: "canceled",
    application_start: "2026-03-02",
    application_end: "2026-03-23",
    exam_date: "2026-04-06",
    notice_url: "https://www.nyc.gov/assets/dcas/downloads/exams/example-noe.pdf",
    official_application_url: "https://www.nyc.gov/examsforjobs",
  };
}

/* ================= Legislative matter appearances (CBICS-09) ================= */

const MATTER_ID = "90142";

function matterAppearance({ requestId, eventId, date, name = "Subcommittee on Zoning and Franchises", lifecycle, status }) {
  return {
    request_id: requestId,
    event: { event_id: eventId, name, date, url: `https://nyc.legistar.com/MeetingDetail.aspx?LEGID=${eventId}` },
    actions: [],
    outcome: null,
    votes: null,
    ...(lifecycle ? { lifecycle } : {}),
    ...(status ? { status } : {}),
  };
}

function matterLookupPayload(appearances) {
  return {
    schema: "cityscroll.legislative_matter_lookup.v1",
    generated_at: "2026-06-01T00:00:00.000Z",
    matters: {
      [MATTER_ID]: {
        matter_id: MATTER_ID,
        matter_file: "LU 0099-2026",
        title: "Fixture rezoning application",
        matter_type: "Land Use Application",
        matter_status: "In Committee",
        matter_href: `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${MATTER_ID}`,
        appearances,
      },
    },
  };
}

export const LEGISLATIVE_FIXTURES = {
  matterId: MATTER_ID,
  today: "2026-07-01",
  buildPayload: matterLookupPayload,
  // Three-plus appearances inside the eligibility window.
  concentratedMatter: [
    matterAppearance({ requestId: "req-p1", eventId: "ep1", date: "2026-06-04" }),
    matterAppearance({ requestId: "req-p2", eventId: "ep2", date: "2026-06-11" }),
    matterAppearance({ requestId: "req-p3", eventId: "ep3", date: "2026-06-25" }),
  ],
  // Appearances spread far apart: stays list-only.
  dispersedMatter: [
    matterAppearance({ requestId: "req-d1", eventId: "ed1", date: "2026-01-05" }),
    matterAppearance({ requestId: "req-d2", eventId: "ed2", date: "2026-05-05" }),
    matterAppearance({ requestId: "req-d3", eventId: "ed3", date: "2026-09-05" }),
  ],
};

// `buildLegislativeMatterDocument`'s normalizer does not yet carry a source
// reschedule/cancellation signal through `view.appearances` (see
// `site/legislative_matter_calendar.mjs`'s own note on this). The forward
// -compatible lifecycle pass-through is proven directly against the
// CBICS-01 view shape `matterAppearanceCalendarRecords` actually consumes,
// one layer below the document builder.
export function legislativeMatterViewWithCancelledAppearance() {
  return {
    schema: "cityscroll.legislative_matter_document.v1",
    id: MATTER_ID,
    generated_at: "2026-06-01T00:00:00.000Z",
    appearances: [
      { request_id: "req-c1", event: { event_id: "ec1", date: "2026-06-04", name: "Committee meeting", href: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=ec1" } },
      { request_id: "req-c2", event: { event_id: "ec2", date: "2026-06-11", name: "Committee meeting", href: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=ec2" } },
      { request_id: "req-c3", event: { event_id: "ec3", date: "2026-06-25", name: "Committee meeting", href: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=ec3" }, status: "cancelled", lifecycle: "cancelled" },
    ],
  };
}
