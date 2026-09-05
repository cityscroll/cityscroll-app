#!/usr/bin/env node
// Renders the real output for card "PPD-06" (procurement-pursuit-decision) --
// a vendor's own pursuit-decision state resurfacing on a later alert or
// listing -- for a fixed set of named cases, and prints {label: caseResult}
// JSON to stdout.
//
// site/procurement_pursuit_state.mjs is a pure model with no rendered page of
// its own yet (the card explicitly allows shipping the module and its tests
// without inventing a new page). So unlike the sibling PPD-05 preference-set
// evidence tool, this script never opens a browser and never produces a
// screenshot -- it calls the real recordPursuitDecision() / pursuitStateFor()
// / resurfacePursuitState() / renderPursuitStateNoteHtml() functions directly
// and prints their exact output, which is the textual evidence this card's
// capture manifest cites.
//
// Reuses the same Fixture A (Parks, Playground reconstruction) and Fixture D
// (MTA CBTC) identities the pursuit-snapshot and preference-set capture
// fixtures already use, plus a second vendor's store to demonstrate the
// per-vendor privacy boundary (A4).

import {
  recordPursuitDecision,
  resurfacePursuitState,
  renderPursuitStateNoteHtml,
  pursuitStateFor,
} from "../site/procurement_pursuit_state.mjs";

const RECORDED_AT = "2026-07-10T09:00:00.000Z";

// A minimal Storage-like in-memory object -- the exact shape a browser's own
// localStorage exposes (getItem/setItem), and the same fake this card's own
// tests use.
function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const FIXTURE_A_ROW = {
  procurement_id: "procurement:epin-2026-07",
  short_title: "Playground reconstruction solicitation",
  agency_name: "Department of Parks and Recreation",
};

const FIXTURE_D_ROW = {
  request_id: "S48020",
  short_title: "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
  agency_name: "MTA Construction & Development",
};

// ----- Case: a vendor's recorded decision resurfaces on a later listing -----
function pursuitStateRecordedCase() {
  const vendor = memoryStore();
  const stored = recordPursuitDecision(
    vendor,
    {
      matter_ref: FIXTURE_A_ROW.procurement_id,
      decision: "pursuing",
      reason_code: "capability_fit",
      note: "Strong match for our playground-equipment crew.",
    },
    { now: new Date(RECORDED_AT) },
  );
  const laterListingRows = [FIXTURE_A_ROW, FIXTURE_D_ROW];
  const resurfaced = resurfacePursuitState(laterListingRows, vendor);
  return {
    stored_record: stored,
    resurfaced_rows: resurfaced,
    rendered_note_html: renderPursuitStateNoteHtml(resurfaced[0].pursuit_state),
    unrelated_matter_carries_no_key: !("pursuit_state" in resurfaced[1]),
  };
}

// ----- Case: no decision recorded -- nothing resurfaces, nothing inferred -----
function pursuitStateNoneCase() {
  const vendor = memoryStore();
  const laterListingRows = [FIXTURE_A_ROW, FIXTURE_D_ROW];
  const resurfaced = resurfacePursuitState(laterListingRows, vendor);
  return {
    resurfaced_rows: resurfaced,
    every_row_carries_no_key: resurfaced.every((row) => !("pursuit_state" in row)),
  };
}

// ----- Case: two vendors' stores never share a recorded decision (A4) -----
function pursuitStatePrivacyBoundaryCase() {
  const vendorOne = memoryStore();
  const vendorTwo = memoryStore();
  recordPursuitDecision(
    vendorOne,
    { matter_ref: FIXTURE_A_ROW.procurement_id, decision: "passed", reason_code: "amount" },
    { now: new Date(RECORDED_AT) },
  );
  const rows = [FIXTURE_A_ROW];
  return {
    vendor_one_sees: resurfacePursuitState(rows, vendorOne),
    vendor_two_sees: resurfacePursuitState(rows, vendorTwo),
    vendor_two_direct_lookup: pursuitStateFor(vendorTwo, FIXTURE_A_ROW.procurement_id),
  };
}

const cases = {
  "pursuit-state-recorded": pursuitStateRecordedCase(),
  "pursuit-state-none": pursuitStateNoneCase(),
  "pursuit-state-privacy-boundary": pursuitStatePrivacyBoundaryCase(),
};

process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
