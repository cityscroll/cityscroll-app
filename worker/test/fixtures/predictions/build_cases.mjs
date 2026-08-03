import { buildPrediction } from "../../../src/lib/prediction_contract.mjs";

const DAY_MS = 86_400_000;
const SPLIT_DATE = "2025-01-01";
const P10 = "2025-02-10";
const P50 = "2025-03-02";
const P90 = "2025-03-22";
const EVIDENCE_IDS = ["cte:training-vote-1", "cte:training-vote-2"];

function addDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function assertion({ fixtureId, index, claim, probability }) {
  return buildPrediction({
    subject_ref: `meetings:${fixtureId}-${String(index).padStart(3, "0")}`,
    predicted_event_kind: "meetings.roll_call_vote",
    claim,
    predicted_window: { p10: P10, p50: P50, p90: P90 },
    probability,
    basis: {
      method: claim === "timing" ? "phase_duration_ecdf" : "base_rate",
      n: 500,
      train_from: "2020-01-01",
      train_to: "2024-12-30",
      cohort: "Council agenda items open at the historical split",
      evidence_event_ids: EVIDENCE_IDS,
      statute_ref: null,
    },
    model_name: `${fixtureId}_meeting_vote`,
    model_version: "1.0.0",
    generated_at: `${SPLIT_DATE}T00:00:00Z`,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

function event({ id, subjectRef, kind, validAt }) {
  return {
    event_id: `cte:${id}`,
    subject_ref: subjectRef,
    event_kind: kind,
    valid_at: validAt,
  };
}

function buildBacktest(fixtureId, { timingCoverage, occurrenceRealizedByQuintile }) {
  const predictions = [];
  const events = [
    event({
      id: "training-vote-1",
      subjectRef: "meetings:training-1",
      kind: "meetings.roll_call_vote",
      validAt: "2023-06-15",
    }),
    event({
      id: "training-vote-2",
      subjectRef: "meetings:training-2",
      kind: "meetings.roll_call_vote",
      validAt: "2024-11-20",
    }),
  ];

  for (let index = 0; index < 50; index += 1) {
    const prediction = assertion({ fixtureId, index, claim: "timing", probability: 1 });
    predictions.push(prediction);
    events.push(event({
      id: `${fixtureId}-open-${index}`,
      subjectRef: prediction.subject_ref,
      kind: "meetings.council_event",
      validAt: "2024-12-15",
    }));
    const covered = index < timingCoverage;
    events.push(event({
      id: `${fixtureId}-timing-${index}`,
      subjectRef: prediction.subject_ref,
      kind: "meetings.roll_call_vote",
      validAt: covered ? addDays(P50, (index % 11) - 5) : addDays(P90, 10 + (index % 3)),
    }));
  }

  for (let quintile = 0; quintile < 5; quintile += 1) {
    const probability = quintile / 5 + 0.1;
    const realizedCount = occurrenceRealizedByQuintile[quintile];
    for (let offset = 0; offset < 10; offset += 1) {
      const index = 50 + quintile * 10 + offset;
      const prediction = assertion({ fixtureId, index, claim: "occurrence", probability });
      predictions.push(prediction);
      events.push(event({
        id: `${fixtureId}-open-${index}`,
        subjectRef: prediction.subject_ref,
        kind: "meetings.council_event",
        validAt: "2024-12-16",
      }));
      events.push(event({
        id: `${fixtureId}-occurrence-${index}`,
        subjectRef: prediction.subject_ref,
        kind: offset < realizedCount
          ? "meetings.roll_call_vote"
          : "meetings.agenda_item_action",
        validAt: addDays(P50, offset),
      }));
    }
  }

  return {
    domain: "meetings",
    split_date: SPLIT_DATE,
    grace_days: 0,
    open_event_kinds: ["meetings.council_event"],
    terminal_event_kinds: ["meetings.agenda_item_action", "meetings.roll_call_vote"],
    predictions,
    events,
  };
}

export function buildPredictionCalibrationFixtures() {
  return [
    {
      id: "well_calibrated",
      expected_ship_bar: "pass",
      backtest: buildBacktest("well-calibrated", {
        timingCoverage: 40,
        occurrenceRealizedByQuintile: [1, 3, 5, 7, 9],
      }),
    },
    {
      id: "miscalibrated",
      expected_ship_bar: "fail",
      backtest: buildBacktest("miscalibrated", {
        timingCoverage: 25,
        occurrenceRealizedByQuintile: [9, 7, 5, 3, 1],
      }),
    },
  ];
}
