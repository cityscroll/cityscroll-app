/**
 * Characterization: non-Council hearing outcomes process spine
 * (notice_published → hearing → outcome → minutes).
 *
 * Field cases: BP hearing with both dates; CB directory landings; missing
 * event_date; Council excluded; outcome/minutes always class-(b) not_published
 * with real HTTPS where links (never invent votes).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NON_COUNCIL_HEARING_STAGES,
  STAGE_HEARING,
  STAGE_MINUTES,
  STAGE_NOTICE_PUBLISHED,
  STAGE_OUTCOME,
  buildNonCouncilHearingSpine,
  buildNonCouncilHearingSpines,
  isNonCouncilHearingEligible,
  measureNonCouncilHearingSpineCompleteness,
  nonCouncilBodyLinks,
  spineForNotice,
} from "../worker/src/lib/non_council_hearing_spine.mjs";
import { mapNonCouncilHearingSpineToCivic, isRegisteredEventKind } from "../worker/src/lib/civic_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/non_council_hearing/field_cases.json"), "utf8"),
);

function notice(id) {
  return fixture.notices.find((n) => n.request_id === id);
}

test("NON_COUNCIL_HEARING_STAGES is notice_published → hearing → outcome → minutes", () => {
  assert.deepEqual([...NON_COUNCIL_HEARING_STAGES], [
    "notice_published",
    "hearing",
    "outcome",
    "minutes",
  ]);
});

test("eligibility includes BP/CB hearings; excludes City Council", () => {
  assert.equal(isNonCouncilHearingEligible(notice("20260701001")), true);
  assert.equal(isNonCouncilHearingEligible(notice("20260515012")), true);
  assert.equal(isNonCouncilHearingEligible(notice("council-hearing-exclude")), false);
});

test("nonCouncilBodyLinks maps Manhattan BP + CB directory (HTTPS only)", () => {
  const links = nonCouncilBodyLinks(notice("20260701001"));
  assert.ok(links.some((l) => /manhattanbp\.nyc\.gov/i.test(l.url)));
  assert.ok(links.some((l) => /community-boards/i.test(l.url)));
  assert.ok(links.every((l) => /^https:\/\//.test(l.url)));
});

test("unmapped agency still gets BP home + CB directory (never text-only where)", () => {
  const links = nonCouncilBodyLinks(notice("20260515012"));
  assert.ok(links.length >= 2);
  assert.ok(links.every((l) => /^https:\/\//.test(l.url)));
  assert.ok(links.some((l) => /community-boards/i.test(l.url)));
});

test("field case: full fillable BP hearing stamps notice + hearing; outcome/minutes class-b", () => {
  const spine = buildNonCouncilHearingSpine(notice("20260701001"));
  assert.equal(spine.schema_version, 1);
  assert.match(spine.subject_ref, /^hearing:non_council:/);
  assert.equal(spine.join.method, "single_notice");
  assert.equal(spine.join.council, false);
  assert.equal(spine.full, false);

  const byKind = Object.fromEntries(spine.stages.map((s) => [s.kind, s]));
  assert.equal(byKind[STAGE_NOTICE_PUBLISHED].matched, true);
  assert.equal(byKind[STAGE_HEARING].matched, true);
  assert.equal(byKind[STAGE_OUTCOME].matched, false);
  assert.equal(byKind[STAGE_MINUTES].matched, false);
  assert.equal(byKind[STAGE_OUTCOME].gap_class, "not_published");
  assert.equal(byKind[STAGE_MINUTES].gap_class, "not_published");

  assert.equal(spine.fillable_rate, 1);
  assert.equal(spine.stage_fill, 0.5);

  const bGaps = spine.gaps.filter((g) => g.class === "not_published");
  assert.equal(bGaps.length, 2);
  assert.ok(bGaps.every((g) => Array.isArray(g.where_links) && g.where_links.length >= 1));
  assert.ok(
    bGaps[0].where_links.every((l) => /^https:\/\//.test(l.url)),
    "where links must be real HTTPS landings",
  );

  // Civic-time emits only matched fillable events (never invent outcome/minutes).
  const civic = mapNonCouncilHearingSpineToCivic(spine);
  assert.equal(civic.length, 2);
  assert.ok(civic.every((e) => isRegisteredEventKind(e.event_kind)));
  assert.ok(civic.some((e) => e.event_kind === "meetings.non_council_notice"));
  assert.ok(civic.some((e) => e.event_kind === "meetings.non_council_hearing"));
  assert.ok(!civic.some((e) => /outcome|minutes|vote/i.test(e.event_kind)));
});

test("missing event_date: hearing stage class-(a); outcome/minutes still class-(b)", () => {
  const spine = buildNonCouncilHearingSpine(notice("20260401099"));
  const byKind = Object.fromEntries(spine.stages.map((s) => [s.kind, s]));
  assert.equal(byKind[STAGE_NOTICE_PUBLISHED].matched, true);
  assert.equal(byKind[STAGE_HEARING].matched, false);
  assert.equal(byKind[STAGE_HEARING].gap_class, "not_yet_ingested");
  assert.equal(byKind[STAGE_OUTCOME].gap_class, "not_published");
  assert.ok(spine.gaps.some((g) => g.slot === STAGE_HEARING && g.class === "not_yet_ingested"));
  assert.ok(spine.gaps.some((g) => g.slot === STAGE_OUTCOME && g.class === "not_published"));
  assert.equal(spine.fillable_rate, 0.5);
});

test("buildNonCouncilHearingSpines skips Council and measures fillable completeness", () => {
  const spines = buildNonCouncilHearingSpines(fixture.notices);
  assert.equal(spines.length, 3);
  assert.equal(spineForNotice(spines, "council-hearing-exclude"), null);
  assert.ok(spineForNotice(spines, "20260701001"));

  const metrics = measureNonCouncilHearingSpineCompleteness(spines);
  assert.equal(metrics.metric, "non_council_hearing_spine_completeness_rate");
  assert.equal(metrics.spine_count, 3);
  assert.equal(metrics.full_spine_rate, 0);
  // Two full fillable (notice+hearing) + one half (notice only) → mean 0.833...
  assert.ok(metrics.non_council_hearing_spine_completeness_rate > 0.8);
  assert.ok(metrics.non_council_hearing_spine_completeness_rate < 0.9);
  assert.equal(metrics.stage_rates.outcome, 0);
  assert.equal(metrics.stage_rates.minutes, 0);
  assert.equal(metrics.structural_not_published_rate, 1);
});

test("site module is re-exported from worker path", async () => {
  const site = await import("../site/non_council_hearing_spine.mjs");
  assert.equal(typeof site.buildNonCouncilHearingSpine, "function");
  assert.deepEqual([...site.NON_COUNCIL_HEARING_STAGES], [...NON_COUNCIL_HEARING_STAGES]);
});
