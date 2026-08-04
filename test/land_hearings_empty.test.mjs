/**
 * Hearing-attender empty-state classifier for Land → Upcoming hearings.
 *
 *   node --test test/land_hearings_empty.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { landHearingsEmptyState } from "../site/land_hearings_empty.mjs";

test("none_future when materialization extracted hearings but upcoming_count is 0", () => {
  // Live 2026-08-03 cityscroll.org: hearings_extracted 88, upcoming_count 0, hearings [].
  const snap = {
    generated_at: "2026-08-03T20:11:32.855Z",
    materialization: {
      hearings_extracted: 88,
      upcoming_count: 0,
    },
    hearings: [],
  };
  const st = landHearingsEmptyState(snap, { allCount: 0, filteredCount: 0 });
  assert.equal(st.kind, "none_future");
  assert.equal(st.extracted, 88);
  assert.equal(st.generated_at, "2026-08-03T20:11:32.855Z");
});

test("filters when snapshot has rows but none pass borough/mode/keyword", () => {
  const snap = {
    materialization: { hearings_extracted: 5, upcoming_count: 5 },
    hearings: [{ project_id: "2024Q0292" }],
  };
  const st = landHearingsEmptyState(snap, { allCount: 5, filteredCount: 0 });
  assert.equal(st.kind, "filters");
});

test("has_rows short-circuits when filtered list is non-empty", () => {
  const st = landHearingsEmptyState(null, { allCount: 0, filteredCount: 3 });
  assert.equal(st.kind, "has_rows");
});

test("empty when no extraction evidence", () => {
  const st = landHearingsEmptyState({ hearings: [], materialization: {} }, {
    allCount: 0,
    filteredCount: 0,
  });
  assert.equal(st.kind, "empty");
});
