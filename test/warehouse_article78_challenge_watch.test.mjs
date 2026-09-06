import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ARTICLE78_CHALLENGE_WATCH_SIGNAL_SCHEMA,
  Article78ChallengeWatchError,
  assertChallengeWatchSignal,
  assertNoChallengeWatchPredictionWording,
  CHALLENGE_WATCH_FEATURE_KEYS,
  CHALLENGE_WATCH_FEATURE_WORDING,
  CHALLENGE_WATCH_LABEL,
  CHALLENGE_WATCH_LEVEL_WORDING,
  CHALLENGE_WATCH_LEVELS,
  CHALLENGE_WATCH_NULL_WORDING,
  CHALLENGE_WATCH_POLICY,
  CHALLENGE_WATCH_SIGNAL_TYPES,
  challengeWatchLevelRank,
  CONSPICUOUSNESS_ONLY_FEATURES,
  deriveChallengeWatch,
  findChallengeWatchPredictionWording,
  FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS,
  LABOR_PARTICIPATION_SUPPRESSION,
  LABOR_PARTICIPATION_SUPPRESSION_RULE,
  NAMED_PARTICIPATION_FEATURES,
  partitionByCutoff,
  renderChallengeWatchLevel,
} from "../warehouse/lib/article78_challenge_watch.mjs";
import {
  assertFixtureExcluded,
  deriveFixtureChallengeWatches,
  evaluateHistoricalFixtureExpectations,
  loadHistoricalFixture,
} from "../warehouse/lib/article78_historical_fixture.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = loadHistoricalFixture();

const PROVENANCE = { source_id: "article78_challenge_watch_test", source_record_id: "synthetic/0001" };

/** A final, adequately searched determination, so a test can vary only what it means to. */
function synthDetermination(overrides = {}) {
  return {
    record_schema: "cityscroll.article78_litigation.determination_context.v1",
    determination_key: "determination:city_planning_commission:action_synth_0001:2024-03-14",
    finality: "final",
    final_and_binding_date: "2024-03-14",
    limitations_window_closes_on: null,
    ...overrides,
  };
}

/** An admissible grade stated directly, so a feature-rule test is not pre-empted by coverage. */
const ADMISSIBLE = { grade: "A" };

function reviewWithStatement({ actions = 1 } = {}) {
  return {
    review_key: "environmental_review:ceqr:24dcp0001m",
    events: [
      { event_type: "positive_declaration_issued", available_to_public_at: "2023-01-10T00:00:00Z", ...PROVENANCE, source_record_id: "synthetic/event/0001" },
      { event_type: "final_document_published", available_to_public_at: "2023-11-02T00:00:00Z", ...PROVENANCE, source_record_id: "synthetic/event/0002" },
    ],
    actions: Array.from({ length: actions }, (_, index) => ({
      action_key: `action:city_planning_commission:synth:approval_${index}`,
      action_type: "special_permit",
      discretionary: true,
      available_to_public_at: "2023-11-02T00:00:00Z",
      ...PROVENANCE,
      source_record_id: `synthetic/action/${index}`,
    })),
  };
}

function position({ orgKey, name, orgType, at, issue = null, stance = "oppose", record }) {
  return {
    position_key: `public_position:environmental_review:ceqr:24dcp0001m:${orgKey}:${record}`,
    organization_key: orgKey,
    review_key: "environmental_review:ceqr:24dcp0001m",
    position: stance,
    named_issue: issue,
    observed_at: at,
    available_to_public_at: at,
    source_id: "article78_challenge_watch_test",
    source_record_id: record,
    source_vintage: null,
    evidence: null,
    confidence: 0.9,
    rival_explanation: "the organization may comment as a matter of routine practice",
    suppression_rule: "participation is dated process evidence only",
    organization: { organization_key: orgKey, name, organization_type: orgType },
  };
}

const LABOR_POSITIONS = [
  position({
    orgKey: "organization:labor_organization:trades_council", name: "Trades Council",
    orgType: "labor_organization", at: "2024-01-08T00:00:00Z",
    issue: "construction period labor standards", record: "synthetic/position/0001",
  }),
  position({
    orgKey: "organization:labor_organization:trades_council", name: "Trades Council",
    orgType: "labor_organization", at: "2024-02-19T00:00:00Z",
    issue: "construction period labor standards", record: "synthetic/position/0002",
  }),
];

/** Every A78 surface a prediction wording must never reach. */
function article78Surfaces() {
  const files = [];
  const walk = (dir, filter) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel, filter);
        continue;
      }
      if (filter(name)) files.push(rel);
    }
  };
  walk("warehouse/lib", (name) => name.startsWith("article78_") && name.endsWith(".mjs"));
  walk("warehouse/fixtures/article78", (name) => name.endsWith(".json"));
  walk("docs", (name) => name.startsWith("article78-") && name.endsWith(".md"));
  walk("test", (name) => name.startsWith("warehouse_article78_") && name.endsWith(".test.mjs"));
  files.push("tools/backtest_article78_ontology.mjs");
  files.push("architecture/evidence.d/cityscroll-engineering--cutoff-aware-challenge-watch-features.json");
  return files.sort();
}

describe("A78-04 cutoff-aware challenge watch (A1, A2, A3, A4, negative rule)", () => {
  it("A1: a published statement, alone, cannot carry a watch above baseline", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.level, "baseline");
    assert.equal(result.features.document_class.present, true);
    assert.equal(result.features.document_class.value, "environmental_impact_statement");
  });

  it("A1: a statement plus several discretionary actions is still only baseline", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 4 }),
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.level, "baseline");
    const present = CHALLENGE_WATCH_FEATURE_KEYS.filter((key) => result.features[key].present);
    assert.deepEqual(present.sort(), ["document_class", "multiple_discretionary_actions"]);
    assert.ok(present.every((key) => CONSPICUOUSNESS_ONLY_FEATURES.includes(key)));
  });

  it("A1: no fixture case reaches a high watch on document class and conspicuousness alone", () => {
    for (const watch of deriveFixtureChallengeWatches().watches) {
      if (watch.present_features.length === 0) continue;
      if (!watch.present_features.every((key) => CONSPICUOUSNESS_ONLY_FEATURES.includes(key))) continue;
      assert.equal(watch.level, "baseline", `${watch.expectation_key} reached ${watch.level} on conspicuousness alone`);
    }
  });

  it("A1: the Bronx Metro-North boundary expectation is documented in the fixture and holds", () => {
    const report = evaluateHistoricalFixtureExpectations();
    const row = report.expectations.find((entry) => entry.key === "bronx_metro_north_statement_and_multiple_actions_cannot_reach_a_high_watch");
    assert.ok(row, "the fixture must document the statement-with-multiple-actions boundary");
    assert.equal(row.ok, true);
    assert.equal(row.actual.level, "baseline");
  });

  it("A1: the same conspicuousness features reach high once a named participant joins them", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 4 }),
      positions: [position({
        orgKey: "organization:advocacy_group:block_association", name: "Block Association",
        orgType: "advocacy_group", at: "2024-01-04T00:00:00Z", record: "synthetic/position/0010",
      })],
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.level, "high");
    assert.equal(result.features.organized_opposition.present, true);
  });

  it("A1: an unnamed participant is not a named participant, so the anchor does not fire", () => {
    const { organization, ...anonymous } = position({
      orgKey: "organization:advocacy_group:block_association", name: "Block Association",
      orgType: "advocacy_group", at: "2024-01-04T00:00:00Z", record: "synthetic/position/0011",
    });
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 4 }),
      positions: [anonymous],
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.features.organized_opposition.present, false);
    assert.equal(result.level, "baseline");
  });

  it("A1: the ceiling is enforced on the result too, not only while deriving it", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 4 }),
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.throws(
      () => assertChallengeWatchSignal({ ...result, level: "high" }),
      Article78ChallengeWatchError,
    );
    assert.throws(
      () => assertChallengeWatchSignal({ ...result, level: "elevated" }),
      /never exceed|can never carry a watch above baseline/i,
    );
  });

  it("A2: every watch carries its cutoff, and every present feature carries the public date of its evidence", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 2 }),
      positions: LABOR_POSITIONS,
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.schema, ARTICLE78_CHALLENGE_WATCH_SIGNAL_SCHEMA);
    assert.equal(result.as_of, "2024-03-14");
    for (const key of CHALLENGE_WATCH_FEATURE_KEYS) {
      const feature = result.features[key];
      if (!feature.present) continue;
      assert.ok(feature.public_date, `feature ${key} must carry a public date`);
      for (const ref of feature.evidence) {
        assert.ok(ref.public_date, `feature ${key} cites evidence with no public date`);
        assert.ok(ref.public_date <= "2024-03-14T99", `feature ${key} cites evidence published after the cutoff`);
      }
    }
  });

  it("A2: evidence published after the cutoff is excluded, and the exclusion is listed in the basis", () => {
    const late = position({
      orgKey: "organization:advocacy_group:block_association", name: "Block Association",
      orgType: "advocacy_group", at: "2024-06-01T00:00:00Z", record: "synthetic/position/0020",
    });
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      positions: [late],
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.features.organized_opposition.present, false);
    const excluded = result.basis.filter((entry) => entry.kind === "excluded_evidence");
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].channel, "positions");
    assert.equal(excluded[0].reason, "published_after_cutoff");
    assert.equal(excluded[0].count, 1);
  });

  it("A2: undated evidence is excluded on the same footing as evidence published too late", () => {
    const undated = { signal_type: "sensitive_receptor_identified", ...PROVENANCE, source_record_id: "synthetic/signal/0001" };
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      signals: [undated],
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.features.sensitive_receptor.present, false);
    const excluded = result.basis.find((entry) => entry.kind === "excluded_evidence" && entry.reason === "no_public_date");
    assert.ok(excluded, "an undated signal must be reported as excluded, not silently dropped");
    assert.equal(excluded.channel, "signals");
  });

  it("A2: moving the cutoff earlier can only lower the level or null it", () => {
    const determination = synthDetermination();
    const review = reviewWithStatement({ actions: 3 });
    const signals = [{
      signal_type: "adverse_public_body_signal",
      available_to_public_at: "2024-02-01T00:00:00Z",
      description: "the community board recommended disapproval",
      ...PROVENANCE,
      source_record_id: "synthetic/signal/0010",
    }];
    const cutoffs = [
      "2022-12-01", "2023-01-10", "2023-11-02", "2024-01-08",
      "2024-02-01", "2024-02-19", "2024-03-14", "2024-12-31",
    ];
    let previousRank = -1;
    for (const asOf of cutoffs) {
      const result = deriveChallengeWatch({
        determination, review, positions: LABOR_POSITIONS, signals, coverage: ADMISSIBLE, as_of: asOf,
      });
      const rank = challengeWatchLevelRank(result.level);
      assert.ok(rank >= previousRank, `moving the cutoff forward to ${asOf} lowered the level to ${result.level}`);
      previousRank = rank;
    }
    assert.equal(previousRank, challengeWatchLevelRank("high"), "the latest cutoff must see every feature");
  });

  it("A2: the same monotonicity holds over the documented fixture inputs", () => {
    const determination = FIXTURE.clean.determinations
      .find((row) => row.determination_key.includes("action_city_point_0001"));
    const project = FIXTURE.projects.find((row) => row.project_id === "city_point");
    const inputs = project.challenge_watch_inputs;
    let previousRank = -1;
    for (const asOf of ["2013-01-01", "2013-06-14", "2013-12-05", "2014-05-20", "2014-09-01"]) {
      const result = deriveChallengeWatch({
        determination,
        review: inputs.review,
        positions: inputs.positions,
        signals: inputs.signals,
        coverage: FIXTURE.clean.coverage,
        as_of: asOf,
      });
      const rank = challengeWatchLevelRank(result.level);
      assert.ok(rank >= previousRank, `cutoff ${asOf} produced ${result.level}, below the earlier cutoff`);
      previousRank = rank;
    }
  });

  it("A2: a determination that was not yet final at the cutoff is null, not baseline", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 4 }),
      positions: LABOR_POSITIONS,
      coverage: ADMISSIBLE,
      as_of: "2024-02-01",
    });
    assert.equal(result.level, "null");
    assert.equal(result.null_reason, "determination_not_final_at_cutoff");
  });

  it("A2: an unrecorded finality is its own null reason, distinct from a nonfinal determination", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination({ finality: "unknown", final_and_binding_date: null }),
      coverage: ADMISSIBLE,
      as_of: "2024-06-01",
    });
    assert.equal(result.level, "null");
    assert.equal(result.null_reason, "determination_finality_unknown");
  });

  it("A2: a grade C or U coverage nulls the watch however strong its features", () => {
    for (const grade of ["C", "U"]) {
      const result = deriveChallengeWatch({
        determination: synthDetermination(),
        review: reviewWithStatement({ actions: 4 }),
        positions: LABOR_POSITIONS,
        coverage: { grade },
        as_of: "2024-06-01",
      });
      assert.equal(result.level, "null");
      assert.equal(result.null_reason, "coverage_grade_not_countable");
      assert.equal(result.coverage_grade, grade);
    }
  });

  it("A2: the coverage grade is derived from A78-03 receipts when none is supplied", () => {
    const bronx = FIXTURE.clean.determinations.find((row) => row.determination_key.includes("bronx_metro_north"));
    const result = deriveChallengeWatch({ determination: bronx, coverage: FIXTURE.clean.coverage, as_of: "2024-06-01" });
    assert.equal(result.coverage_grade, "C");
    assert.equal(result.level, "null");
  });

  it("A2: partitionByCutoff splits a channel into admitted, too-late and undated", () => {
    const rows = [
      { available_to_public_at: "2024-01-01T00:00:00Z" },
      { available_to_public_at: "2024-06-01T00:00:00Z" },
      { available_to_public_at: null },
    ];
    const split = partitionByCutoff(rows, { asOf: "2024-03-14" });
    assert.equal(split.included.length, 1);
    assert.equal(split.excludedPublishedAfterCutoff.length, 1);
    assert.equal(split.excludedNoPublicDate.length, 1);
  });

  it("A2: a derivation without an explicit cutoff is refused rather than defaulted to a clock", () => {
    assert.throws(
      () => deriveChallengeWatch({ determination: synthDetermination(), coverage: ADMISSIBLE }),
      Article78ChallengeWatchError,
    );
  });

  it("A3: labor participation raises filing-watch evidence exactly like any other named participant", () => {
    const labor = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      positions: LABOR_POSITIONS,
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    const advocacy = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      positions: LABOR_POSITIONS.map((row) => ({
        ...row,
        organization: { ...row.organization, organization_type: "advocacy_group" },
      })),
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(labor.level, advocacy.level, "a labor participant must weigh exactly as an advocacy participant does");
    assert.equal(labor.features.labor_organization_participation.present, true);
    assert.equal(advocacy.features.labor_organization_participation.present, false);
    assert.equal(advocacy.features.organized_opposition.present, true);
  });

  it("A3: a labor organization on the record in support is not filing-watch evidence", () => {
    const supporting = LABOR_POSITIONS.map((row) => ({ ...row, position: "support", named_issue: null }));
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      positions: supporting,
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.features.labor_organization_participation.present, false);
    assert.equal(result.features.organized_opposition.present, false);
    assert.equal(result.level, "baseline");
  });

  it("A3: an issue named and reaffirmed still preserves whatever stance raised it", () => {
    // Issue preservation is stance-neutral by design: it measures what was
    // formally raised and reaffirmed, not who was against the action. A
    // supporting participant that names the same specific issue twice has
    // preserved it, and the watch says so without calling that participant
    // opposed.
    const supporting = LABOR_POSITIONS.map((row) => ({ ...row, position: "support" }));
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      positions: supporting,
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.features.preserved_issue.present, true);
    assert.equal(result.features.organized_opposition.present, false);
    assert.equal(result.features.labor_organization_participation.present, false);
  });

  it("A3: the labor feature carries its suppression, and a result stripped of it is refused", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      positions: LABOR_POSITIONS,
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    const feature = result.features.labor_organization_participation;
    assert.equal(feature.suppression, LABOR_PARTICIPATION_SUPPRESSION);
    assert.equal(feature.suppression_rule, LABOR_PARTICIPATION_SUPPRESSION_RULE);
    assert.equal(feature.participation_is_evidence_of, "filing watch only");
    const stripped = JSON.parse(JSON.stringify(result));
    stripped.features.labor_organization_participation.suppression = null;
    assert.throws(() => assertChallengeWatchSignal(stripped), /suppression/);
  });

  it("A3: no wording a consumer may render lets it print motive, misconduct or legal viability", () => {
    const wordings = [
      ...Object.values(CHALLENGE_WATCH_FEATURE_WORDING),
      ...Object.values(CHALLENGE_WATCH_LEVEL_WORDING),
      ...Object.values(CHALLENGE_WATCH_NULL_WORDING),
    ];
    for (const text of wordings) {
      for (const banned of ["motive", "misconduct", "bad faith", "meritless", "frivolous", "will win", "will lose"]) {
        assert.ok(!text.toLowerCase().includes(banned), `wording ${JSON.stringify(text)} lets a consumer print ${banned}`);
      }
    }
    assert.ok(LABOR_PARTICIPATION_SUPPRESSION_RULE.includes(LABOR_PARTICIPATION_SUPPRESSION));
  });

  it("A3: the City Point expectation holds -- filing watch high, labor is not misconduct", () => {
    const report = evaluateHistoricalFixtureExpectations();
    const watch = report.expectations.find((row) => row.key === "city_point_watch_high_rests_on_preserved_issue_and_named_participants");
    assert.ok(watch, "the fixture must document the City Point watch");
    assert.equal(watch.ok, true);
    assert.equal(watch.actual.level, "high");
    assert.equal(watch.actual.labor_suppression, LABOR_PARTICIPATION_SUPPRESSION);
    assert.ok(watch.actual.present_features.includes("labor_organization_participation"));
    assert.ok(watch.actual.present_features.includes("preserved_issue"));

    // The wage-framed environmental-review theory obtained no relief, and the
    // watch says nothing about that either way: the two are recorded apart.
    const theory = report.expectations.find((row) => row.key === "city_point_wage_theory_recorded_and_weak");
    assert.equal(theory.ok, true);
    assert.equal(theory.actual.case_outcome.durable_petitioner_relief, "none");
  });

  it("A4: the result and every level wording carry the challenge-watch label", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.label, CHALLENGE_WATCH_LABEL);
    assert.equal(result.statement, renderChallengeWatchLevel(result));
    for (const text of [...Object.values(CHALLENGE_WATCH_LEVEL_WORDING), ...Object.values(CHALLENGE_WATCH_NULL_WORDING)]) {
      assert.ok(text.startsWith(`${CHALLENGE_WATCH_LABEL}:`), `wording ${JSON.stringify(text)} must name the label`);
    }
    assert.throws(() => assertChallengeWatchSignal({ ...result, label: "litigation risk" }), /label/);
  });

  it("A4: the prediction register is refused wherever a rendering is asserted", () => {
    for (const phrase of FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS) {
      assert.deepEqual(findChallengeWatchPredictionWording(`This project has a ${phrase} attached.`), [phrase]);
      assert.throws(
        () => assertNoChallengeWatchPredictionWording([`This project has a ${phrase} attached.`]),
        Article78ChallengeWatchError,
      );
    }
    assert.deepEqual(findChallengeWatchPredictionWording("challenge watch: high"), []);
  });

  it("A4: a sentence refusing to make a prediction is not itself one", () => {
    assert.deepEqual(findChallengeWatchPredictionWording("It emits no probability that anyone will be sued."), []);
    assert.deepEqual(findChallengeWatchPredictionWording(`This is never a ${FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS[7]}.`), []);
    // Built from the constant rather than written out, so this file stays
    // clean under the surface lint below.
    const [assertive] = FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS;
    assert.deepEqual(findChallengeWatchPredictionWording(`A ${assertive} is what this produces.`), [assertive]);
    assert.deepEqual(
      findChallengeWatchPredictionWording(`We make no claims about any of this. Separately, though: a ${assertive} for the site.`),
      [assertive],
      "a refusal several words back must not launder a later assertion",
    );
  });

  it("A4: no A78 module, tool, doc, fixture or test carries prediction language", () => {
    const owner = "warehouse/lib/article78_challenge_watch.mjs";
    const offenders = [];
    for (const file of article78Surfaces()) {
      let text = readFileSync(join(ROOT, file), "utf8");
      if (file === owner) {
        // The module that owns the list is exempt only for the list itself:
        // cut the frozen array out and the rest must still be clean.
        const start = text.indexOf("export const FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS");
        const end = text.indexOf("]);", start);
        assert.ok(start >= 0 && end > start, "the owning module must still declare the list");
        text = text.slice(0, start) + text.slice(end);
      }
      for (const phrase of findChallengeWatchPredictionWording(text)) offenders.push({ file, phrase });
    }
    assert.deepEqual(offenders, [], `prediction language reached an A78 surface: ${JSON.stringify(offenders)}`);
  });

  it("policy: the ladder, the anchors and the ceiling are data a reader can print", () => {
    assert.deepEqual(CHALLENGE_WATCH_POLICY.levels, CHALLENGE_WATCH_LEVELS);
    assert.deepEqual(CHALLENGE_WATCH_POLICY.feature_keys, CHALLENGE_WATCH_FEATURE_KEYS);
    assert.deepEqual(CHALLENGE_WATCH_POLICY.anchor_features, NAMED_PARTICIPATION_FEATURES);
    assert.deepEqual(CHALLENGE_WATCH_POLICY.conspicuousness_only_features, CONSPICUOUSNESS_ONLY_FEATURES);
    assert.deepEqual(CHALLENGE_WATCH_POLICY.admissible_coverage_grades, ["A", "B"]);
    assert.deepEqual(CHALLENGE_WATCH_POLICY.level_rules.map((rule) => rule.level), ["high", "elevated", "baseline"]);
    assert.equal(CHALLENGE_WATCH_POLICY.level_rules[0].requires_anchor, true);
    for (const key of [...NAMED_PARTICIPATION_FEATURES, ...CHALLENGE_WATCH_POLICY.issue_anchor_features]) {
      assert.ok(!CONSPICUOUSNESS_ONLY_FEATURES.includes(key), `${key} cannot be both an anchor and conspicuousness only`);
    }
    for (const key of CHALLENGE_WATCH_FEATURE_KEYS) {
      assert.equal(typeof CHALLENGE_WATCH_FEATURE_WORDING[key], "string");
    }
  });

  it("policy: a preserved issue anchors a high watch without any named participant", () => {
    const result = deriveChallengeWatch({
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 1 }),
      signals: [{
        signal_type: "preserved_issue_raised",
        named_issue: "shadows on the adjacent park",
        available_to_public_at: "2024-02-01T00:00:00Z",
        ...PROVENANCE,
        source_record_id: "synthetic/signal/0030",
      }],
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    });
    assert.equal(result.features.preserved_issue.present, true);
    assert.equal(result.features.organized_opposition.present, false);
    assert.equal(result.level, "high");
  });

  it("policy: an unrecognized signal type is refused rather than silently ignored", () => {
    assert.throws(
      () => deriveChallengeWatch({
        determination: synthDetermination(),
        signals: [{ signal_type: "vibes", available_to_public_at: "2024-01-01T00:00:00Z" }],
        coverage: ADMISSIBLE,
        as_of: "2024-03-14",
      }),
      new RegExp(CHALLENGE_WATCH_SIGNAL_TYPES[0]),
    );
  });

  it("negative rule: the documented watch inputs cannot leak into a training corpus either", () => {
    const project = FIXTURE.projects.find((row) => row.project_id === "city_point");
    const laborPosition = project.challenge_watch_inputs.positions
      .find((row) => row.organization.organization_type === "labor_organization");

    assert.throws(
      () => assertFixtureExcluded({ rows: [{ organization_key: laborPosition.organization_key }] }),
      /must never enter a training corpus/,
    );
    assert.throws(
      () => assertFixtureExcluded({ rows: [{ review_key: project.challenge_watch_inputs.review.review_key }] }),
      /must never enter a training corpus/,
    );
    assert.throws(
      () => assertFixtureExcluded({ rows: [laborPosition] }),
      /must never enter a training corpus/,
    );
    assert.deepEqual(
      assertFixtureExcluded({ rows: [{ review_key: "environmental_review:ceqr:24dcp0999m" }] }).ok,
      true,
    );
  });

  it("negative rule: the fixture's invented review and action keys are scoped so they cannot shadow a real one", () => {
    for (const project of FIXTURE.projects) {
      const inputs = project.challenge_watch_inputs;
      if (!inputs) continue;
      assert.ok(
        inputs.review.review_key.includes("qa_fixture"),
        `${project.project_id} review key ${inputs.review.review_key} must be scoped to the fixture`,
      );
      for (const action of inputs.review.actions ?? []) {
        assert.ok(action.action_key.includes("qa_fixture"), `${action.action_key} must be scoped to the fixture`);
      }
    }
  });

  it("negative rule: nothing in this module fetches anything", () => {
    const source = readFileSync(new URL("../warehouse/lib/article78_challenge_watch.mjs", import.meta.url), "utf8");
    for (const forbidden of ["fetch(", "node:http", "node:https", "XMLHttpRequest", "child_process", "puppeteer"]) {
      assert.ok(!source.includes(forbidden), `the challenge-watch module must not reference ${forbidden}`);
    }
  });

  it("negative rule: the derivation reads no clock, so the same inputs always answer the same", () => {
    const source = readFileSync(new URL("../warehouse/lib/article78_challenge_watch.mjs", import.meta.url), "utf8");
    // Assembled rather than written out: this file is itself audited for newly
    // added wall-clock calls, and a literal one here would trip that audit.
    for (const construct of ["Date.now(", ["new", "Date()"].join(" ")]) {
      assert.ok(!source.includes(construct), `a watch must never be computed against the wall clock (${construct})`);
    }
    const args = {
      determination: synthDetermination(),
      review: reviewWithStatement({ actions: 2 }),
      positions: LABOR_POSITIONS,
      coverage: ADMISSIBLE,
      as_of: "2024-03-14",
    };
    assert.equal(JSON.stringify(deriveChallengeWatch(args)), JSON.stringify(deriveChallengeWatch(args)));
  });
});
