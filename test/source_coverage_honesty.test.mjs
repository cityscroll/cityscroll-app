// Source-coverage honesty gate: live row counts, not config flags alone.
//
//   node --test test/source_coverage_honesty.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  classifyLiveObservation,
  emitCoverageHonestyCards,
  findCoverageHonestyViolations,
  measureLiveCoverage,
  recomputeMeasurement,
  validateSourceCoverageMatrix,
} from "../entity_resolution/evaluation/source_coverage_honesty.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = join(ROOT, "entity_resolution/source_coverage.json");

function loadMatrix() {
  return JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
}

function adapterReadyRow(overrides = {}) {
  return {
    id: "demo-stream",
    source_system: "demo_system",
    importer: "worker/src/demo.mjs#run",
    identity_entities: ["vendor"],
    stable_source_key: "id",
    observation_schema: "worker/migrations/0008_source_records.sql",
    fixture: "worker/test/er_source_coverage.test.mjs",
    replay_test: "worker/test/er_source_coverage.test.mjs",
    dual_write: {
      flag: "DEMO_SOURCE_RECORD_DUAL_WRITE",
      before: "complete",
      after: "complete",
      adapter: "ready",
      default: "off",
      fail_soft: true,
    },
    live_observation: {
      status: "complete",
      row_count: 10,
      latest_ingested_at: "2026-08-01T00:00:00.000Z",
      measured_at: "2026-08-01T00:00:00.000Z",
    },
    known_gap: null,
    ...overrides,
  };
}

test("classifyLiveObservation: zero rows with adapter ready is empty-declared-live", () => {
  assert.equal(
    classifyLiveObservation({ adapterReady: true, rowCount: 0 }),
    "empty-declared-live",
  );
});

test("classifyLiveObservation: zero rows without adapter is gap", () => {
  assert.equal(
    classifyLiveObservation({ adapterReady: false, rowCount: 0 }),
    "gap",
  );
});

test("classifyLiveObservation: non-zero fresh rows are complete", () => {
  assert.equal(
    classifyLiveObservation({
      adapterReady: true,
      rowCount: 5,
      latestIngestedAt: "2026-08-01T00:00:00.000Z",
      now: "2026-08-01T12:00:00.000Z",
      staleAfterDays: 2,
    }),
    "complete",
  );
});

test("classifyLiveObservation: non-zero old rows are stale", () => {
  assert.equal(
    classifyLiveObservation({
      adapterReady: true,
      rowCount: 5,
      latestIngestedAt: "2026-07-01T00:00:00.000Z",
      now: "2026-08-01T00:00:00.000Z",
      staleAfterDays: 2,
    }),
    "stale",
  );
});

test("classifyLiveObservation: thinness partial overrides complete", () => {
  assert.equal(
    classifyLiveObservation({
      adapterReady: true,
      rowCount: 32,
      latestIngestedAt: "2026-07-31T00:00:00.000Z",
      now: "2026-08-01T00:00:00.000Z",
      thinness: "partial",
    }),
    "partial",
  );
});

test("declared-complete source with 0 rows fails the honesty check", () => {
  const lying = adapterReadyRow({
    dual_write: {
      flag: "DEMO_SOURCE_RECORD_DUAL_WRITE",
      before: "complete",
      after: "complete",
      adapter: "ready",
      default: "off",
      fail_soft: true,
    },
    live_observation: {
      status: "complete",
      row_count: 0,
      latest_ingested_at: null,
      measured_at: "2026-08-01T00:00:00.000Z",
    },
    known_gap: null,
  });
  const violations = findCoverageHonestyViolations([lying]);
  assert.ok(
    violations.some((v) => v.kind === "complete-with-zero-rows"),
    `expected complete-with-zero-rows, got ${JSON.stringify(violations)}`,
  );
  const result = validateSourceCoverageMatrix({
    sources: [lying],
    measurement: {
      before: { covered: 1, total: 1, rate: 1 },
      after: { covered: 1, total: 1, rate: 1 },
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /complete requires live_observation.row_count > 0|complete-with-zero|row_count is 0/i.test(e)),
    `expected zero-row complete error, got ${result.errors.join("; ")}`,
  );
});

test("empty-declared-live with 0 rows passes when explained", () => {
  const honest = adapterReadyRow({
    dual_write: {
      flag: "DEMO_SOURCE_RECORD_DUAL_WRITE",
      before: "complete",
      after: "empty-declared-live",
      adapter: "ready",
      default: "off",
      fail_soft: true,
    },
    live_observation: {
      status: "empty-declared-live",
      row_count: 0,
      latest_ingested_at: null,
      measured_at: "2026-08-01T00:00:00.000Z",
      note: "Flag on, zero rows.",
    },
    known_gap: "Adapter ready but production source_records empty.",
  });
  const result = validateSourceCoverageMatrix({
    sources: [honest],
    measurement: recomputeMeasurement({ sources: [honest] }),
  });
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.measurement.after.covered, 0);
  assert.equal(result.measurement.by_status["empty-declared-live"], 1);
});

test("committed matrix has no complete-with-zero-rows and checker exits 0", () => {
  const matrix = loadMatrix();
  const violations = findCoverageHonestyViolations(matrix.sources);
  assert.equal(
    violations.filter((v) => v.kind === "complete-with-zero-rows").length,
    0,
    JSON.stringify(violations),
  );
  for (const row of matrix.sources) {
    if (row.dual_write?.after === "complete") {
      assert.ok(
        Number(row.live_observation?.row_count) > 0,
        `${row.id} is complete with row_count=${row.live_observation?.row_count}`,
      );
    }
  }
  const result = validateSourceCoverageMatrix(matrix);
  assert.equal(result.ok, true, result.errors.join("; "));
  // Remeasured 2026-08-12: PASSPort + Legistar + Checkbook + person-hub
  // constellation + ULURP PDF retention populate source_records (complete 11/17).
  // Attachments stay empty-declared-live.
  assert.equal(result.measurement.after.covered, 11);
  assert.equal(result.measurement.by_status["empty-declared-live"], 1);
  assert.equal(result.measurement.by_status.partial, 1);
  assert.equal(result.measurement.by_status.complete, 11);
  assert.equal(result.measurement.by_status.gap, 4);
  for (const id of [
    "passport-public-contracts",
    "passport-public-rfx",
    "legistar-events",
    "legistar-event-items",
    "legistar-votes",
    "nyc-council-members",
    "city-clerk-elobbyist",
    "cfb-campaign-contributions",
    "ulurp-recommendation-pdfs",
  ]) {
    const row = matrix.sources.find((s) => s.id === id);
    assert.equal(row?.dual_write?.after, "complete", id);
    assert.ok(Number(row?.live_observation?.row_count) > 0, id);
  }

  const check = spawnSync(
    process.execPath,
    ["tools/check_er_source_coverage.mjs", "--matrix", "entity_resolution/source_coverage.json"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /live 11\/17 complete/);
  assert.match(check.stdout, /empty-declared-live=1/);
});

test("measureLiveCoverage never counts zero-row streams as complete", () => {
  const measured = measureLiveCoverage([
    adapterReadyRow({
      id: "a",
      dual_write: { flag: "F", before: "complete", after: "complete", adapter: "ready", default: "off", fail_soft: true },
      live_observation: { status: "complete", row_count: 3, latest_ingested_at: "2026-08-01T00:00:00.000Z" },
    }),
    adapterReadyRow({
      id: "b",
      dual_write: {
        flag: "F",
        before: "complete",
        after: "empty-declared-live",
        adapter: "ready",
        default: "off",
        fail_soft: true,
      },
      live_observation: { status: "empty-declared-live", row_count: 0 },
      known_gap: "empty",
    }),
  ]);
  assert.equal(measured.covered, 1);
  assert.equal(measured.by_status["empty-declared-live"], 1);
  assert.equal(measured.rate, 0.5);
});

test("emitCoverageHonestyCards auto-emits bugs for empty-declared-live streams", () => {
  const matrix = loadMatrix();
  const cards = emitCoverageHonestyCards(matrix);
  const emptyCards = cards.filter((c) => c.evidence?.kind === "empty-declared-live");
  // After PASSPort + Legistar dual-write fill, only nested Attachments remain empty-declared-live.
  assert.ok(emptyCards.length >= 1, `expected ≥1 empty-declared-live cards, got ${emptyCards.length}`);
  assert.ok(emptyCards.some((c) => c.id.includes("legistar-attachments")));
  assert.ok(!emptyCards.some((c) => c.id.includes("passport-public-contracts")));
  assert.ok(!emptyCards.some((c) => c.id.includes("legistar-events")));
  for (const card of emptyCards) {
    assert.equal(card.dimension, "coverage");
    assert.ok(card.verify);
    assert.ok(card.demo_win);
    assert.equal(card.lesson_class, "empty-declared-live-coverage");
    assert.ok(card.rank_score >= 90);
  }
  // Lying complete+0 also emits
  const lying = {
    sources: [
      adapterReadyRow({
        id: "lie",
        dual_write: {
          flag: "F",
          before: "complete",
          after: "complete",
          adapter: "ready",
          default: "off",
          fail_soft: true,
        },
        live_observation: { status: "complete", row_count: 0 },
      }),
    ],
  };
  const lieCards = emitCoverageHonestyCards(lying);
  assert.ok(lieCards.some((c) => c.evidence?.kind === "empty-declared-live" && c.id.includes("lie")));
});

test("checker fails when matrix claims complete with zero rows", () => {
  const matrix = loadMatrix();
  const poisoned = structuredClone(matrix);
  const passport = poisoned.sources.find((s) => s.id === "passport-public-contracts");
  passport.dual_write.after = "complete";
  passport.live_observation.status = "complete";
  passport.live_observation.row_count = 0;
  passport.known_gap = null;
  // Leave measurement as-is so either honesty or drift fails.
  const result = validateSourceCoverageMatrix(poisoned);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /passport-public-contracts/.test(e) && /row_count|complete/i.test(e)),
    result.errors.join("; "),
  );
});

test("dual-write row_count > 0 raises source_coverage complete for passport and legistar streams", () => {
  // Characterization: when ingest/refresh dual-write leaves observations, the
  // named metric treats those streams as complete (not empty-declared-live).
  const emptyPassport = adapterReadyRow({
    id: "passport-public-contracts",
    source_system: "passport_public_contracts",
    dual_write: {
      flag: "PASSPORT_SOURCE_RECORD_DUAL_WRITE",
      before: "complete",
      after: "empty-declared-live",
      adapter: "ready",
      default: "off",
      fail_soft: true,
    },
    live_observation: {
      status: "empty-declared-live",
      row_count: 0,
      latest_ingested_at: null,
      measured_at: "2026-08-01T00:00:00.000Z",
      note: "Flag on, zero rows.",
    },
    known_gap: "Adapter ready but empty.",
  });
  const emptyLegistar = adapterReadyRow({
    id: "legistar-events",
    source_system: "nyc_legistar_events",
    dual_write: {
      flag: "LEGISTAR_SOURCE_RECORD_DUAL_WRITE",
      before: "gap",
      after: "empty-declared-live",
      adapter: "ready",
      default: "off",
      fail_soft: true,
    },
    live_observation: {
      status: "empty-declared-live",
      row_count: 0,
      latest_ingested_at: null,
      measured_at: "2026-08-01T00:00:00.000Z",
      note: "Flag on, zero rows.",
    },
    known_gap: "Adapter ready but empty.",
  });
  const before = measureLiveCoverage([emptyPassport, emptyLegistar]);
  assert.equal(before.covered, 0);
  assert.equal(before.by_status["empty-declared-live"], 2);

  // Simulate post-ingest dual-write: product path wrote immutable observations.
  const filledPassport = {
    ...emptyPassport,
    dual_write: { ...emptyPassport.dual_write, after: "complete" },
    live_observation: {
      status: "complete",
      row_count: 61451,
      latest_ingested_at: "2026-08-02T13:00:35.582Z",
      measured_at: "2026-08-02T17:02:36.000Z",
    },
    known_gap: null,
  };
  const filledLegistar = {
    ...emptyLegistar,
    dual_write: { ...emptyLegistar.dual_write, after: "complete" },
    live_observation: {
      status: "complete",
      row_count: 435,
      latest_ingested_at: "2026-08-01T23:51:10.760Z",
      measured_at: "2026-08-02T17:02:36.000Z",
    },
    known_gap: null,
  };
  const after = measureLiveCoverage([filledPassport, filledLegistar], {
    now: "2026-08-02T23:59:59.000Z",
  });
  assert.equal(after.covered, 2);
  assert.ok(after.covered > before.covered);
  assert.equal(after.by_status.complete, 2);
  assert.equal(after.by_status["empty-declared-live"], 0);
});
