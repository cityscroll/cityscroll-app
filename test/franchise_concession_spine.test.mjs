/**
 * Characterization: franchise / concession review process spine
 * (solicitation → public_hearing → committee_meeting → award).
 *
 * Field cases: full four-stage party chain; annual concession plan hearing;
 * calendar FCRC meeting singleton; Council zoning-franchises excluded;
 * empty stages class-(a) not_yet_ingested (never false not_published).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FRANCHISE_CONCESSION_STAGES,
  STAGE_AWARD,
  STAGE_COMMITTEE_MEETING,
  STAGE_PUBLIC_HEARING,
  STAGE_SOLICITATION,
  attachFranchiseConcessionSpines,
  buildFranchiseConcessionSpine,
  classifyFranchiseConcessionStage,
  extractCounterparties,
  franchiseConcessionJoinKeys,
  groupFranchiseConcessionSpines,
  isFranchiseConcessionEligible,
  measureFranchiseConcessionSpineCompleteness,
  spineForNotice,
} from "../worker/src/lib/franchise_concession_spine.mjs";
import { SODA_WHERE } from "../worker/src/franchise_concession.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/franchise_concession/field_cases.json"), "utf8"),
);

/**
 * SoQL string literals escape a single quote by doubling it ('').
 * A backslash-escaped apostrophe (Mayor\'s) is invalid SoQL and returns HTTP 400
 * from Socrata — which zeroed the whole franchise/FCRC materialization OR-query.
 */
function soqlClauseEscapesApostrophe(clause, valueWithApostrophe) {
  const literal = `'${valueWithApostrophe.replaceAll("'", "''")}'`;
  return clause.includes(literal) && !clause.includes(`\\'`);
}

test("SODA_WHERE escapes MOCS apostrophe with SoQL doubling (not backslash)", () => {
  // Regression: unescaped / backslash-escaped ' in Mayor's broke the entire OR query
  // (SODA query.compiler.malformed → empty franchise spine on the public surface).
  assert.match(SODA_WHERE, /agency_name='Mayor''s Office of Contract Services'/);
  assert.equal(SODA_WHERE.includes("\\'"), false, "SoQL does not use backslash escapes");
  assert.equal(
    soqlClauseEscapesApostrophe(SODA_WHERE, "Mayor's Office of Contract Services"),
    true,
  );
  // Keep the MOCS clause — do not drop it to "fix" the query.
  assert.match(SODA_WHERE, /Mayor''s Office of Contract Services/);
  assert.match(SODA_WHERE, /Franchise and Concession Review Committee/);
  assert.match(SODA_WHERE, /%FCRC%/);
});

test("broken SoQL apostrophe escape is distinguishable from the fixed clause", () => {
  const broken = "agency_name='Mayor\\'s Office of Contract Services'";
  const fixed = "agency_name='Mayor''s Office of Contract Services'";
  // The historical bug: JS produced Mayor\'s (backslash + quote) in the $where string.
  assert.equal(broken.includes("\\'"), true);
  assert.equal(broken.includes("Mayor''s"), false);
  assert.equal(fixed.includes("Mayor''s"), true);
  assert.equal(fixed.includes("\\'"), false);
  // Product query must match the fixed shape, not the broken one.
  assert.ok(SODA_WHERE.includes(fixed));
  assert.ok(!SODA_WHERE.includes(broken));
});

test("FRANCHISE_CONCESSION_STAGES is solicitation → public_hearing → committee_meeting → award", () => {
  assert.deepEqual([...FRANCHISE_CONCESSION_STAGES], [
    "solicitation",
    "public_hearing",
    "committee_meeting",
    "award",
  ]);
});

test("eligibility includes FCRC and item franchise hearings; excludes Council zoning-franchises", () => {
  const oneChronos = fixture.notices.find((n) => n.request_id === "20251007003");
  const calendar = fixture.notices.find((n) => n.request_id === "20260710032");
  const council = fixture.notices.find((n) => n.request_id === "council-zoning-franchises");
  assert.equal(isFranchiseConcessionEligible(oneChronos), true);
  assert.equal(isFranchiseConcessionEligible(calendar), true);
  assert.equal(isFranchiseConcessionEligible(council), false);
  assert.equal(classifyFranchiseConcessionStage(council), null);
});

test("classifyFranchiseConcessionStage maps notice types without inventing stages", () => {
  assert.equal(
    classifyFranchiseConcessionStage(
      fixture.notices.find((n) => n.request_id === "full-chain-solicitation"),
    ),
    STAGE_SOLICITATION,
  );
  assert.equal(
    classifyFranchiseConcessionStage(
      fixture.notices.find((n) => n.request_id === "20251007003"),
    ),
    STAGE_PUBLIC_HEARING,
  );
  assert.equal(
    classifyFranchiseConcessionStage(
      fixture.notices.find((n) => n.request_id === "full-chain-meeting"),
    ),
    STAGE_COMMITTEE_MEETING,
  );
  assert.equal(
    classifyFranchiseConcessionStage(
      fixture.notices.find((n) => n.request_id === "full-chain-award"),
    ),
    STAGE_AWARD,
  );
  assert.equal(
    classifyFranchiseConcessionStage(
      fixture.notices.find((n) => n.request_id === "20251020016"),
    ),
    STAGE_AWARD,
  );
});

test("join keys prefer party stem, plan year, and rules subject", () => {
  const hearing = fixture.notices.find((n) => n.request_id === "20251007003");
  const parties = extractCounterparties(hearing);
  assert.ok(parties.some((p) => /onechronos/i.test(p)));
  const keys = franchiseConcessionJoinKeys(hearing);
  assert.ok(keys.some((k) => k.startsWith("party:") && k.includes("onechronos")));

  const plan = fixture.notices.find((n) => n.request_id === "20260512008");
  assert.ok(franchiseConcessionJoinKeys(plan).includes("plan:fy2027"));

  const rules = fixture.notices.find((n) => n.request_id === "20251020016");
  assert.ok(franchiseConcessionJoinKeys(rules).includes("rules:fcrc"));

  const calendar = fixture.notices.find((n) => n.request_id === "20260710032");
  assert.deepEqual(franchiseConcessionJoinKeys(calendar), []);
});

test("field case: full four-stage party chain is one full spine", () => {
  const chain = fixture.notices.filter((n) =>
    [
      "full-chain-solicitation",
      "20251007003",
      "full-chain-meeting",
      "full-chain-award",
    ].includes(n.request_id),
  );
  const spine = buildFranchiseConcessionSpine(chain);

  assert.equal(spine.schema_version, 1);
  assert.match(spine.subject_ref, /^franchise:party:onechronos/);
  assert.equal(spine.join.method, "exact_party");
  assert.equal(spine.full, true);
  assert.equal(spine.stage_fill, 1);
  assert.deepEqual(
    spine.stages.map((s) => [s.kind, s.matched]),
    [
      ["solicitation", true],
      ["public_hearing", true],
      ["committee_meeting", true],
      ["award", true],
    ],
  );
  assert.equal(spine.gaps.length, 0);
  assert.ok(spine.events.every((e) => e.source?.url && e.time?.precision === "day"));
  assert.ok(
    spine.gaps.every((g) => g.class !== "not_published"),
    "must not invent false not_published gaps",
  );
});

test("field case: annual plan hearing is plan-keyed with honest empty later stages", () => {
  const plan = fixture.notices.find((n) => n.request_id === "20260512008");
  const spine = buildFranchiseConcessionSpine([plan]);
  assert.equal(spine.subject_ref, "franchise:plan:fy2027");
  assert.equal(spine.join.method, "exact_plan_year");
  assert.equal(spine.stages.find((s) => s.kind === STAGE_PUBLIC_HEARING).matched, true);
  assert.equal(spine.full, false);
  assert.ok(spine.gaps.every((g) => g.class === "not_yet_ingested" && g.source === "City Record Online"));
  assert.deepEqual(
    spine.gaps.map((g) => g.slot),
    [STAGE_SOLICITATION, STAGE_COMMITTEE_MEETING, STAGE_AWARD],
  );
});

test("groupFranchiseConcessionSpines joins party chains and keeps calendar/singleton separate", () => {
  const spines = groupFranchiseConcessionSpines(fixture.notices);
  const full = spineForNotice(spines, "20251007003");
  assert.ok(full);
  assert.equal(full.full, true);
  assert.equal(full.join.notice_count, 4);
  assert.ok(full.stages.some((st) => (st.request_ids || []).includes("full-chain-award")));

  // Other party must not merge into OneChronos chain.
  const other = spineForNotice(spines, "cross-party-other");
  assert.ok(other);
  assert.notEqual(other.subject_ref, full.subject_ref);
  assert.equal(other.join.notice_count, 1);

  // Calendar meeting without item keys is a singleton.
  const calendar = spineForNotice(spines, "20260710032");
  assert.ok(calendar);
  assert.equal(calendar.join.method, "single_notice");
  assert.equal(calendar.subject_ref, "notice:20260710032");
  assert.equal(calendar.stages.find((s) => s.kind === STAGE_COMMITTEE_MEETING).matched, true);

  // Council zoning-franchises never appears.
  assert.equal(spineForNotice(spines, "council-zoning-franchises"), null);
});

test("single-notice spine is honest: one matched stage, no invented awards", () => {
  const row = fixture.notices.find((n) => n.request_id === "20260710032");
  const spine = buildFranchiseConcessionSpine([row]);
  assert.equal(spine.matched_stages, 1);
  assert.equal(spine.full, false);
  assert.ok(!spine.stages.some((s) => s.matched && s.kind === STAGE_AWARD));
  assert.ok(spine.gaps.every((g) => g.class === "not_yet_ingested"));
});

test("measureFranchiseConcessionSpineCompleteness moves with fill", () => {
  const empty = measureFranchiseConcessionSpineCompleteness([]);
  assert.equal(empty.metric, "franchise_concession_spine_completeness_rate");
  assert.equal(empty.franchise_concession_spine_completeness_rate, 0);

  const spines = groupFranchiseConcessionSpines(fixture.notices);
  const metrics = measureFranchiseConcessionSpineCompleteness(spines);
  assert.ok(metrics.spine_count >= 3);
  assert.ok(metrics.multi_notice_spine_count >= 1);
  assert.ok(metrics.franchise_concession_spine_completeness_rate > 0);
  assert.ok(metrics.franchise_concession_spine_completeness_rate <= 1);
  assert.ok(metrics.full_spine_rate > 0);
  assert.ok(metrics.stage_rates.public_hearing >= 0);
});

test("attachFranchiseConcessionSpines stamps the view without inventing counterparties", () => {
  const view = attachFranchiseConcessionSpines({
    schema_version: 1,
    notices: fixture.notices,
  });
  assert.ok(Array.isArray(view.franchise_spines));
  assert.ok(view.franchise_spines.length >= 3);
  assert.equal(
    view.franchise_metrics.metric,
    "franchise_concession_spine_completeness_rate",
  );
  const stamped = view.notices.find((p) => p.request_id === "20251007003");
  assert.equal(stamped.franchise_stage, STAGE_PUBLIC_HEARING);
  assert.match(stamped.franchise_subject_ref, /^franchise:party:onechronos/);
  assert.ok(stamped.franchise_join_keys.some((k) => k.startsWith("party:")));
});

test("public notice detail mounts the franchise spine UI chrome", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /function franchiseConcessionSpineHTML/);
  assert.match(index, /loadFranchiseConcessionSpine/);
  assert.match(index, /franchise_spines/);
  assert.match(index, /franchise_stage_solicitation/);
  assert.match(index, /franchise_stage_public_hearing/);
  assert.match(index, /franchise_stage_committee_meeting/);
  assert.match(index, /franchise_stage_award/);
  assert.match(index, /nfranchise/);
  // Phase-group surface (stepper + lead action) — not flat-only chain.
  assert.match(index, /franchise_phase_spine|buildFranchisePhaseView/);
  assert.match(index, /franchise-phase-stepper/);
  assert.match(index, /franchise_phase_now_html/);
  assert.match(index, /franchise_phase_action_solicitation/);
});

test("mapFranchiseConcessionSpineToCivic emits registered franchise kinds", async () => {
  const chain = fixture.notices.filter((n) =>
    ["full-chain-solicitation", "20251007003", "full-chain-meeting", "full-chain-award"].includes(
      n.request_id,
    ),
  );
  const spine = buildFranchiseConcessionSpine(chain);
  const { mapFranchiseConcessionSpineToCivic, isRegisteredEventKind } = await import(
    "../worker/src/lib/civic_time.mjs"
  );
  const civic = mapFranchiseConcessionSpineToCivic(spine, { run_id: "test" });
  assert.ok(civic.length >= 4);
  for (const ev of civic) {
    assert.equal(isRegisteredEventKind(ev.event_kind), true);
  }
  assert.ok(civic.some((ev) => ev.event_kind === "franchise.public_hearing"));
  assert.ok(civic.some((ev) => ev.event_kind === "franchise.committee_meeting"));
  assert.ok(civic.some((ev) => ev.event_kind === "franchise.award"));
});
