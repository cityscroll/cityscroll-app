#!/usr/bin/env node
/**
 * PHC-07 evidence helper: render each of the three outcome states from
 * site/outcome_not_located_state.mjs — a matched decision, a recorded
 * no-action negative, and the not-located state in its several shapes
 * (community-board follow-up, borough-level follow-up, readable minutes that
 * mint no decision, an undated record whose notice is old, and the committed
 * citywide lookup that matches nothing at all).
 *
 * Writes each rendered fragment under site/.phc07-capture-tmp/ so the .py
 * companion can serve it locally (real /index.html CSS rules) and run axe-core
 * against it. Prints the case manifest (id, path, assertion, state) as JSON to
 * stdout. Writes no image.
 *
 *   node tools/capture_phc07_outcome_not_located_state.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { renderOutcomeState } from "../site/outcome_not_located_state.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "site/.phc07-capture-tmp");

const committedLookup = JSON.parse(
  readFileSync(path.join(ROOT, "site/data/non_council_outcome_lookup.json"), "utf8"),
);

const REQUEST_ID = "20260102003";

const BOARD_NOTICE = {
  request_id: REQUEST_ID,
  section_name: "Public Hearings and Meetings",
  agency_name: "Queens Community Board 8",
  borough: "Queens",
  body_id: "queens-cb-08",
  short_title: "ULURP 2026Q0012 public hearing",
  start_date: "2025-12-20",
  event_date: "2026-01-08",
};

const BOROUGH_NOTICE = {
  ...BOARD_NOTICE,
  agency_name: "Office of the Brooklyn Borough President",
  borough: "Brooklyn",
  body_id: null,
};

const UNDATED_OLD_NOTICE = { ...BOARD_NOTICE, event_date: null, start_date: "2019-03-04" };

/** A live-bridge lookup whose single row passes the exact source join. */
function joinedLookup(outcome) {
  return {
    schema: "cityscroll.non_council_outcome_lookup.v1",
    generated_at: "2026-08-11T18:30:00.000Z",
    coverage: { scope: "fixed_sample_not_citywide", honest_absent: true, join_bridge_enabled: true },
    notices: {
      [REQUEST_ID]: {
        request_id: REQUEST_ID,
        body_id: "queens-cb-08",
        borough: "Queens",
        meeting_date: "2026-01-08",
        ...(outcome === null ? {} : { outcome }),
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
}

const CASES = [
  {
    id: "matched_decision",
    state: "matched_decision",
    assertion: "A1/A2: an exact source join plus an explicit approved disposition renders the decision panel, visibly unlike either absence state.",
    payload: joinedLookup({ explicit: true, action: "approved", tally: { yes: 34, no: 2, abstain: 1 } }),
    notice: BOARD_NOTICE,
  },
  {
    id: "recorded_no_action",
    state: "recorded_no_action",
    assertion: "A1: an explicit no-action disposition on the same exact join renders a sourced negative, worded unlike the not-located state.",
    payload: joinedLookup({ explicit: true, action: "no_action" }),
    notice: BOARD_NOTICE,
  },
  {
    id: "not_located_community_board",
    state: "not_located",
    assertion: "A1/A4/A7: the committed lookup matches nothing, so a community-board record says the outcome was not found and offers following that board.",
    payload: committedLookup,
    notice: BOARD_NOTICE,
  },
  {
    id: "not_located_borough_level",
    state: "not_located",
    assertion: "A4: an unmatched borough-level record lands on the borough president's own site rather than a community-board path.",
    payload: committedLookup,
    notice: BOROUGH_NOTICE,
  },
  {
    id: "not_located_readable_minutes",
    state: "not_located",
    assertion: "A3: minutes joined by exact source evidence but recording no disposition stay readable and mint no decision.",
    payload: joinedLookup(null),
    notice: BOARD_NOTICE,
  },
  {
    id: "not_located_undated_old_notice",
    state: "not_located",
    assertion: "A5: a record with a missing date whose notice is years old stays not-located and never advances to held.",
    payload: committedLookup,
    notice: UNDATED_OLD_NOTICE,
  },
  {
    id: "not_located_lookup_unavailable",
    state: "not_located",
    assertion: "A6/negative rule: with no lookup at all the state is still an honest gap, and the disclosure says the last-checked date is not recorded.",
    payload: null,
    notice: BOARD_NOTICE,
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const manifestCases = [];

for (const { id, state, assertion, payload, notice } of CASES) {
  const html = renderOutcomeState(payload, REQUEST_ID, notice);
  if (!html) throw new Error(`case ${id} rendered nothing; absence is never valid proof here`);
  writeFileSync(path.join(OUT_DIR, `${id}.html`), html, "utf8");
  manifestCases.push({
    id,
    state,
    assertion,
    path: `/.phc07-capture-tmp/${id}.html`,
    body: notice.agency_name,
  });
}

process.stdout.write(JSON.stringify(manifestCases, null, 2));
