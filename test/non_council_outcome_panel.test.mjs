import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildNonCouncilOutcomePanelView,
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
  assert.equal(view.action, "approved");
  assert.deepEqual(view.tally, { yes: 34, no: 2, abstain: 1 });

  const html = nonCouncilOutcomePanelHTML(receiptPassedLookup, "20260102003");
  assert.match(html, /data-non-council-outcome-panel="1"/);
  assert.match(html, /Queens Community Board 8/);
  assert.match(html, /Approved/);
  assert.match(html, /34 yes · 2 no · 1 abstain/);
  assert.match(html, /Official minutes/);
  assert.match(html, /minutes-2026-01-08\.pdf/);
  assert.doesNotMatch(html, /unknown|missing|unmatched|not published|below threshold/i);
  assert.match(nonCouncilOutcomePanelHTML(receiptPassedLookup, "20260102003", { lang: "es" }), /Decisión de la junta comunitaria/);
});

test("panel rejects non-receipted, inexact, or incomplete rows", () => {
  assert.equal(nonCouncilOutcomePanelHTML({
    ...receiptPassedLookup,
    coverage: { ...receiptPassedLookup.coverage, join_bridge_enabled: false },
  }, "20260102003"), "");
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
        provenance: { document_url: "http://example.com/minutes.pdf", text_status: "ok" },
      },
    },
  }, "20260102003"), "");
});

test("meeting detail loader conditionally reads and mounts the static outcome panel", () => {
  assert.match(meetingsApp, /loadNonCouncilOutcomePanel/);
  assert.match(panelSource, /loadNonCouncilOutcomeLookup/);
  assert.match(panelSource, /non_council_outcome_lookup\.json/);
});
