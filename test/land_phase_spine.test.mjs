import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Characterization: Land/ZAP timeline ULURP phase grouping.
 * Field cases: long pre-cert thrash (2019K0147); mid-public-review (2022M0258).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAND_ULURP_PHASES,
  aggregatePhaseEvents,
  buildLandPhaseView,
  countDuplicatePortalLinks,
  deriveLandCurrentPhaseId,
  isProjectPortalUrl,
  mapMilestoneToPhase,
} from "../site/land_phase_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture2019 = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_phase_spine/2019K0147.json"), "utf8"),
);
const fixture2022 = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_phase_spine/2022M0258.json"), "utf8"),
);
const fixture2019K0190 = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_phase_spine/2019K0190.json"), "utf8"),
);

test("LAND_ULURP_PHASES follows pre-review then statutory public review", () => {
  assert.deepEqual([...LAND_ULURP_PHASES], [
    "pre_application",
    "environmental",
    "pre_certification",
    "certification",
    "community_board",
    "borough_president",
    "cpc",
    "city_council",
    "mayoral_appeals",
  ]);
});

test("mapMilestoneToPhase covers filing, CEQR, boards, CPC, council, appeals", () => {
  assert.equal(mapMilestoneToPhase("Land Use Application Filed"), "pre_application");
  assert.equal(mapMilestoneToPhase("Environmental Assessment Statement Filed"), "environmental");
  assert.equal(mapMilestoneToPhase("CEQR Fee Paid"), "environmental");
  assert.equal(mapMilestoneToPhase("Community Board Review"), "community_board");
  assert.equal(mapMilestoneToPhase("Borough President Review"), "borough_president");
  assert.equal(mapMilestoneToPhase("City Planning Commission Vote"), "cpc");
  assert.equal(mapMilestoneToPhase("City Council Review"), "city_council");
  assert.equal(mapMilestoneToPhase("Appeals Board Review"), "mayoral_appeals");
  assert.equal(
    mapMilestoneToPhase("Application Reviewed at City Planning Commission Review Session"),
    "certification",
  );
});

test("aggregatePhaseEvents collapses verbatim titles and keeps all members", () => {
  const events = [
    { title: "Land Use Application Filed", time: { value: "2021-07-19" }, detail: "Completed" },
    { title: "Land Use Application Filed", time: { value: "2023-01-13" }, detail: "Completed" },
    { title: "Land Use Fee Paid", time: { value: "2021-08-17" }, detail: "Completed" },
  ];
  const agg = aggregatePhaseEvents(events);
  const filed = agg.find((a) => a.title === "Land Use Application Filed");
  assert.equal(filed.count, 2);
  assert.equal(filed.first, "2021-07-19");
  assert.equal(filed.last, "2023-01-13");
  assert.equal(filed.members.length, 2);
  assert.equal(agg.find((a) => a.title === "Land Use Fee Paid").count, 1);
});

test("isProjectPortalUrl dedupes identical project links", () => {
  const portal = "https://zap.planning.nyc.gov/projects/2019K0147";
  assert.equal(isProjectPortalUrl(portal, portal), true);
  assert.equal(isProjectPortalUrl(portal + "/", portal), true);
  assert.equal(isProjectPortalUrl("https://a856-cityrecord.nyc.gov/RequestDetail/1", portal), false);
});

test("2019K0147: current CEQR, Filed×16 aggregate, 40 portal-link candidates, next=certification", () => {
  const view = buildLandPhaseView(fixture2019.spine, {
    open_data: fixture2019.open_data,
    portal_url: fixture2019.portal_url,
    public_status: fixture2019.public_status,
    project_id: fixture2019.project_id,
  });

  assert.equal(view.event_count, 40);
  assert.equal(view.current.phase_id, "environmental");
  assert.equal(view.current.noticed, true);
  assert.equal(view.current.milestone_label, "EAS - Project Readiness");
  assert.equal(view.next?.phase_id, "certification");

  assert.equal(
    countDuplicatePortalLinks(fixture2019.spine, fixture2019.portal_url),
    40,
  );
  assert.equal(view.portal_row_link_candidates, 40);

  const filing = view.phases.find((p) => p.id === "pre_application");
  assert.equal(filing.state, "passed");
  const filedAgg = filing.aggregates.find((a) => a.title === "Land Use Application Filed");
  assert.equal(filedAgg.count, 16);
  assert.equal(filedAgg.members.length, 16);
  assert.equal(filedAgg.first, "2021-07-19");
  assert.equal(filedAgg.last, "2025-05-19");

  const ceqr = view.phases.find((p) => p.id === "environmental");
  assert.equal(ceqr.state, "current");
  const easAgg = ceqr.aggregates.find((a) => /Environmental Assessment Statement Filed/i.test(a.title));
  assert.equal(easAgg.count, 12);

  const notice = view.phases.find((p) => p.id === "pre_certification");
  assert.equal(notice.state, "passed");

  const cb = view.phases.find((p) => p.id === "community_board");
  assert.equal(cb.state, "future");

  // All original events remain reachable via chronological or phase all_events / aggregates.
  const memberTotal = view.phases.reduce(
    (n, p) => n + p.aggregates.reduce((m, a) => m + a.members.length, 0),
    0,
  );
  // Synthetic Noticed status may add one member beyond the 40 portal events.
  assert.ok(memberTotal >= 40);
  assert.equal(view.chronological.length, 40);
});

test("2022M0258: mid public-review maps current to City Council phase", () => {
  const view = buildLandPhaseView(fixture2022.spine, {
    open_data: fixture2022.open_data,
    portal_url: fixture2022.portal_url,
    public_status: fixture2022.public_status,
    project_id: fixture2022.project_id,
  });
  assert.equal(view.current.phase_id, "city_council");
  assert.ok(view.phases.find((p) => p.id === "community_board")?.state === "passed");
  assert.ok(view.phases.find((p) => p.id === "cpc")?.state === "passed");
  assert.equal(view.event_count, fixture2022.spine.events.length);
});

test("2019K0190: stranded CB In Progress does not stay current after BP/CPC completed", () => {
  // Field case (site owner report 2026-08-03): Community Board Review remains
  // "In Progress" with no outcome row while Borough President and CPC votes
  // already completed. Pipeline position must advance; CB is not "current".
  const view = buildLandPhaseView(fixture2019K0190.spine, {
    open_data: fixture2019K0190.open_data,
    portal_url: fixture2019K0190.portal_url,
    public_status: fixture2019K0190.public_status,
    project_id: fixture2019K0190.project_id,
  });

  assert.notEqual(view.current.phase_id, "community_board");
  assert.equal(view.current.phase_id, "city_council");
  assert.match(String(view.current.derivation || ""), /advanced_past_terminal|last_actual|in_progress/);

  const cb = view.phases.find((p) => p.id === "community_board");
  assert.equal(cb.state, "passed");
  assert.equal(cb.outcome_status, "no_recorded_outcome");

  const bp = view.phases.find((p) => p.id === "borough_president");
  const cpc = view.phases.find((p) => p.id === "cpc");
  assert.equal(bp.state, "passed");
  assert.equal(cpc.state, "passed");
  assert.ok(cpc.last === "2026-07-15" || (cpc.events || []).some((e) => /Vote/i.test(e.title || "")));

  // Lead milestone must not keep the lagging Open Data "Community Board Referral" label.
  assert.ok(
    !/community board referral/i.test(String(view.current.milestone_label || "")),
    `stale open-data label leaked: ${view.current.milestone_label}`,
  );

  // deriveLandCurrentPhaseId is the pure pointer used by audits.
  const byPhase = Object.fromEntries(LAND_ULURP_PHASES.map((id) => [id, []]));
  for (const event of fixture2019K0190.spine.events) {
    const phaseId = mapMilestoneToPhase(event.title, {
      kind: event.kind,
      representing: event.detail,
      detail: event.detail,
    });
    (byPhase[phaseId] || byPhase.pre_application).push(event);
  }
  const pointer = deriveLandCurrentPhaseId({
    byPhase,
    events: fixture2019K0190.spine.events,
    currentMilestoneLabel: fixture2019K0190.open_data?.current_milestone,
    completedLike: false,
  });
  assert.equal(pointer.phase_id, "city_council");
});

test("public Land detail template uses phase spine surface", () => {
  const index = SITE_SOURCE;
  assert.match(index, /function landSpineHTML/);
  assert.match(index, /buildLandPhaseView|land_phase_spine/);
  assert.match(index, /land-phase-stepper|land-spine-lead/);
  assert.match(index, /land_spine_portal_link|land_outcomes_portal_link/);
  assert.match(index, /land_spine_show_dates|land_spine_show_all/);
});
