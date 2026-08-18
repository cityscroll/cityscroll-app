/**
 * Land-use participation copy + Council statutory-clock coherence.
 *
 * Specimens: acquisition 2026R0127, completed mixed-action 2023M0213,
 * early-stage rezoning 2026K0123 (Filed vs Noticed + Notice after CEQR).
 * Verify: node --test test/land_use_copy_council_clock.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildLandProjectState,
  daysLeftFromDeadline,
  detectCompletedPhaseAfterCurrent,
  landDetailCoherenceReport,
  resolveLandPublicStatus,
  selectNextLandHearing,
  selectNextLandPhase,
  coherentStatutoryDue,
} from "../site/land_detail_coherence.mjs";
import {
  landParticipationGuideHeadingKey,
  landParticipationStepsMissingKey,
  normalizeLandUseActionType,
} from "../site/land_use_action_type.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";
import {
  addCalendarDays,
  buildUlurpPipelinePosition,
  buildUlurpStatutoryClockView,
  resolveStatutoryPhaseStart,
} from "../site/ulurp_statutory_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCREEN = join(ROOT, "docs/screenshots/fix-zoning-landuse-copy-council-clock");

function loadLive(id) {
  const path = join(SCREEN, `${id}-live-api.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")).record;
  } catch {
    return null;
  }
}

test("1 acquisition project does not get this-rezoning participation copy", () => {
  const acquisition = { actions: [{ action: "PQ" }], project_id: "2026R0127" };
  const type = normalizeLandUseActionType(acquisition);
  assert.equal(type.primary, "acquisition");
  assert.equal(type.is_rezoning, false);
  assert.equal(landParticipationGuideHeadingKey(acquisition), "land_guide_heading");
  assert.equal(landParticipationStepsMissingKey(acquisition), "next_action_land_steps_missing");

  const live = loadLive("2026R0127");
  if (live) {
    assert.equal(normalizeLandUseActionType(live).primary, "acquisition");
    assert.equal(landParticipationGuideHeadingKey(live), "land_guide_heading");
  }
});

test("2 genuine rezoning may still use rezoning wording", () => {
  const rezoning = { actions: "ZM,ZR" };
  assert.equal(normalizeLandUseActionType(rezoning).is_rezoning, true);
  assert.equal(landParticipationGuideHeadingKey(rezoning), "land_guide_heading_rezoning");
  assert.equal(
    landParticipationStepsMissingKey(rezoning),
    "next_action_land_steps_missing_rezoning",
  );

  const specialPermit = { actions: [{ action: "ZS" }] };
  assert.equal(normalizeLandUseActionType(specialPermit).primary, "special_permit");
  assert.equal(landParticipationGuideHeadingKey(specialPermit), "land_guide_heading");

  const demap = { actions: "MM" };
  assert.equal(normalizeLandUseActionType(demap).primary, "mapping");
});

test("3 a 50-day clock yields a deadline consistent with its start", () => {
  const start = "2026-07-31";
  const due = addCalendarDays(start, 50);
  assert.equal(due, "2026-09-19");
  const check = coherentStatutoryDue({ startDate: start, dueDate: due, windowDays: 50 });
  assert.equal(check.ok, true);
  assert.equal(check.due_date, due);

  const live = loadLive("2026R0127");
  if (!live) return;
  const clock = buildUlurpStatutoryClockView(live);
  const council = clock.phases.find((p) => p.phase_id === "city_council");
  assert.equal(council.start_date, "2026-07-31");
  assert.equal(council.start_basis, "milestone_actual_start");
  assert.equal(council.days, 50);
  assert.equal(council.due_date, "2026-09-19");
  assert.equal(council.deadline_certainty, "statutory");
  assert.equal(council.deadline_basis, "phase_window");
  // Nov 27 is the outer cumulative envelope — not the phase deadline.
  assert.equal(council.outer_bound_due_date, "2026-11-27");
  assert.notEqual(council.due_date, council.outer_bound_due_date);
});

test("4 days-left is computed from the same displayed deadline", () => {
  const live = loadLive("2026R0127");
  if (!live) return;
  const clock = buildUlurpStatutoryClockView(live);
  const view = buildLandPhaseView(live.spine, {
    open_data: live.open_data,
    public_status: live.public_status,
    project_id: live.project_id,
  });
  const pos = buildUlurpPipelinePosition({
    phaseView: view,
    clock,
    publicStatus: live.public_status,
    today: "2026-08-17",
  });
  assert.equal(pos.due_date, "2026-09-19");
  assert.equal(pos.days_left, daysLeftFromDeadline(pos.due_date, "2026-08-17"));
  assert.equal(pos.days_left, 33);
  assert.equal(pos.window_days, 50);
  // Impossible prior UI: 50-day clock with ~101 days left from Nov 27.
  assert.ok(pos.days_left <= pos.window_days);
});

test("5 past deadline cannot produce positive days-left", () => {
  assert.equal(daysLeftFromDeadline("2026-08-01", "2026-08-17"), -16);
  assert.ok(daysLeftFromDeadline("2026-08-01", "2026-08-17") < 0);
  assert.equal(daysLeftFromDeadline("2026-08-17", "2026-08-17"), 0);
  assert.equal(daysLeftFromDeadline(null, "2026-08-17"), null);
});

test("6 estimated / outer-bound deadlines are not presented as statutory phase facts", () => {
  // Certified only — later phases lack a start, so due_date stays null (fail closed).
  const record = {
    project_id: "FIXTURE-EST",
    public_status: "In Public Review",
    certified_referred: "2026-05-11",
    milestones: [
      {
        id: "cert",
        title: "Application Reviewed at City Planning Commission Review Session",
        status: "Completed",
        outcome: "Certified",
        time: { value: "2026-05-11", basis: "review_meeting", certainty: "actual" },
      },
    ],
  };
  const clock = buildUlurpStatutoryClockView(record);
  const council = clock.phases.find((p) => p.phase_id === "city_council");
  assert.equal(council.deadline_certainty, "insufficient");
  assert.equal(council.due_date, null);
  assert.equal(council.outer_bound_due_date, addCalendarDays("2026-05-11", 200));
});

test("7 missing/insufficient timing data fails closed — no invented statutory deadline", () => {
  const start = resolveStatutoryPhaseStart(
    { public_status: "In Public Review", milestones: [] },
    "city_council",
  );
  assert.equal(start, null);

  const bad = coherentStatutoryDue({
    startDate: "2026-07-31",
    dueDate: "2026-11-27",
    windowDays: 50,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "due_exceeds_window");
  assert.equal(bad.due_date, null);

  const before = coherentStatutoryDue({
    startDate: "2026-07-21",
    dueDate: "2026-07-08",
    windowDays: 5,
  });
  assert.equal(before.ok, false);
  assert.equal(before.reason, "due_before_start");
});

test("8 phase-spine stages reflect stages applicable to the project/action type", () => {
  const live = loadLive("2026R0127");
  if (!live) return;
  const view = buildLandPhaseView(live.spine, {
    open_data: live.open_data,
    public_status: live.public_status,
    project_id: live.project_id,
  });
  const ids = view.phases.map((p) => p.id);
  assert.ok(ids.includes("city_council"));
  assert.ok(ids.includes("mayoral_appeals"));
  // Acquisition never entered CEQR / pre-cert — omit empty future pre-review slots.
  assert.ok(!ids.includes("environmental"));
  assert.ok(!ids.includes("pre_certification"));
  assert.equal(view.current.phase_id, "city_council");
  assert.equal(view.next?.phase_id, "mayoral_appeals");
});

test("page coherence: completed project resolves one public_status and no past next hearing", () => {
  const live = loadLive("2023M0213");
  if (!live) return;
  const listRow = { project_id: "2023M0213", public_status: "In Public Review" };
  const status = resolveLandPublicStatus(listRow, live);
  assert.equal(status.public_status, "Completed");
  assert.equal(status.disagreement, true);

  const view = buildLandPhaseView(live.spine, {
    open_data: live.open_data,
    public_status: status.public_status,
    project_id: live.project_id,
  });
  assert.equal(view.current.phase_id, "mayoral_appeals");
  assert.equal(view.next, null);
  assert.equal(view.current.in_public_review, false);

  const hearings = [{ event_date: "2026-02-04", agency: "Community Board" }];
  assert.equal(selectNextLandHearing(hearings, "2026-08-17"), null);

  const backwards = selectNextLandPhase(
    [
      { id: "pre_certification", state: "future" },
      { id: "mayoral_appeals", state: "current" },
    ],
    "mayoral_appeals",
  );
  assert.equal(backwards, null);

  const clock = buildUlurpStatutoryClockView(live);
  const mayor = clock.phases.find((p) => p.phase_id === "mayoral_appeals");
  assert.equal(mayor.status, "completed");
  assert.equal(mayor.due_date, null);

  const report = landDetailCoherenceReport({
    listRow,
    outcomeRecord: live,
    phaseView: view,
    hearings,
    clock,
    today: "2026-08-17",
  });
  assert.equal(report.public_status, "Completed");
  assert.equal(report.next_hearing, null);
  assert.equal(report.next_phase, null);
  assert.equal(report.coherent, true);
});

test("i18n English strings no longer hardcode rezoning for the generic land guide", () => {
  const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  assert.match(i18n, /land_guide_heading:\s*"How to participate in this land-use review"/);
  assert.match(i18n, /land_guide_heading_rezoning:\s*"How to participate in this rezoning"/);
  assert.match(
    i18n,
    /next_action_land_steps_missing:\s*"No participation steps are published for this land-use review yet\."/,
  );
  assert.match(i18n, /land_pipeline_clock_in_progress:/);
  assert.match(i18n, /land_spine_phase_overlap_notice:/);
});

test("2026K0123: Filed vs Noticed are one public_status dimension — resolve to portal Noticed", () => {
  const live = loadLive("2026K0123");
  assert.ok(live, "expected 2026K0123 live API fixture");
  const listRow = { project_id: "2026K0123", public_status: "Filed", project_status: "Active" };
  assert.equal(live.public_status, "Noticed");
  assert.equal(live.open_data?.public_status, "Filed");

  const status = resolveLandPublicStatus(listRow, live);
  // Same ZAP public_status enum; Open Data lags. One reader-facing value.
  assert.equal(status.dimension, "public_status");
  assert.equal(status.dimension_note, "single_zap_public_status_enum");
  assert.equal(status.public_status, "Noticed");
  assert.equal(status.source, "zap_outcomes.public_status");
  assert.equal(status.disagreement, true);
  assert.ok(status.source_lag);

  const project = buildLandProjectState({
    listRow,
    outcomeRecord: live,
    buildLandPhaseView,
  });
  assert.equal(project.public_status, "Noticed");
  assert.equal(project.phase_view?.current?.public_status, "Noticed");
  // Participation + timeline must share this single resolved value — never two
  // "Public status" labels for Filed vs Noticed.
  assert.equal(project.public_status_dimension, "public_status");
});

test("2026K0123: Notice after CEQR cannot read completed; explained overlap only", () => {
  const live = loadLive("2026K0123");
  assert.ok(live, "expected 2026K0123 live API fixture");
  const listRow = { project_id: "2026K0123", public_status: "Filed" };
  const status = resolveLandPublicStatus(listRow, live);
  const view = buildLandPhaseView(live.spine, {
    open_data: live.open_data,
    public_status: status.public_status,
    project_id: live.project_id,
  });

  assert.equal(view.current.phase_id, "pre_application");
  assert.equal(view.next?.phase_id, "environmental");

  const notice = view.phases.find((p) => p.id === "pre_certification");
  assert.ok(notice);
  assert.equal(notice.state, "overlap");
  assert.notEqual(notice.state, "passed");
  assert.equal(notice.overlap?.permitted, true);
  assert.equal(notice.overlap?.label_key, "land_spine_phase_overlap_notice");

  const order = detectCompletedPhaseAfterCurrent(view);
  assert.equal(order.ok, true);
  assert.deepEqual(order.violations, []);

  // Regression: a synthetic "passed" Notice after current must fail the invariant.
  const broken = {
    ...view,
    phases: view.phases.map((p) =>
      p.id === "pre_certification" ? { ...p, state: "passed", overlap: null } : p
    ),
  };
  const brokenOrder = detectCompletedPhaseAfterCurrent(broken);
  assert.equal(brokenOrder.ok, false);
  assert.equal(brokenOrder.violations[0]?.reason, "completed_after_current_unexplained");

  const report = landDetailCoherenceReport({
    listRow,
    outcomeRecord: live,
    phaseView: view,
    today: "2026-08-17",
  });
  assert.equal(report.coherent, true);
  assert.equal(report.public_status, "Noticed");
});
