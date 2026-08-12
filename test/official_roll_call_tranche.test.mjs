import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLL_CALL_GATE,
  SAMPLE_STRATA,
  selectStratifiedEventItems,
} from "../tools/build_official_roll_call_tranche.mjs";

function candidate({ stratum, eventId, date, body, action, itemId }) {
  return {
    stratum,
    request_id: `notice-${eventId}`,
    event: { EventId: eventId, EventDate: `${date}T18:00:00Z`, EventBodyName: body },
    item: {
      EventItemId: itemId,
      EventItemMatterId: `matter-${itemId}`,
      EventItemActionName: action,
    },
  };
}

test("roll-call sample declares the fixed promotion bars", () => {
  assert.equal(ROLL_CALL_GATE.minimum_distinct_events, 30);
  assert.equal(ROLL_CALL_GATE.minimum_retention_rate, 0.95);
  assert.equal(ROLL_CALL_GATE.minimum_reviewed_precision, 0.95);
  assert.deepEqual(SAMPLE_STRATA.map((row) => row.key), [
    "modern_2025_2026",
    "historical_2019_2024",
  ]);
});

test("stratified sample favors event diversity and retains both vintages", () => {
  const rows = [];
  for (let i = 0; i < 80; i += 1) {
    rows.push(candidate({
      stratum: "modern_2025_2026",
      eventId: `modern-${i}`,
      itemId: `modern-item-${i}`,
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      body: i % 2 ? "Committee on Finance" : "Committee on Land Use",
      action: i % 2 ? "Approved" : "Passed",
    }));
    rows.push(candidate({
      stratum: "historical_2019_2024",
      eventId: `historical-${i}`,
      itemId: `historical-item-${i}`,
      date: `2023-01-${String((i % 28) + 1).padStart(2, "0")}`,
      body: i % 2 ? "Committee on Finance" : "Committee on Land Use",
      action: i % 2 ? "Approved" : "Passed",
    }));
  }

  const selected = selectStratifiedEventItems(rows, 60);
  assert.equal(selected.length, 60);
  assert.equal(new Set(selected.map((row) => row.event.EventId)).size, 60);
  assert.equal(selected.filter((row) => row.stratum === "modern_2025_2026").length, 30);
  assert.equal(selected.filter((row) => row.stratum === "historical_2019_2024").length, 30);
});
