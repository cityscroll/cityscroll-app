import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildImplementationEvent,
  joinImplementationEventsToDetermination,
  projectRemedyExposureAsOf,
  SeqraImplementationEventError,
} from "../warehouse/lib/seqra_implementation_remedy_projection.mjs";
import {
  DETERMINATION_DATE,
  DETERMINATION_KEY,
  ORIGINAL_BBL,
  SAMPLE_IMPLEMENTATION_EVENTS_RAW,
  SUBDIVIDED_BBL_A,
  SUBDIVIDED_BBL_B,
} from "../warehouse/fixtures/seqra-spatial/sample_multi_lot_project.mjs";

function sampleEvents() {
  return SAMPLE_IMPLEMENTATION_EVENTS_RAW.map((raw) => buildImplementationEvent(raw));
}

describe("SEQRA-06 DOB/ACRIS implementation events -> remedy-exposure projection (A4)", () => {
  it("attributes events on/after the determination within its footprint, joining to the authorizing determination", () => {
    const { attributed_events: attributed, unattributed_events: unattributed } = joinImplementationEventsToDetermination({
      determinationKey: DETERMINATION_KEY,
      determinationDate: DETERMINATION_DATE,
      bbls: [ORIGINAL_BBL, SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B],
      events: sampleEvents(),
    });
    assert.equal(attributed.length, 4);
    assert.ok(attributed.every((e) => e.authorizing_determination_key === DETERMINATION_KEY));
    // The pre-determination filing on the original (pre-subdivision) BBL must stay unattributed even
    // though its BBL is in scope here -- its date, not its BBL, is why it is excluded.
    assert.equal(unattributed.length, 1);
    assert.equal(unattributed[0].event.bbl, ORIGINAL_BBL);
    assert.equal(unattributed[0].reason, "event_precedes_determination");
  });

  it("A4: excludes an event whose BBL falls outside the determination's footprint", () => {
    const { attributed_events: attributed, unattributed_events: unattributed } = joinImplementationEventsToDetermination({
      determinationKey: DETERMINATION_KEY,
      determinationDate: DETERMINATION_DATE,
      bbls: [SUBDIVIDED_BBL_A], // deliberately excludes BBL_B
      events: sampleEvents(),
    });
    assert.ok(attributed.every((e) => e.bbl === SUBDIVIDED_BBL_A));
    assert.ok(unattributed.some((u) => u.reason === "bbl_not_in_determination_footprint"));
  });

  it("projects the remedy-exposure ladder from lowest observed stage upward as the cutoff advances", () => {
    const { attributed_events: attributed } = joinImplementationEventsToDetermination({
      determinationKey: DETERMINATION_KEY,
      determinationDate: DETERMINATION_DATE,
      bbls: [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B],
      events: sampleEvents(),
    });

    const beforeAnyEvent = projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff: "2019-12-01", attributedEvents: attributed });
    assert.equal(beforeAnyEvent.state, "not_started");

    const afterFiling = projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff: "2020-01-01", attributedEvents: attributed });
    assert.equal(afterFiling.state, "permit_filed");

    const afterPermit = projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff: "2020-09-01", attributedEvents: attributed });
    assert.equal(afterPermit.state, "permit_issued");

    const afterTco = projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff: "2022-06-01", attributedEvents: attributed });
    assert.equal(afterTco.state, "substantially_complete");
    assert.ok(afterTco.evidence_event_keys.length > 0);
  });

  it("A2: a future event dated after the cutoff cannot raise the projected remedy-exposure stage", () => {
    const { attributed_events: attributed } = joinImplementationEventsToDetermination({
      determinationKey: DETERMINATION_KEY,
      determinationDate: DETERMINATION_DATE,
      bbls: [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B],
      events: sampleEvents(),
    });
    const cutoff = "2020-08-13"; // the day before the permit_issued event
    const withFullFutureHistory = projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff, attributedEvents: attributed });
    const withOnlyPastEvents = projectRemedyExposureAsOf({
      determinationKey: DETERMINATION_KEY,
      cutoff,
      attributedEvents: attributed.filter((e) => e.event_date <= cutoff),
    });
    // Compare the projection's actual determination -- state, rank, and the evidence it points to --
    // not the caller-input-dependent bookkeeping counts (events_excluded_after_cutoff legitimately
    // differs when the caller already pre-filtered its own input).
    assert.equal(withFullFutureHistory.state, withOnlyPastEvents.state);
    assert.equal(withFullFutureHistory.stage_rank, withOnlyPastEvents.stage_rank);
    assert.deepEqual(withFullFutureHistory.evidence_event_keys, withOnlyPastEvents.evidence_event_keys);
    assert.equal(withFullFutureHistory.state, "permit_filed");
  });

  it("rejects an event not actually attributed to the determination being projected", () => {
    const mismatched = buildImplementationEvent(SAMPLE_IMPLEMENTATION_EVENTS_RAW[0]); // authorizing_determination_key is still null
    assert.throws(
      () => projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff: "2026-01-01", attributedEvents: [mismatched] }),
      SeqraImplementationEventError,
    );
  });
});
