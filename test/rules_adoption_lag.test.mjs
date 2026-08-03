/**
 * Characterization for rules adoption-lag predictions (cs-pred-05).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRulemakingGapObservations,
  fitAdoptionLagModel,
  emitAdoptionPrediction,
  adoptionLagPatternLine,
  adoptionLagGhostSegment,
  adoptionLagDigestItem,
  kaplanMeier,
  kmQuantile,
  empiricalQuantile,
  runAdoptionLagBacktest,
  cityRecordRowToRuleRecord,
  commentCloseAnchor,
  parseCommentCloseFromBody,
  MODEL_NAME,
  PREDICTED_EVENT_KIND,
  EARLY_SAMPLE,
} from "../worker/src/lib/rules_adoption_lag.mjs";
import {
  validatePrediction,
  predictionDeliveryTransition,
  predictionBand,
} from "../worker/src/lib/prediction_contract.mjs";
import {
  attachAdoptionLagEstimate,
  adoptionLagGhostFromModel,
} from "../site/rules_adoption_lag_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = join(ROOT, "warehouse/fixtures/city-record-agency-rules/sample.json");
const HISTORY = join(ROOT, "warehouse/fixtures/city-record-agency-rules/agency_rules_history.json");

const FIXTURE_ROWS = [
  {
    request_id: "20250101001",
    start_date: "2025-01-10",
    agency_name: "Transportation",
    type_of_notice_description: "Public Hearings",
    short_title: "DOT Proposed Rules Relating to Widget Safety",
    event_date: "2025-02-10",
    section_name: "Agency Rules",
  },
  {
    request_id: "20250301001",
    start_date: "2025-03-15",
    agency_name: "Transportation",
    type_of_notice_description: "Notice",
    short_title: "Notice of Adoption: Widget Safety",
    section_name: "Agency Rules",
  },
  {
    request_id: "20240101001",
    start_date: "2024-01-10",
    agency_name: "Transportation",
    type_of_notice_description: "Public Hearings",
    short_title: "DOT Proposed Rules Relating to Bicycle Racks",
    event_date: "2024-02-10",
    section_name: "Agency Rules",
  },
  {
    request_id: "20240301001",
    start_date: "2024-04-01",
    agency_name: "Transportation",
    type_of_notice_description: "Notice",
    short_title: "Notice of Adoption: Bicycle Racks",
    section_name: "Agency Rules",
  },
];

describe("rules adoption lag — anchors and stitch", () => {
  it("parses explicit comment-by dates from body text", () => {
    const day = parseCommentCloseFromBody(
      "Comments must be received by March 15, 2025 to be considered.",
    );
    assert.equal(day, "2025-03-15");
  });

  it("uses hearing event_date as comment-close when body has no date", () => {
    const rec = cityRecordRowToRuleRecord(FIXTURE_ROWS[0]);
    const anchor = commentCloseAnchor([rec]);
    assert.equal(anchor.day, "2025-02-10");
    assert.equal(anchor.basis, "hearing_event_date");
  });

  it("reconstructs gaps via sibling stitch on synthetic proposal+adoption", () => {
    const obs = buildRulemakingGapObservations(FIXTURE_ROWS, { cutoffDay: "2026-07-31" });
    assert.ok(obs.length >= 1);
    const withAdopt = obs.filter((o) => !o.censored);
    assert.ok(withAdopt.length >= 1);
    assert.ok(withAdopt.every((o) => o.gap_days >= 0));
  });
});

describe("rules adoption lag — KM and ECDF", () => {
  it("right-censors unfinished gaps so silence does not lower the median", () => {
    const rows = [
      { follow_up_days: 30, censored: false, gap_days: 30 },
      { follow_up_days: 40, censored: false, gap_days: 40 },
      { follow_up_days: 50, censored: false, gap_days: 50 },
      // long unfinished follow-up — must not count as a short event
      { follow_up_days: 20, censored: true, gap_days: null },
      { follow_up_days: 100, censored: true, gap_days: null },
    ];
    const km = kaplanMeier(rows);
    assert.equal(km.n_events, 3);
    assert.equal(km.n_censored, 2);
    const p50 = kmQuantile(km, 0.5);
    assert.ok(p50 != null && p50 >= 30);
  });

  it("empirical quantile is monotone", () => {
    const v = [10, 20, 30, 40, 50];
    assert.equal(empiricalQuantile(v, 0.5), 30);
    assert.ok(empiricalQuantile(v, 0.1) <= empiricalQuantile(v, 0.9));
  });
});

describe("rules adoption lag — prediction contract emission", () => {
  it("emits a valid cityscroll.prediction.v0 timing assertion", () => {
    // Build a train set large enough for complete quantiles.
    const train = [];
    for (let i = 0; i < 30; i++) {
      train.push({
        subject_ref: `rulemaking:dot:train-${i}`,
        agency: "DOT",
        comment_close: `2023-${String((i % 9) + 1).padStart(2, "0")}-01`,
        adoption: null,
        gap_days: 30 + i * 2,
        censored: false,
        follow_up_days: 30 + i * 2,
      });
      // set adoption day for uncensored
      train[i].adoption = null;
      train[i].censored = false;
    }
    // Use fit on synthetic observations shaped like buildRulemakingGapObservations output
    const synth = train.map((t, i) => ({
      ...t,
      comment_close: "2023-01-01",
      adoption: `2023-${String(((i % 6) + 2)).padStart(2, "0")}-15`,
      gap_days: 30 + i,
      follow_up_days: 30 + i,
      censored: false,
      comment_close_basis: "hearing_event_date",
      notice_ids: [`n${i}`],
      notice_count: 2,
    }));
    const model = fitAdoptionLagModel(synth, {
      trainFrom: "2023-01-01",
      trainTo: "2024-12-31",
    });
    assert.equal(model.model_name, MODEL_NAME);
    assert.ok(model.citywide.n >= EARLY_SAMPLE);

    const emitted = emitAdoptionPrediction(
      {
        subject_ref: "notice:20250101001",
        agency: "Transportation",
        comment_close: "2025-06-01",
        evidence_event_ids: ["cte:train:demo"],
      },
      model,
      {
        now: "2025-06-15",
        generatedAt: "2025-06-15T12:00:00.000Z",
        shipBarPassed: true,
      },
    );
    assert.ok(emitted?.assertion);
    validatePrediction(emitted.assertion);
    assert.equal(emitted.assertion.predicted_event_kind, PREDICTED_EVENT_KIND);
    assert.equal(emitted.assertion.basis.method, "phase_duration_ecdf");
    assert.equal(emitted.assertion.claim, "timing");
  });

  it("pattern line matches the one-line attribution standard", () => {
    const line = adoptionLagPatternLine(
      {
        n: 214,
        since_year: "2019",
        median_days: 42,
        middle_half_low: 26,
        middle_half_high: 75,
        projection: "per_matter",
      },
      { commentClose: "2026-03-01" },
    );
    assert.match(line, /Comment period closed 2026-03-01/);
    assert.match(line, /214 similar rule adoptions since 2019/);
    assert.match(line, /median 42 days/);
    assert.match(line, /middle half 26–75/);
  });

  it("digest delivery fires only on band transitions", () => {
    const synth = Array.from({ length: 30 }, (_, i) => ({
      subject_ref: `rulemaking:city:t${i}`,
      agency: "DOT",
      comment_close: "2022-01-01",
      adoption: "2022-03-01",
      gap_days: 40 + (i % 5),
      follow_up_days: 40 + (i % 5),
      censored: false,
      comment_close_basis: "hearing_event_date",
      notice_ids: [`n${i}`],
      notice_count: 1,
    }));
    const model = fitAdoptionLagModel(synth, {
      trainFrom: "2022-01-01",
      trainTo: "2024-12-31",
    });
    const a = emitAdoptionPrediction(
      {
        subject_ref: "notice:demo",
        agency: "DOT",
        comment_close: "2025-01-01",
        evidence_event_ids: ["cte:x"],
      },
      model,
      { now: "2025-01-15", generatedAt: "2025-01-15T12:00:00.000Z", shipBarPassed: true },
    );
    assert.ok(a?.assertion);
    // First delivery (no previous) when band is actionable.
    const first = adoptionLagDigestItem(a.assertion, null, {
      now: "2025-01-15",
      commentClose: "2025-01-01",
      pattern: a.pattern,
    });
    // Same band again → no resend.
    if (first) {
      const second = adoptionLagDigestItem(a.assertion, a.assertion, {
        now: "2025-01-15",
        commentClose: "2025-01-01",
        pattern: a.pattern,
      });
      assert.equal(second, null);
    }
    // predictionDeliveryTransition unit
    const band = predictionBand(a.assertion, { now: "2025-01-15" });
    if (band && band !== "far") {
      const key = predictionDeliveryTransition(null, a.assertion, { now: "2025-01-15" });
      assert.ok(key);
      assert.equal(
        predictionDeliveryTransition(a.assertion, a.assertion, { now: "2025-01-15" }),
        null,
      );
    }
  });
});

describe("rules adoption lag — ghost segment", () => {
  it("renders only after comment_close has occurred", () => {
    const model = {
      model_name: MODEL_NAME,
      train_from: "2013-01-01",
      train_to: "2024-12-31",
      backtest: { ship_bar_passed: true, public_projection: "per_matter_projection" },
      citywide: {
        cohort: "citywide · rules.comment_close→rules.adoption",
        n: 100,
        p10_days: 14,
        p50_days: 42,
        p90_days: 120,
        p25_days: 28,
        p75_days: 70,
        quantiles_complete: true,
        train_from: "2013-01-01",
        probability_adoption_365d: 0.5,
      },
      agencies: {},
    };
    const open = {
      request_id: "20260101001",
      stage: "comment-open",
      agency: "Transportation",
      events: [
        {
          event_type: "comment_close",
          valid_at: "2026-09-01",
          status: "scheduled",
        },
      ],
    };
    assert.equal(adoptionLagGhostFromModel(open, model, { now: "2026-07-01" }), null);

    const closed = {
      ...open,
      stage: "comment-closed",
      events: [
        {
          event_type: "comment_close",
          valid_at: "2026-06-01",
          status: "occurred",
        },
      ],
    };
    const ghost = adoptionLagGhostFromModel(closed, model, { now: "2026-07-01" });
    assert.ok(ghost);
    assert.equal(ghost.event_dot, false);
    assert.equal(ghost.dashed, true);
    assert.equal(ghost.chip, "Estimate");
    assert.match(ghost.pattern_line, /Comment period closed 2026-06-01/);

    const adopted = {
      ...closed,
      events: [
        ...closed.events,
        { event_type: "adoption", valid_at: "2026-06-20", status: "occurred" },
      ],
    };
    assert.equal(adoptionLagGhostFromModel(adopted, model, { now: "2026-07-01" }), null);
  });

  it("attachAdoptionLagEstimate stamps the phase view", () => {
    const model = {
      train_from: "2013-01-01",
      backtest: { ship_bar_passed: true },
      citywide: {
        n: 50,
        p10_days: 10,
        p50_days: 40,
        p90_days: 100,
        p25_days: 20,
        p75_days: 60,
        quantiles_complete: true,
        train_from: "2013-01-01",
      },
      agencies: {},
    };
    const view = { request_id: "x", phases: [] };
    const rec = {
      request_id: "x",
      stage: "comment-closed",
      events: [{ event_type: "comment_close", valid_at: "2026-05-01", status: "occurred" }],
    };
    const next = attachAdoptionLagEstimate(view, rec, model, { now: "2026-06-01" });
    assert.ok(next.adoption_lag_estimate);
  });
});

describe("rules adoption lag — committed artifacts", () => {
  it("ships model + evidence with a passing ship bar", () => {
    const modelPath = join(ROOT, "site/data/rules_adoption_lag_model.json");
    const evidencePath = join(ROOT, "docs/evidence/rules-adoption-lag/backtest.json");
    assert.ok(existsSync(modelPath), "model artifact missing");
    assert.ok(existsSync(evidencePath), "backtest evidence missing");
    const model = JSON.parse(readFileSync(modelPath, "utf8"));
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(model.model_name, MODEL_NAME);
    assert.equal(model.method, "phase_duration_ecdf");
    assert.ok(model.citywide?.quantiles_complete);
    assert.equal(evidence.ship_bar_passed, true);
    assert.ok(evidence.local_scorecard.resolved_backtest_predictions >= 50);
    assert.ok(evidence.local_scorecard.interval_coverage != null);
    const cov = evidence.local_scorecard.interval_coverage;
    assert.ok(Math.abs(cov - 0.8) <= 0.1 + 1e-9, `coverage ${cov}`);
  });

  it("sample fixture loads and produces observations", () => {
    assert.ok(existsSync(SAMPLE));
    const rows = JSON.parse(readFileSync(SAMPLE, "utf8"));
    assert.ok(rows.length >= 10);
    const obs = buildRulemakingGapObservations(rows, { cutoffDay: "2026-07-31" });
    assert.ok(Array.isArray(obs));
  });
});

describe("rules adoption lag — contract tests still green (smoke)", () => {
  it("prediction contract rejects unknown event kinds", async () => {
    const { buildPrediction } = await import("../worker/src/lib/prediction_contract.mjs");
    assert.throws(
      () => buildPrediction({
        subject_ref: "notice:1",
        predicted_event_kind: "rules.predicted_adoption",
        claim: "timing",
        predicted_window: { p10: "2026-01-01", p50: "2026-02-01", p90: "2026-03-01" },
        probability: 0.5,
        basis: {
          method: "phase_duration_ecdf",
          n: 10,
          train_from: "2020-01-01",
          train_to: "2024-12-31",
          cohort: "citywide",
          evidence_event_ids: ["e1"],
          statute_ref: null,
        },
        model_name: MODEL_NAME,
        model_version: "1.0.0",
        generated_at: "2025-01-01T12:00:00.000Z",
        supersedes_prediction_id: null,
        status: "open",
        resolved_by_event_id: null,
      }),
      /unknown predicted_event_kind/,
    );
  });
});
