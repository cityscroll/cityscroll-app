import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NO_ACTION_DISPOSITION,
  OUTCOME_STATES,
  bodyFollowUp,
  hearingEvidenceFromNotice,
  outcomeCoverageDisclosure,
  projectOutcomeState,
  renderOutcomeState,
} from "../site/outcome_not_located_state.mjs";

const committedLookup = JSON.parse(readFileSync(
  new URL("../site/data/non_council_outcome_lookup.json", import.meta.url),
  "utf8",
));
const meetingsApp = readFileSync(new URL("../site/app/meetings.mjs", import.meta.url), "utf8");

const REQUEST_ID = "20260102003";

const NOTICE = Object.freeze({
  request_id: REQUEST_ID,
  section_name: "Public Hearings and Meetings",
  agency_name: "Queens Community Board 8",
  borough: "Queens",
  body_id: "queens-cb-08",
  short_title: "ULURP 2026Q0012 public hearing",
  start_date: "2025-12-20",
  event_date: "2026-01-08",
});

/** A lookup whose bridge is live and whose one row passes the exact source join. */
function lookup({ outcome, sourceJoin = {}, row = {} } = {}) {
  return {
    schema: "cityscroll.non_council_outcome_lookup.v1",
    generated_at: "2026-08-11T18:30:00.000Z",
    coverage: {
      scope: "fixed_sample_not_citywide",
      honest_absent: true,
      join_bridge_enabled: true,
    },
    notices: {
      [REQUEST_ID]: {
        request_id: REQUEST_ID,
        body_id: "queens-cb-08",
        borough: "Queens",
        meeting_date: "2026-01-08",
        ...(outcome === undefined ? {} : { outcome }),
        source_join: {
          schema: "cityscroll.community_board_source_join.v1",
          status: "official",
          official: true,
          reason: null,
          board_id: "queens-cb-08",
          meeting_date: "2026-01-08",
          source_url: "https://www.nyc.gov/assets/queenscb8/minutes-2026-01-08.pdf",
          join: {
            matched: true,
            method: "exact_board_date_publisher_identifier",
            board_id: "queens-cb-08",
            event_date: "2026-01-08",
            publisher_identifier: "ULURP2026Q0012",
            evidence: ["exact_board_identity", "exact_date", "publisher_identifier"],
          },
          provenance: {
            source_url: "https://www.nyc.gov/site/queenscb8/minutes.page",
            observed_receipt: { status: "ok", observed_at: "2026-01-09T12:00:00Z" },
          },
          ...sourceJoin,
        },
        provenance: {
          document_url: "https://www.nyc.gov/assets/queenscb8/minutes-2026-01-08.pdf",
          text_status: "ok",
        },
        ...row,
      },
    },
  };
}

const APPROVED = { explicit: true, action: "approved", tally: { yes: 34, no: 2, abstain: 1 } };
const NO_ACTION = { explicit: true, action: NO_ACTION_DISPOSITION };

// --- A1 -------------------------------------------------------------------

test("A1 the three outcome states are visibly distinct from one another", () => {
  const decision = renderOutcomeState(lookup({ outcome: APPROVED }), REQUEST_ID, NOTICE);
  const noAction = renderOutcomeState(lookup({ outcome: NO_ACTION }), REQUEST_ID, NOTICE);
  const notLocated = renderOutcomeState(committedLookup, REQUEST_ID, NOTICE);

  const rendered = [decision, noAction, notLocated];
  assert.equal(new Set(rendered).size, 3, "each state renders different markup");
  for (const html of rendered) assert.notEqual(html, "", "no state renders as absence");

  assert.match(decision, /data-non-council-outcome-panel="1"/);
  assert.match(decision, /Community board decision/);

  assert.match(noAction, /data-outcome-state="recorded_no_action"/);
  assert.match(noAction, /Recorded: no action taken/);
  assert.match(noAction, /took no action on this item/);

  assert.match(notLocated, /data-outcome-state="not_located"/);
  assert.match(notLocated, /Outcome not found/);
  assert.match(notLocated, /not evidence that the body took no action/);

  // The distinction is in the copy, not only in a machine attribute: neither
  // absence-state heading may be reused by the other.
  assert.doesNotMatch(notLocated, /no action taken/);
  assert.doesNotMatch(noAction, /Outcome not found/);
});

// --- A2 -------------------------------------------------------------------

test("A2 a match requires the exact source join together with an explicit disposition", () => {
  assert.equal(
    projectOutcomeState(lookup({ outcome: APPROVED }), REQUEST_ID, NOTICE).state,
    OUTCOME_STATES.MATCHED_DECISION,
  );
  assert.equal(
    projectOutcomeState(lookup({ outcome: NO_ACTION }), REQUEST_ID, NOTICE).state,
    OUTCOME_STATES.RECORDED_NO_ACTION,
  );

  const nearMisses = [
    ["disposition present but not marked explicit", lookup({ outcome: { action: "approved" } })],
    ["explicit flag with no action recorded", lookup({ outcome: { explicit: true, action: "" } })],
    ["source join not official", lookup({
      outcome: APPROVED,
      sourceJoin: { status: "unknown", official: false, reason: "ambiguous_source_records" },
    })],
    ["source join date disagrees with the meeting date", lookup({
      outcome: APPROVED,
      sourceJoin: { meeting_date: "2026-01-09" },
    })],
    ["source join is for a different board", lookup({
      outcome: APPROVED,
      sourceJoin: { board_id: "queens-cb-09" },
    })],
    ["source receipt never observed", lookup({
      outcome: APPROVED,
      sourceJoin: { provenance: { source_url: "https://www.nyc.gov/site/queenscb8/minutes.page" } },
    })],
    ["document text unreadable", lookup({ outcome: APPROVED, row: { provenance: { text_status: "empty" } } })],
    ["bridge disabled", { ...lookup({ outcome: APPROVED }), coverage: { scope: "x", honest_absent: true, join_bridge_enabled: false } }],
  ];
  for (const [why, payload] of nearMisses) {
    assert.equal(
      projectOutcomeState(payload, REQUEST_ID, NOTICE).state,
      OUTCOME_STATES.NOT_LOCATED,
      why,
    );
  }
});

// --- A3 -------------------------------------------------------------------

test("A3 a minutes link without a disposition is readable but mints no decision", () => {
  const payload = lookup({ outcome: undefined });
  const view = projectOutcomeState(payload, REQUEST_ID, NOTICE);
  assert.equal(view.state, OUTCOME_STATES.NOT_LOCATED);
  assert.equal(view.decision, null);
  assert.equal(
    view.readable_minutes.url,
    "https://www.nyc.gov/assets/queenscb8/minutes-2026-01-08.pdf",
  );

  const html = renderOutcomeState(payload, REQUEST_ID, NOTICE);
  assert.match(html, /Read the published minutes/);
  assert.match(html, /data-mints-decision="0"/);
  assert.match(html, /they record no decision on this item/);
  for (const word of [/Approved/, /Rejected/, /\bHeld\b/, /Published vote/]) {
    assert.doesNotMatch(html, word, `minutes must not mint ${word}`);
  }
});

// --- A4 -------------------------------------------------------------------

test("A4 an unmatched record lands on the follow-up path for its own body", () => {
  const board = renderOutcomeState(committedLookup, REQUEST_ID, NOTICE);
  assert.match(board, /data-follow-kind="community_board"/);
  assert.match(board, /href="\/community-boards\/queens-cb-08\/"/);
  assert.match(board, /Follow this community board/);

  const boroughNotice = {
    ...NOTICE,
    agency_name: "Office of the Brooklyn Borough President",
    borough: "Brooklyn",
    body_id: null,
  };
  const borough = renderOutcomeState(committedLookup, REQUEST_ID, boroughNotice);
  assert.match(borough, /data-follow-kind="borough"/);
  assert.match(borough, /href="https:\/\/www\.brooklynbp\.nyc\.gov\/"/);
  assert.match(borough, /Follow the Brooklyn Borough President/);

  // A board we could not identify is never routed to a different body.
  assert.equal(bodyFollowUp({ agency_name: "Community Board", borough: "" }), null);
  const unknown = renderOutcomeState(committedLookup, REQUEST_ID, { ...NOTICE, agency_name: "Community Board", borough: "", body_id: null });
  assert.match(unknown, /data-outcome-state="not_located"/);
  assert.doesNotMatch(unknown, /data-follow-kind=/);
});

// --- A5 -------------------------------------------------------------------

test("A5 a record with a missing date never advances to held on publication age", () => {
  const undated = { ...NOTICE, event_date: null, start_date: "2019-03-04" };
  const evidence = hearingEvidenceFromNotice(undated);
  assert.equal(evidence.hearing_date, null);
  assert.equal(evidence.published_on, "2019-03-04");
  assert.equal(evidence.derived_disposition, null, "no disposition is ever derived");

  const view = projectOutcomeState(committedLookup, REQUEST_ID, undated);
  assert.equal(view.state, OUTCOME_STATES.NOT_LOCATED);

  const html = renderOutcomeState(committedLookup, REQUEST_ID, undated);
  assert.doesNotMatch(html, /\bHeld\b/i);

  // Publication age changes nothing: an ancient notice and a fresh one with the
  // same missing date render identically.
  const fresh = renderOutcomeState(committedLookup, REQUEST_ID, { ...undated, start_date: "2026-09-01" });
  assert.equal(html, fresh, "publication age is not an input to the state");
});

// --- A6 -------------------------------------------------------------------

test("A6 the method disclosure names the source and the last-checked date", () => {
  const disclosure = outcomeCoverageDisclosure(committedLookup);
  assert.equal(disclosure.last_checked, "2026-08-11");
  assert.match(disclosure.source, /community board and borough president records/);

  const html = renderOutcomeState(committedLookup, REQUEST_ID, NOTICE);
  assert.match(html, /How this was checked/);
  assert.match(html, /community board and borough president records/);
  assert.match(html, /Last checked Aug 11, 2026/);

  // A lookup with no recorded check date says so rather than inventing one.
  const undatedLookup = { ...committedLookup, generated_at: null };
  assert.equal(outcomeCoverageDisclosure(undatedLookup).last_checked, null);
  assert.match(renderOutcomeState(undatedLookup, REQUEST_ID, NOTICE), /Last checked not recorded/);
});

// --- A7 and the negative rule ---------------------------------------------

test("A7 the unmatched state offers following the body and never a decision it lacks", () => {
  const html = renderOutcomeState(committedLookup, REQUEST_ID, NOTICE);
  assert.match(html, /Follow this community board/);
  assert.match(html, /It has no feed of this body's decisions/);

  for (const banned of [
    /get the decision/i,
    /see the decision/i,
    /view the outcome/i,
    /decision feed/i,
    /outcome feed/i,
    /check back/i,
    /coming soon/i,
    /not yet available/i,
  ]) {
    assert.doesNotMatch(html, banned, `unmatched state must not say ${banned}`);
  }
});

test("negative rule: an unmatched outcome is never rendered as a negative result", () => {
  for (const notice of [NOTICE, { ...NOTICE, event_date: null, start_date: "2018-01-01" }]) {
    const html = renderOutcomeState(committedLookup, REQUEST_ID, notice);
    assert.notEqual(html, "", "absence is never rendered as absence");
    for (const banned of [
      /no action was taken/i,
      /nothing happened/i,
      /\bno decision was made\b/i,
      /Recorded: no action taken/,
      /\bApproved\b/,
      /\bRejected\b/,
    ]) {
      assert.doesNotMatch(html, banned, `not-located must not assert ${banned}`);
    }
    // "took no action" may appear only inside the sentence that DENIES it. An
    // affirmative use would be exactly the misreading this card exists to stop.
    assert.equal(
      (html.match(/took no action/gi) || []).length,
      (html.match(/not evidence that the body took no action/gi) || []).length,
      "every mention of taking no action is a denial, never a claim",
    );
  }
});

// --- coverage and wiring ---------------------------------------------------

test("the committed lookup matches nothing, so every real notice reads as not located", () => {
  assert.equal(committedLookup.coverage.join_bridge_enabled, false);
  assert.equal(Object.keys(committedLookup.notices || {}).length, 0);
  assert.equal(
    projectOutcomeState(committedLookup, REQUEST_ID, NOTICE).state,
    OUTCOME_STATES.NOT_LOCATED,
  );
  // A missing lookup entirely (fetch failure) is still an honest gap, not a negative.
  const offline = projectOutcomeState(null, REQUEST_ID, NOTICE);
  assert.equal(offline.state, OUTCOME_STATES.NOT_LOCATED);
  assert.equal(offline.disclosure.last_checked, null);
  assert.match(renderOutcomeState(null, REQUEST_ID, NOTICE), /Outcome not found/);
});

test("the meeting detail mount point renders the outcome state, not a bare panel", () => {
  assert.match(meetingsApp, /outcome_not_located_state\.mjs/);
  assert.match(meetingsApp, /loadOutcomeState\(r\.request_id, r,/);
});

test("localized states keep their distinct wording", () => {
  const es = renderOutcomeState(committedLookup, REQUEST_ID, NOTICE, { lang: "es" });
  assert.match(es, /No se encontró el resultado/);
  assert.match(es, /Seguir a esta junta comunitaria/);
  const noActionEs = renderOutcomeState(lookup({ outcome: NO_ACTION }), REQUEST_ID, NOTICE, { lang: "es" });
  assert.match(noActionEs, /Registrado: no se tomó ninguna medida/);
  assert.notEqual(es, noActionEs);
});
