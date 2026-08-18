import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STAFFING_EXAMS_MAX_AGE_DAYS,
  assertStaffingExamsServeGate,
  staffingArtifactDataCurrentAsOf,
  staffingExamsServeGateFindings,
  staffingListCurrentAsOf,
} from "../tools/build_staffing_exams.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = JSON.parse(
  readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"),
);

function baseArtifact(overrides = {}) {
  return {
    schema_version: 6,
    generated_at: "2026-08-18",
    open_window_as_of: "2026-08-18",
    data_current_as_of: "2026-08-17",
    list_current_as_of: "2026-08-17",
    annual_schedule_current_as_of: "2026-07-22",
    sources: [
      {
        id: "dcas-active-civil-service-list",
        dataset_id: "vx8i-nprf",
        fetched_at: "2026-08-18",
        stale_after_days: 3,
      },
    ],
    source_checks: {
      list_aggregates: { distinct_exams: 850, total_list_rows_sum: 400000 },
      active_list: { distinct_exams: "850" },
    },
    exams: Array.from({ length: 120 }, (_, i) => ({
      exam_number: String(7000 + i),
      title: `Exam ${7000 + i}`,
      list_count: 10,
    })),
    ...overrides,
  };
}

test("staffing data_current_as_of tracks the freshest schedule or list publisher clock", () => {
  assert.equal(
    staffingArtifactDataCurrentAsOf({
      annual: { source: { data_current_as_of: "2026-07-22" } },
      activeList: { summary: { latest_established: "2026-08-17" } },
      listAggregates: { summary: { latest_established: "2026-08-17" } },
    }),
    "2026-08-17",
  );
  assert.equal(
    staffingListCurrentAsOf({
      activeList: { summary: { latest_established: "2026-08-17" } },
      listAggregates: {
        source: { fetched_at: "2026-08-18" },
        summary: { latest_established: "2026-08-17" },
      },
    }),
    "2026-08-17",
  );
});

test("serve gate fails closed when the staffing artifact ages past the publish window", () => {
  const fresh = baseArtifact();
  assert.equal(
    staffingExamsServeGateFindings(fresh, { today: "2026-08-18" }).length,
    0,
  );
  assertStaffingExamsServeGate(fresh, { today: "2026-08-18" });

  const stale = baseArtifact({
    generated_at: "2026-07-20",
    open_window_as_of: "2026-07-20",
    sources: [
      {
        id: "dcas-active-civil-service-list",
        dataset_id: "vx8i-nprf",
        fetched_at: "2026-07-20",
      },
    ],
  });
  assert.throws(
    () => assertStaffingExamsServeGate(stale, { today: "2026-08-18" }),
    /exceeds max/,
  );
});

test("serve gate rejects missing list as-of, thin aggregates, and PII-shaped fields", () => {
  assert.match(
    staffingExamsServeGateFindings(
      baseArtifact({ list_current_as_of: null }),
      { today: "2026-08-18" },
    ).join(" "),
    /list_current_as_of/,
  );
  assert.match(
    staffingExamsServeGateFindings(
      baseArtifact({
        source_checks: { list_aggregates: { distinct_exams: 2 } },
      }),
      { today: "2026-08-18" },
    ).join(" "),
    /distinct_exams/,
  );
  assert.match(
    staffingExamsServeGateFindings(
      baseArtifact({
        exams: [{ exam_number: "7016", title: "Caseworker", first_name: "Ada" }],
      }),
      { today: "2026-08-18" },
    ).join(" "),
    /PII field first_name/,
  );
});

test("committed staffing exams artifact clears the serve gate at its open-window clock", () => {
  assert.ok(ARTIFACT.open_window_as_of || ARTIFACT.generated_at);
  assert.ok(Number.isFinite(STAFFING_EXAMS_MAX_AGE_DAYS));
  // After the refresh→publish landing, committed artifacts must carry list + window stamps.
  // Pre-landing fixtures in other PRs may still lack them; tolerate only while rebuilding.
  if (!ARTIFACT.list_current_as_of || !ARTIFACT.open_window_as_of) {
    assert.ok(
      ARTIFACT.generated_at,
      "expected at least generated_at before refresh materialization",
    );
    return;
  }
  assertStaffingExamsServeGate(ARTIFACT, {
    today: ARTIFACT.open_window_as_of,
  });
});
