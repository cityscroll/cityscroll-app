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

import { buildUlurpStatutoryClockView } from "../site/ulurp_statutory_clock.mjs";
import { resolveLandProcedureVariant } from "../site/land_procedure_profiles.mjs";
import { buildLandPhaseRoleStrip, landPhaseRoleStripHTML } from "../site/land_phase_role_strip.mjs";

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

/** LDP-31 real ELURP regression corpus (E1-E4) plus one ordinary-ULURP control. */
function loadLdp31Fixture(name) {
  return JSON.parse(readFileSync(join(ROOT, `test/fixtures/land_phase_spine/${name}.json`), "utf8"));
}
const fixtureE1 = loadLdp31Fixture("2024Q0356");
const fixtureE2 = loadLdp31Fixture("2024Q0419");
const fixtureE3 = loadLdp31Fixture("2025R0257");
const fixtureE4 = loadLdp31Fixture("2026X0362");
const fixtureUlurpControl = loadLdp31Fixture("ulurp_control_2023X0100");

function viewFromLdp31Fixture(fixture) {
  return buildLandPhaseView(fixture.spine, {
    open_data: fixture.open_data,
    actions: fixture.actions,
    portal_url: fixture.portal_url,
    public_status: fixture.public_status,
    project_id: fixture.project_id,
  });
}

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
  // Noticed while current is still CEQR: concurrent overlap, not plain "Done"
  // after the next step in the Filing→CEQR→Notice sequence.
  assert.equal(notice.state, "overlap");
  assert.equal(notice.overlap?.permitted, true);
  assert.equal(notice.overlap?.label_key, "land_spine_phase_overlap_notice");

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

/**
 * LDP-31: phase selection, grouping, and terminal-stage behavior are driven by
 * the resolved procedure plus observed-event topology — never a fixed
 * ordinary-ULURP rail — for the real ELURP regression corpus (E1-E4).
 */
test("A1, A2, A9 E1 2024Q0356: pre-certification ELURP shows Filing/CEQR/Notice/Certification/CB/BP/CPC only", () => {
  const view = viewFromLdp31Fixture(fixtureE1);

  assert.equal(view.current.phase_id, "environmental");
  assert.equal(view.current.milestone_label, "Environmental Assessment Statement Filed");
  assert.equal(view.current.since, "2026-03-10");
  assert.equal(view.current.noticed, true);
  assert.equal(view.current.public_status, "Noticed");
  assert.equal(view.next?.phase_id, "certification");

  assert.equal(view.procedure_profile.status, "resolved");
  assert.equal(view.procedure_profile.profile_id, "elurp_197e");
  assert.equal(view.land_actions[0].application_id, "260272ZMQ");
  assert.equal(view.land_actions[0].procedure_id, "elurp_197e");

  // A2: the rail contains Filing, CEQR, Notice, Certification, parallel CB/BP,
  // and CPC only — no more, no fewer.
  assert.deepEqual(
    view.phases.map((p) => p.id),
    ["pre_application", "environmental", "pre_certification", "certification", "community_board", "borough_president", "cpc"],
  );
  // A3: Council and Mayor are absent from both the compact (applicable) and
  // expanded (all_phases still lists every template slot, but none carry a
  // false statutory event) future panels.
  assert.ok(!view.phases.some((p) => p.id === "city_council" || p.id === "mayoral_appeals"));
  const councilAll = view.all_phases.find((p) => p.id === "city_council");
  const mayorAll = view.all_phases.find((p) => p.id === "mayoral_appeals");
  assert.equal(councilAll.event_count, 0);
  assert.equal(mayorAll.event_count, 0);

  // No certification date — the certification phase has no observed events.
  const certification = view.phases.find((p) => p.id === "certification");
  assert.equal(certification.first, null);
  assert.equal(certification.event_count, 0);

  // A2/concurrent copy: Community Board and Borough President review at the
  // same time, not one after the other.
  const cb = view.phases.find((p) => p.id === "community_board");
  const bp = view.phases.find((p) => p.id === "borough_president");
  assert.deepEqual(cb.concurrent_with, ["borough_president"]);
  assert.deepEqual(bp.concurrent_with, ["community_board"]);
});

test("A4 E2 2024Q0419 and E3 2025R0257: completed elurp_197e shows concurrent CB/BP then a terminal CPC", () => {
  for (const fixture of [fixtureE2, fixtureE3]) {
    const view = viewFromLdp31Fixture(fixture);
    assert.equal(view.current.phase_id, "cpc", fixture.project_id);
    assert.equal(view.next, null, fixture.project_id);
    assert.deepEqual(
      view.phases.map((p) => p.id),
      ["pre_application", "certification", "community_board", "borough_president", "cpc"],
      fixture.project_id,
    );
    assert.ok(
      !view.phases.some((p) => p.id === "city_council" || p.id === "mayoral_appeals"),
      fixture.project_id,
    );
    const cb = view.phases.find((p) => p.id === "community_board");
    const bp = view.phases.find((p) => p.id === "borough_president");
    assert.equal(cb.state, "passed", fixture.project_id);
    assert.equal(bp.state, "passed", fixture.project_id);
    assert.deepEqual(cb.concurrent_with, ["borough_president"], fixture.project_id);
    const cpc = view.phases.find((p) => p.id === "cpc");
    assert.equal(cpc.state, "current", fixture.project_id);
    assert.equal(cpc.aggregates[0].title, "City Planning Commission Vote", fixture.project_id);
  }

  // A4: the exact ZAP API identifier is canonical; the narrower Open Data
  // number is retained only as a provenanced alias, never the canonical id.
  const e2 = viewFromLdp31Fixture(fixtureE2);
  assert.equal(e2.land_actions[0].application_id, "C250331ZMQ");
  assert.equal(e2.land_actions[0].aliases[0].application_id, "250331ZMQ");
  const e3 = viewFromLdp31Fixture(fixtureE3);
  assert.equal(e3.land_actions[0].application_id, "C260217PCR");
  assert.equal(e3.land_actions[0].aliases[0].application_id, "260217PCR");

  // A8: E3's CEQR "Type II" classification is source metadata, not an
  // observed event — no environmental phase is manufactured for it, and E3
  // does not require an EAS/CEQR phase merely because E2 render differently.
  const e3Environmental = e3.phases.find((p) => p.id === "environmental");
  assert.equal(e3Environmental, undefined);
});

test("A5 E4 2026X0362: HPD ELURP shows the observed Council path with no synthetic certification or CPC", () => {
  const view = viewFromLdp31Fixture(fixtureE4);

  assert.equal(view.current.phase_id, "city_council");
  assert.equal(view.next, null);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    ["pre_application", "community_board", "borough_president", "city_council"],
  );
  assert.ok(!view.phases.some((p) => p.id === "certification" || p.id === "cpc" || p.id === "mayoral_appeals"));
  assert.equal(view.land_actions[0].application_id, "HPD260001PPX");

  // A5/A6: the broad ELURP procedure resolves; the § 197-e(k) variant stays
  // unresolved without exact retained referral/application evidence — an
  // observed Council outcome alone never supplies that eligibility evidence.
  assert.equal(view.procedure_profile.profile_id, "elurp_197e");
  assert.equal(view.procedure_profile.broad_profile_id, null);
  const variant = resolveLandProcedureVariant({
    broad_profile_id: view.procedure_profile.profile_id,
    evidence: { kind: "observed_council_outcome", retained: true, outcome: "Adopted" },
  });
  assert.equal(variant.status, "unresolved");
  assert.equal(variant.variant_id, null);
});

test("A6, A7 every explicit ELURP specimen is ineligible for the § 197-c statutory clock, with no prediction", () => {
  // A6/A7 hold for every explicit ELURP record regardless of certification
  // status: the clock rejects on procedure before it ever looks at
  // certification, so E1 (pre-certification) and E4 (no DCP certification
  // step at all) read wrong_procedure exactly like the certified E2/E3 route
  // — never not_certified, which would wrongly imply certification could
  // still unlock a §197-c clock for these records.
  for (const fixture of [fixtureE1, fixtureE2, fixtureE3, fixtureE4]) {
    const clock = buildUlurpStatutoryClockView({
      ...fixture.open_data,
      spine: fixture.spine,
    });
    assert.equal(clock.status, "ineligible", fixture.project_id);
    assert.equal(clock.reason, "wrong_procedure", fixture.project_id);
    assert.deepEqual(clock.phases, [], fixture.project_id);
    assert.equal(clock.total_days, undefined, fixture.project_id);
  }
});

test("A9 ordinary ULURP control retains the full fixed rail (CB -> BP -> CPC -> conditional Council/Mayor)", () => {
  const view = viewFromLdp31Fixture(fixtureUlurpControl);
  assert.equal(view.current.phase_id, "community_board");
  assert.equal(view.procedure_profile.profile_id, "ulurp_197c");
  // The compatibility fallback is untouched: every statutory public-review
  // stage after current still previews, including Council and Mayor.
  assert.deepEqual(
    view.phases.map((p) => p.id),
    ["pre_application", "certification", "community_board", "borough_president", "cpc", "city_council", "mayoral_appeals"],
  );
});

/**
 * LDP-21: profile-backed normative role strips absorbed from the retired
 * ldp-09-timeline-role-strips card (data/decisions/ldp09-absorb-retire.md).
 * Historical: unlike LDP-08's current-stage-only "Where this stands" panel,
 * a role strip is built for every profile-backed stage — passed, current,
 * and future — never only the current one.
 */
const TEST_COPY = {
  land_authority_unknown: "Unknown",
  land_authority_provenance_profile: "Profile",
  land_authority_role_here_advisory_reviewer: "advisory review",
  land_authority_role_here_decision_maker: "decision role",
  land_role_strip_kicker: "Normative role — not an observed event",
  land_role_strip_role: "{actor}’s role here: {role}.",
  land_role_strip_window_days_html: "<b>Calculated window:</b> up to {days} calendar days — not an observed date.",
  land_role_strip_window_days_alt_eis_html: "<b>Calculated window:</b> up to {days} calendar days ({alt} days if an environmental impact statement is required) — not an observed date.",
  land_role_strip_window_rules_defined: "Timing follows adopted procedural rules, not a fixed statutory count.",
};
function testTranslate(key, vars) {
  let text = Object.hasOwn(TEST_COPY, key) ? TEST_COPY[key] : key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name] ?? "") : match));
  }
  return text;
}
function testEscape(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

test("A1 ulurp_197c community_board role strip: advisory role, calculated 60-day window, profile citation", () => {
  const view = viewFromLdp31Fixture(fixtureUlurpControl);
  const strip = buildLandPhaseRoleStrip(view, "community_board");
  assert.equal(strip.stage_id, "ulurp_197c.community_board_review");
  assert.equal(strip.profile_id, "ulurp_197c");
  assert.equal(strip.role, "advisory_reviewer");
  assert.equal(strip.time_window.calculated, true);
  assert.equal(strip.time_window.days, 60);
  assert.match(strip.legal_basis.citation, /NYC Charter § 197-c\(c\)/);

  const html = landPhaseRoleStripHTML(strip, { t: testTranslate, escape: testEscape });
  assert.match(html, /data-land-authority-kind="role_definition"/);
  assert.match(html, /data-land-role-strip-window="calculated"/);
  assert.match(html, /<b>Calculated window:<\/b> up to 60 calendar days — not an observed date\./);
  assert.match(html, /advisory review/);
  assert.match(html, new RegExp(strip.legal_basis.citation.replace(/[()]/g, "\\$&")));
});

test("A1 the borough_president phase resolves the borough-board stage only when the affected fact is true", () => {
  const view = viewFromLdp31Fixture(fixtureUlurpControl);
  const withoutBoard = buildLandPhaseRoleStrip(view, "borough_president");
  assert.equal(withoutBoard.stage_id, "ulurp_197c.borough_president_review");
  assert.equal(withoutBoard.time_window.days, 30);

  const withBoard = buildLandPhaseRoleStrip(
    { ...view, affected_review_bodies: { ...(view.affected_review_bodies || {}), borough_board: true } },
    "borough_president",
  );
  assert.equal(withBoard.stage_id, "ulurp_197c.borough_board_review");
});

test("A1 a rules_defined window is labelled without a fabricated day count", () => {
  const strip = buildLandPhaseRoleStrip(
    {
      procedure_profile: {
        status: "resolved",
        profile_id: "plan_197a",
        registry_version: "2026-08-27.v1",
        stages: [{
          stage_id: "plan_197a.affected_body_review",
          spine_phase_id: "community_board",
          role: "advisory_reviewer",
          effect: "Reviews under adopted rules.",
          actor_selector: { kind: "affected_community_board" },
          time_window: { kind: "rules_defined", basis: "NYC Charter § 197-a(c)" },
          legal_basis: [{ citation: "NYC Charter § 197-a(c)", source_url: "https://example.invalid/197a" }],
        }],
      },
      affected_review_bodies: {},
    },
    "community_board",
  );
  assert.equal(strip.time_window.calculated, false);
  const html = landPhaseRoleStripHTML(strip, { t: testTranslate, escape: testEscape });
  assert.match(html, /data-land-role-strip-window="rules_defined"/);
  assert.match(html, /Timing follows adopted procedural rules/);
  assert.doesNotMatch(html, /Calculated window/);
});

test("negative rule: a phase the resolved profile does not model returns null, never inventing a stage", () => {
  const view = viewFromLdp31Fixture(fixtureE1);
  assert.equal(view.procedure_profile.status, "resolved");
  assert.equal(view.procedure_profile.profile_id, "elurp_197e");
  // elurp_197e models only pre_application/community_board/borough_president/cpc —
  // environmental, pre_certification, certification, and city_council are all
  // observed-only phases here; a role strip must never be invented for them.
  for (const phaseId of ["environmental", "pre_certification", "certification", "city_council", "mayoral_appeals"]) {
    assert.equal(buildLandPhaseRoleStrip(view, phaseId), null, phaseId);
  }
  assert.notEqual(buildLandPhaseRoleStrip(view, "community_board"), null);
});

test("an unresolved procedure never produces a role strip for any phase", () => {
  const view = viewFromLdp31Fixture(fixtureUlurpControl);
  const unresolvedView = { ...view, procedure_profile: { status: "unresolved", profile_id: null, stages: null } };
  for (const phaseId of LAND_ULURP_PHASES) {
    assert.equal(buildLandPhaseRoleStrip(unresolvedView, phaseId), null, phaseId);
  }
});

test("A3 buildLandPhaseRoleStrip never mutates the observed event ledger", () => {
  const view = viewFromLdp31Fixture(fixtureE1);
  const before = JSON.stringify({
    event_count: view.event_count,
    chronological: view.chronological,
    phases: view.phases.map((p) => ({
      id: p.id,
      state: p.state,
      event_count: p.event_count,
      total_count: p.total_count,
      first: p.first,
      last: p.last,
      aggregates: p.aggregates,
      events: p.events,
      all_events: p.all_events,
    })),
  });
  for (const phaseId of LAND_ULURP_PHASES) buildLandPhaseRoleStrip(view, phaseId);
  const after = JSON.stringify({
    event_count: view.event_count,
    chronological: view.chronological,
    phases: view.phases.map((p) => ({
      id: p.id,
      state: p.state,
      event_count: p.event_count,
      total_count: p.total_count,
      first: p.first,
      last: p.last,
      aggregates: p.aggregates,
      events: p.events,
      all_events: p.all_events,
    })),
  });
  assert.equal(after, before, "the observed ledger changed after building role strips — a role strip must never mutate it");
});

test("A3 the rendered role strip never emits a recommendation, vote, hearing, or decision row", () => {
  const view = viewFromLdp31Fixture(fixtureUlurpControl);
  const strip = buildLandPhaseRoleStrip(view, "community_board");
  const html = landPhaseRoleStripHTML(strip, { t: testTranslate, escape: testEscape });
  // Structural markers of an OBSERVED row (class/data-attribute, not prose) —
  // the effect text is normative profile prose and may legitimately describe
  // what a body is empowered to recommend, so only DOM markers are checked.
  for (const marker of ["land-phase-row", "land-phase-agg", "land-spine-event", "data-land-authority-observed", "votes_for"]) {
    assert.doesNotMatch(html, new RegExp(marker), marker);
  }
});

test("public Land detail phase panel wires the role strip above the observed rows, never inside the aggregate/event renderers", () => {
  const landSrc = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
  assert.match(landSrc, /import\("\.\.\/land_phase_role_strip\.mjs"\)/);
  assert.match(landSrc, /globalThis\.buildLandPhaseRoleStrip=roleStrip\.buildLandPhaseRoleStrip/);
  assert.match(landSrc, /globalThis\.landPhaseRoleStripHTML=roleStrip\.landPhaseRoleStripHTML/);
  assert.match(landSrc, /\$\{roleStripHTML\}\$\{statutory\}\$\{body\}/);

  const aggregateFn = landSrc.slice(
    landSrc.indexOf("function landPhaseAggregateHTML"),
    landSrc.indexOf("function landStatutoryDeadlineHTML"),
  );
  const eventRowFn = landSrc.slice(
    landSrc.indexOf("function landSpineEventRowHTML"),
    landSrc.indexOf("function landPhaseAggregateHTML"),
  );
  assert.ok(aggregateFn.length > 0 && eventRowFn.length > 0);
  for (const marker of ["roleStrip", "role_definition", "land-role-strip", "buildLandPhaseRoleStrip"]) {
    assert.doesNotMatch(aggregateFn, new RegExp(marker), `landPhaseAggregateHTML references ${marker}`);
    assert.doesNotMatch(eventRowFn, new RegExp(marker), `landSpineEventRowHTML references ${marker}`);
  }
});
