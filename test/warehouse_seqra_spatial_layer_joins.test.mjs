import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProjectBblHistory } from "../warehouse/lib/seqra_bbl_lot_history.mjs";
import {
  joinProjectLayersAtCutoff,
  joinSpatialLayerAtCutoff,
  SEQRA_SPATIAL_LAYER_TYPES,
} from "../warehouse/lib/seqra_spatial_layer_joins.mjs";
import { SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA } from "../warehouse/lib/seqra_layer_vintage.mjs";
import {
  ORIGINAL_BBL,
  PROJECT_KEY,
  SAMPLE_LOT_CHANGE_EVENTS,
  SAMPLE_PROJECT_INITIAL_DATE,
  SUBDIVIDED_BBL_A,
  SUBDIVIDED_BBL_B,
  sampleLayerRegistry,
} from "../warehouse/fixtures/seqra-spatial/sample_multi_lot_project.mjs";

function sampleHistory() {
  return buildProjectBblHistory({
    projectKey: PROJECT_KEY,
    initialBbls: [ORIGINAL_BBL],
    initialDate: SAMPLE_PROJECT_INITIAL_DATE,
    lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
  });
}

describe("SEQRA-06 spatial layer joins (A1, A2, A3, A5, negative rule)", () => {
  it("A1: every joined feature carries the layer vintage it was derived from", () => {
    const feature = joinSpatialLayerAtCutoff({
      layerType: "zoning",
      bbl: ORIGINAL_BBL,
      cutoff: "2018-06-01",
      vintages: sampleLayerRegistry().zoning.vintages,
      layerValuesByVintage: sampleLayerRegistry().zoning.layerValuesByVintage,
    });
    assert.equal(feature.layer_vintage, "zr-2017-09");
    assert.equal(feature.presence, "present");
  });

  it("A5: a layer with no vintage covering the cutoff is refused, not completed with current data", () => {
    assert.throws(() =>
      joinSpatialLayerAtCutoff({
        layerType: "pluto",
        bbl: ORIGINAL_BBL,
        cutoff: "2018-06-01", // before PLUTO's earliest fixture vintage (2019-01-01)
        vintages: sampleLayerRegistry().pluto.vintages,
        layerValuesByVintage: sampleLayerRegistry().pluto.layerValuesByVintage,
      }),
    );
  });

  it("A3: joins use the BBL footprint in force at the cutoff, not the project's present-day BBLs", () => {
    const history = sampleHistory();
    const result = joinProjectLayersAtCutoff({
      history,
      cutoff: "2019-03-01",
      layerRegistry: sampleLayerRegistry(),
      layerTypes: ["receptor"],
    });
    assert.deepEqual(result.footprint.bbls, [ORIGINAL_BBL]);
    assert.equal(result.features.every((f) => f.bbl === ORIGINAL_BBL), true);
  });

  it("joins every registered layer type across a post-subdivision footprint", () => {
    const history = sampleHistory();
    const result = joinProjectLayersAtCutoff({
      history,
      cutoff: "2021-06-01",
      layerRegistry: sampleLayerRegistry(),
    });
    assert.deepEqual([...new Set(result.features.map((f) => f.bbl))].sort(), [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B].sort());
    assert.deepEqual([...result.layer_types_joined].sort(), [...SEQRA_SPATIAL_LAYER_TYPES].sort());
  });

  it("A5: a refused join is reported in gaps, and never also appears in features (structural, not caller discipline)", () => {
    const history = sampleHistory();
    // 2019-06-01: post-project-start, pre-subdivision -- PLUTO has no vintage yet (starts 2019-01-01 but
    // disadvantaged_community and environmental_site layers don't start until 2020/2023), so several
    // layer types must gap here.
    const result = joinProjectLayersAtCutoff({
      history,
      cutoff: "2019-06-01",
      layerRegistry: sampleLayerRegistry(),
    });
    assert.ok(result.gaps.length > 0);
    for (const gap of result.gaps) {
      assert.equal(gap.schema, SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA);
      assert.equal(gap.gap_detected, true);
    }
    const gappedPairs = new Set(result.gaps.map((g) => `${g.layer_type}:${g.bbl}`));
    const featuredPairs = new Set(result.features.map((f) => `${f.layer_type}:${f.bbl}`));
    for (const pair of gappedPairs) assert.equal(featuredPairs.has(pair), false, `${pair} must not appear in both gaps and features`);
    assert.equal(result.features.length + result.gaps.length, result.footprint.bbls.length * result.layer_types_joined.length);
  });

  it("A2: rejoining the same historical cutoff is byte-identical whether or not later vintages exist in the registry", () => {
    const history = sampleHistory();
    const fullRegistry = sampleLayerRegistry();
    const asOfThenRegistry = {
      ...fullRegistry,
      flood: { ...fullRegistry.flood, vintages: [fullRegistry.flood.vintages[0]] }, // only the vintage published by 2019
    };
    const then = joinProjectLayersAtCutoff({ history, cutoff: "2019-03-01", layerRegistry: asOfThenRegistry, layerTypes: ["flood"] });
    const today = joinProjectLayersAtCutoff({ history, cutoff: "2019-03-01", layerRegistry: fullRegistry, layerTypes: ["flood"] });
    assert.deepEqual(then.features, today.features);
  });

  it("negative rule: an unregistered layer type is skipped, never silently backfilled with a placeholder", () => {
    const history = sampleHistory();
    const result = joinProjectLayersAtCutoff({
      history,
      cutoff: "2021-06-01",
      layerRegistry: { pluto: sampleLayerRegistry().pluto },
      layerTypes: SEQRA_SPATIAL_LAYER_TYPES,
    });
    assert.deepEqual(result.layer_types_joined, ["pluto"]);
  });
});
