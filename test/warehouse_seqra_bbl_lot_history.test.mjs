import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bblFootprintAsOf,
  buildProjectBblHistory,
  SeqraBblLotHistoryError,
  traceBblLineage,
} from "../warehouse/lib/seqra_bbl_lot_history.mjs";
import {
  ORIGINAL_BBL,
  SAMPLE_LOT_CHANGE_EVENTS,
  SAMPLE_PROJECT_INITIAL_DATE,
  SUBDIVIDED_BBL_A,
  SUBDIVIDED_BBL_B,
  SUBDIVISION_DATE,
  PROJECT_KEY,
} from "../warehouse/fixtures/seqra-spatial/sample_multi_lot_project.mjs";

describe("SEQRA-06 project BBL/lot history (A3)", () => {
  it("builds an ordered snapshot timeline from the initial footprint and lot-change events", () => {
    const history = buildProjectBblHistory({
      projectKey: PROJECT_KEY,
      initialBbls: [ORIGINAL_BBL],
      initialDate: SAMPLE_PROJECT_INITIAL_DATE,
      lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
    });
    assert.equal(history.snapshots.length, 2);
    assert.deepEqual(history.snapshots[0].bbls, [ORIGINAL_BBL]);
    assert.equal(history.snapshots[0].effective_end, SUBDIVISION_DATE);
    assert.deepEqual([...history.snapshots[1].bbls].sort(), [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B].sort());
    assert.equal(history.snapshots[1].effective_end, null);
  });

  it("A3: a footprint before the subdivision resolves to the original BBL, never the present geometry", () => {
    const history = buildProjectBblHistory({
      projectKey: PROJECT_KEY,
      initialBbls: [ORIGINAL_BBL],
      initialDate: SAMPLE_PROJECT_INITIAL_DATE,
      lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
    });
    const before = bblFootprintAsOf(history, "2019-01-01");
    assert.deepEqual(before.bbls, [ORIGINAL_BBL]);
    const after = bblFootprintAsOf(history, "2021-01-01");
    assert.deepEqual([...after.bbls].sort(), [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B].sort());
  });

  it("A3: the retired original BBL is never dropped from the project's history", () => {
    const history = buildProjectBblHistory({
      projectKey: PROJECT_KEY,
      initialBbls: [ORIGINAL_BBL],
      initialDate: SAMPLE_PROJECT_INITIAL_DATE,
      lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
    });
    assert.ok(history.every_bbl_ever_held.includes(ORIGINAL_BBL));
    assert.ok(history.every_bbl_ever_held.includes(SUBDIVIDED_BBL_A));
    assert.ok(history.every_bbl_ever_held.includes(SUBDIVIDED_BBL_B));
  });

  it("traces a subdivided BBL's lineage in both directions", () => {
    const history = buildProjectBblHistory({
      projectKey: PROJECT_KEY,
      initialBbls: [ORIGINAL_BBL],
      initialDate: SAMPLE_PROJECT_INITIAL_DATE,
      lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
    });
    const fromOriginal = traceBblLineage(history, ORIGINAL_BBL);
    assert.equal(fromOriginal.length, 2);
    const fromNew = traceBblLineage(history, SUBDIVIDED_BBL_A);
    assert.equal(fromNew.length, 1);
    assert.equal(fromNew[0].from_bbl, ORIGINAL_BBL);
  });

  it("refuses a cutoff before the project's earliest known footprint rather than backdating it", () => {
    const history = buildProjectBblHistory({
      projectKey: PROJECT_KEY,
      initialBbls: [ORIGINAL_BBL],
      initialDate: SAMPLE_PROJECT_INITIAL_DATE,
      lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
    });
    assert.throws(() => bblFootprintAsOf(history, "2010-01-01"), SeqraBblLotHistoryError);
  });

  it("rejects a lot-change event that retires a BBL not currently in the footprint", () => {
    assert.throws(
      () =>
        buildProjectBblHistory({
          projectKey: PROJECT_KEY,
          initialBbls: [ORIGINAL_BBL],
          initialDate: SAMPLE_PROJECT_INITIAL_DATE,
          lotChangeEvents: [
            { event_type: "merge", effective_date: "2020-01-01", from_bbls: ["3099990099"], to_bbls: ["3099990100"] },
          ],
        }),
      SeqraBblLotHistoryError,
    );
  });

  it("supports a merge (two BBLs collapsing into one) symmetrically with subdivision", () => {
    const history = buildProjectBblHistory({
      projectKey: "project:zap:merge-fixture",
      initialBbls: ["3011110001", "3011110002"],
      initialDate: "2015-01-01",
      lotChangeEvents: [
        { event_type: "merge", effective_date: "2019-01-01", from_bbls: ["3011110001", "3011110002"], to_bbls: ["3011110003"] },
      ],
    });
    assert.deepEqual(bblFootprintAsOf(history, "2018-01-01").bbls, ["3011110001", "3011110002"]);
    assert.deepEqual(bblFootprintAsOf(history, "2020-01-01").bbls, ["3011110003"]);
  });
});
