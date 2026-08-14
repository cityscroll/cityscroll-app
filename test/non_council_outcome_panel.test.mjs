import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildNonCouncilOutcomePanelView,
  buildOfficialBoardMeetingJoin,
  nonCouncilOutcomePanelHTML,
} from "../site/non_council_outcome_panel.mjs";

const committedLookup = JSON.parse(readFileSync(
  new URL("../site/data/non_council_outcome_lookup.json", import.meta.url),
  "utf8",
));
const meetingsApp = readFileSync(new URL("../site/app/meetings.mjs", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../site/non_council_outcome_panel.mjs", import.meta.url), "utf8");

const receiptPassedLookup = {
  schema: "cityscroll.non_council_outcome_lookup.v1",
  coverage: {
    honest_absent: true,
    join_bridge_enabled: true,
  },
  notices: {
    "20260102003": {
      request_id: "20260102003",
      body_id: "queens-cb-08",
      borough: "Queens",
      meeting_date: "2026-01-08",
      title: "January 2026 Board Meeting Minutes",
      outcome: {
        explicit: true,
        action: "approved",
        tally: { yes: 34, no: 2, abstain: 1 },
      },
      join: {
        method: "exact_body_date_matter_tokens",
        body_id: "queens-cb-08",
        event_date: "2026-01-08",
        matter_token: "ULURP2026Q0012",
      },
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
      },
      provenance: {
        document_url: "https://www.nyc.gov/assets/queenscb8/minutes-2026-01-08.pdf",
        text_status: "ok",
      },
    },
  },
};

test("committed killed bridge is verifiably inert", () => {
  assert.equal(committedLookup.coverage.join_bridge_enabled, false);
  assert.equal(nonCouncilOutcomePanelHTML(committedLookup, "20260102003"), "");
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    notices: {},
  }, "20260102003"), "");
});

test("receipt-passed exact join surfaces decision, published vote, and official minutes", () => {
  const view = buildNonCouncilOutcomePanelView(receiptPassedLookup, "20260102003");
  assert.equal(view.show, true);
  assert.equal(view.body_name, "Queens Community Board 8");
  assert.equal(view.meeting_label, "Official CB8 meeting");
  assert.equal(view.action, "approved");
  assert.deepEqual(view.tally, { yes: 34, no: 2, abstain: 1 });
  const canonicalJoinView = buildNonCouncilOutcomePanelView({
    ...receiptPassedLookup,
    notices: {
      "20260102003": {
        ...receiptPassedLookup.notices["20260102003"],
        outcome_join: receiptPassedLookup.notices["20260102003"].join,
        join: receiptPassedLookup.notices["20260102003"].source_join,
        source_join: undefined,
      },
    },
  }, "20260102003");
  assert.equal(canonicalJoinView.meeting_label, "Official CB8 meeting");

  const html = nonCouncilOutcomePanelHTML(receiptPassedLookup, "20260102003");
  assert.match(html, /data-non-council-outcome-panel="1"/);
  assert.match(html, /Queens Community Board 8/);
  assert.match(html, /Approved/);
  assert.match(html, /34 yes · 2 no · 1 abstain/);
  assert.match(html, /Official minutes/);
  assert.match(html, /minutes-2026-01-08\.pdf/);
  assert.match(html, /Meeting source/);
  assert.match(html, /Official CB8 meeting/);
  assert.match(html, /Where this meeting source comes from/);
  assert.doesNotMatch(html, /unknown|missing|unmatched|not published|below threshold/i);
  assert.match(nonCouncilOutcomePanelHTML(receiptPassedLookup, "20260102003", { lang: "es" }), /Decisión de la junta comunitaria/);
});

test("panel rejects non-receipted, inexact, or incomplete rows", () => {
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    coverage: { ...receiptPassedLookup.coverage, join_bridge_enabled: false },
  }, "20260102003"), "");
  assert.equal(buildOfficialBoardMeetingJoin({
    ...receiptPassedLookup.notices["20260102003"],
    source_join: {
      ...receiptPassedLookup.notices["20260102003"].source_join,
      join: {
        ...receiptPassedLookup.notices["20260102003"].source_join.join,
        publisher_identifier: null,
        evidence: ["exact_board_identity", "exact_date"],
      },
    },
  }), null);
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    notices: {
      "20260102003": {
        ...receiptPassedLookup.notices["20260102003"],
        join: { method: "date_only" },
      },
    },
  }, "20260102003"), "");
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    notices: {
      "20260102003": {
        ...receiptPassedLookup.notices["20260102003"],
        source_join: {
          ...receiptPassedLookup.notices["20260102003"].source_join,
          source_url: "http://example.com/minutes.pdf",
        },
      },
    },
  }, "20260102003"), "");
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    notices: {
      "20260102003": {
        ...receiptPassedLookup.notices["20260102003"],
        source_join: undefined,
      },
    },
  }, "20260102003"), "");
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    notices: {
      "20260102003": {
        ...receiptPassedLookup.notices["20260102003"],
        source_join: {
          ...receiptPassedLookup.notices["20260102003"].source_join,
          status: "unknown",
          official: false,
          reason: "ambiguous_source_records",
        },
      },
    },
  }, "20260102003"), "");
});

test("meeting detail loader conditionally reads and mounts the static outcome panel", () => {
  assert.match(meetingsApp, /loadNonCouncilOutcomePanel/);
  assert.match(panelSource, /loadNonCouncilOutcomeLookup/);
  assert.match(panelSource, /non_council_outcome_lookup\.json/);
});
