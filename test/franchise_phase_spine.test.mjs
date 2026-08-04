import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Franchise / concession phase presentation (compact stepper + current/next).
 *
 *   node --test test/franchise_phase_spine.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FRANCHISE_PHASES,
  buildFranchisePhaseView,
  franchiseStageToPhase,
  aggregatePhaseEvents,
  dedupePhaseSourceLinks,
} from "../site/franchise_phase_spine.mjs";
import {
  buildFranchiseConcessionSpine,
  groupFranchiseConcessionSpines,
  FRANCHISE_CONCESSION_STAGES,
} from "../worker/src/lib/franchise_concession_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/franchise_concession/field_cases.json"), "utf8"),
);

test("FRANCHISE_PHASES matches process stage order 1:1", () => {
  assert.deepEqual([...FRANCHISE_PHASES], [...FRANCHISE_CONCESSION_STAGES]);
  assert.equal(franchiseStageToPhase("public_hearing"), "public_hearing");
  assert.equal(franchiseStageToPhase("nope"), null);
});

test("buildFranchisePhaseView marks current as last matched and next as first unmatched after", () => {
  const chain = fixture.notices.filter((n) =>
    ["full-chain-solicitation", "20251007003", "full-chain-meeting", "full-chain-award"].includes(
      n.request_id,
    ),
  );
  const spine = buildFranchiseConcessionSpine(chain);
  const view = buildFranchisePhaseView(spine);
  assert.ok(view);
  assert.equal(view.phases.length, 4);
  assert.ok(view.current);
  assert.ok(view.action?.action_key);
  // Full chain ends on award.
  assert.equal(view.current.id, "award");
  assert.equal(view.current.matched, true);
  assert.equal(view.action.action_key, "franchise_phase_action_award");
  assert.equal(view.next, null);
  assert.equal(view.metrics.matched_count, 4);
});

test("partial spine: hearing matched, later stages future chips not gap cards", () => {
  const spine = buildFranchiseConcessionSpine([
    fixture.notices.find((n) => n.request_id === "20251007003"),
  ]);
  const view = buildFranchisePhaseView(spine);
  assert.equal(view.current.id, "public_hearing");
  assert.equal(view.action.action_key, "franchise_phase_action_public_hearing");
  assert.equal(view.phases.find((p) => p.id === "solicitation").matched, false);
  assert.equal(view.next?.id, "committee_meeting");
  // Unmatched future phases are present for the stepper; HTML collapses them to chips.
  assert.ok(view.phases.every((p) => p.id));
});

test("aggregatePhaseEvents collapses verbatim title repeats", () => {
  const groups = aggregatePhaseEvents([
    { title: "Same title", time: { value: "2025-10-01" }, request_id: "a" },
    { title: "Same title", time: { value: "2025-10-02" }, request_id: "b" },
    { title: "Other", time: { value: "2025-10-03" }, request_id: "c" },
  ]);
  assert.equal(groups.length, 2);
  const same = groups.find((g) => g.title === "Same title");
  assert.equal(same.count, 2);
  assert.equal(same.first, "2025-10-01");
  assert.equal(same.last, "2025-10-02");
});

test("dedupePhaseSourceLinks collapses identical URLs", () => {
  const out = dedupePhaseSourceLinks([
    { source: { url: "https://a856-cityrecord.nyc.gov/RequestDetail/1/" } },
    { source: { url: "https://a856-cityrecord.nyc.gov/RequestDetail/1" } },
    { source_url: "https://example.com/other" },
  ]);
  assert.equal(out.count, 2);
  assert.equal(out.candidates, 3);
  assert.ok(out.url);
});

test("group spines still feed a phase view", () => {
  const spines = groupFranchiseConcessionSpines(fixture.notices);
  assert.ok(spines.length >= 1);
  const multi = spines.find((s) => (s.join?.notice_count || 0) > 1) || spines[0];
  const view = buildFranchisePhaseView(multi);
  assert.ok(view);
  assert.equal(view.phases.length, 4);
  if (view.metrics.matched_count > 0) {
    assert.equal(view.current.matched, true);
  }
});

test("public notice detail uses franchise phase spine surface", () => {
  const index = SITE_SOURCE;
  assert.match(index, /buildFranchisePhaseView|franchise_phase_spine/);
  assert.match(index, /franchise-phase-stepper|franchise_phase_now_html/);
  assert.match(index, /function franchiseConcessionSpineHTML/);
  assert.match(index, /lifecycleNoticeEventsHTML\(p\.events\)/);
  assert.match(index, /href="#notice\/\$\{escUiHtml\(id\)\}"/);
  assert.match(index, /join_evidence_summary/);
  assert.doesNotMatch(index, /franchise_join_matched_html/);
});
