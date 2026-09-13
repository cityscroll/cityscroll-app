import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHistoricalProjectContextReader,
  referencedProjectIds,
  selectHistoricalProjectContext,
  shardHistoricalProjectContext,
} from "../site/historical_project_context.mjs";

const currentRows = [{ project_id: "2020K0270", public_status: "Completed" }, { project_id: "2024K0001" }];
const bblRows = [{ project_id: "2020K0270", bbls: ["3073670011", "3073670029"] }, { project_id: "2018K0350" }];
const mihRows = [{ project_id: "2020K0270", mih: { status: "Adopted", date_adopted: "2022-02-24" } }];

describe("historical project context", () => {
  it("selects the exact reference union and keeps unknown status explicit", () => {
    const result = selectHistoricalProjectContext({
      currentRows,
      zapBblRows: bblRows,
      mihRows,
      publisherRows: [
        { project_id: "2020K0270", public_status: "Completed", ulurp_numbers: "C210239ZMK; N210240ZRK" },
        { project_id: "2018K0350", project_name: "unreferenced control" },
        { project_id: "2024K0001", public_status: "" },
      ],
    });
    assert.deepEqual(result.selected_ids, ["2018K0350", "2020K0270", "2024K0001"]);
    assert.equal(result.retained_rows.find((row) => row.project_id === "2024K0001").public_status, "unknown");
    assert.deepEqual(result.excluded_ids, []);
  });

  it("does not select a lookalike or an unreferenced publisher row", () => {
    const result = selectHistoricalProjectContext({
      currentRows: [], zapBblRows: [{ project_id: "2020K0270" }], mihRows: [],
      publisherRows: [{ project_id: "2020K0270", project_name: "Coyle" }, { project_id: "2018K0350", project_name: "same address" }],
    });
    assert.deepEqual(result.retained_rows.map((row) => row.project_id), ["2020K0270"]);
    assert.deepEqual(result.excluded_ids, ["2018K0350"]);
  });

  it("retrieves by exact ID independent of input order", () => {
    const rows = [{ project_id: "B000" }, { project_id: "A000" }, { project_id: "C000" }];
    const one = selectHistoricalProjectContext({ zapBblRows: rows, publisherRows: rows });
    const two = selectHistoricalProjectContext({ zapBblRows: [...rows].reverse(), publisherRows: [...rows].reverse() });
    assert.deepEqual(one.selected_ids, two.selected_ids);
    const reader = createHistoricalProjectContextReader({}, shardHistoricalProjectContext(one.retained_rows, 2));
    assert.equal(reader.get("B000").project_id, "B000");
    assert.equal(reader.get("NOPE"), null);
  });

  it("includes current IDs in the same exact-key population without changing landing selection", () => {
    assert.deepEqual(referencedProjectIds({ currentRows, bblRows: [], mihRows: [] }), ["2020K0270", "2024K0001"]);
  });
});
