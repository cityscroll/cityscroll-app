import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSpatialCoverageGap,
  findOverlappingVintages,
  resolveLayerVintage,
  SeqraLayerVintageError,
  SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA,
} from "../warehouse/lib/seqra_layer_vintage.mjs";

const PLUTO_VINTAGES = [
  { vintage: "19v1", effective_start: "2019-01-01", effective_end: "2020-01-01" },
  { vintage: "20v1", effective_start: "2020-01-01", effective_end: "2021-01-01" },
  { vintage: "21v1", effective_start: "2021-01-01", effective_end: null },
];

describe("SEQRA-06 layer-vintage resolution (A1, A2, A5)", () => {
  it("resolves the vintage whose window contains the cutoff", () => {
    const match = resolveLayerVintage({ layerType: "pluto", bbl: "3000010001", cutoff: "2020-06-15", vintages: PLUTO_VINTAGES });
    assert.equal(match.vintage, "20v1");
  });

  it("resolves against the open-ended (current) window when no later window exists", () => {
    const match = resolveLayerVintage({ layerType: "pluto", bbl: "3000010001", cutoff: "2026-01-01", vintages: PLUTO_VINTAGES });
    assert.equal(match.vintage, "21v1");
  });

  it("A2: resolving a historical cutoff is identical whether or not later vintages exist in the series yet", () => {
    const cutoff = "2019-06-01";
    const seriesAsOfThen = [PLUTO_VINTAGES[0]]; // only the vintage published by then
    const seriesAsOfToday = PLUTO_VINTAGES; // the full series, including releases from years later
    const then = resolveLayerVintage({ layerType: "pluto", bbl: "3000010001", cutoff, vintages: seriesAsOfThen });
    const today = resolveLayerVintage({ layerType: "pluto", bbl: "3000010001", cutoff, vintages: seriesAsOfToday });
    assert.deepEqual(then, today);
  });

  it("A5: refuses a join when no vintage covers the cutoff, reporting a coverage gap rather than a fallback value", () => {
    let thrown = null;
    try {
      resolveLayerVintage({ layerType: "pluto", bbl: "3000010001", cutoff: "2015-01-01", vintages: PLUTO_VINTAGES });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof SeqraLayerVintageError);
    assert.equal(thrown.coverageGap.schema, SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA);
    assert.equal(thrown.coverageGap.gap_detected, true);
    assert.equal(thrown.coverageGap.reason, "no_vintage_covers_cutoff");
  });

  it("A5: refuses rather than silently using the nearest vintage when a cutoff falls in a real gap between two windows", () => {
    const withGap = [
      { vintage: "a", effective_start: "2018-01-01", effective_end: "2019-01-01" },
      { vintage: "b", effective_start: "2020-01-01", effective_end: null },
    ];
    assert.throws(
      () => resolveLayerVintage({ layerType: "flood", bbl: "3000010001", cutoff: "2019-06-01", vintages: withGap }),
      SeqraLayerVintageError,
    );
  });

  it("detects overlapping vintage windows as a data-integrity problem, not a resolvable ambiguity", () => {
    const overlapping = [
      { vintage: "a", effective_start: "2018-01-01", effective_end: "2019-06-01" },
      { vintage: "b", effective_start: "2019-01-01", effective_end: null },
    ];
    assert.deepEqual(findOverlappingVintages(overlapping), [["a", "b"]]);
    assert.throws(
      () => resolveLayerVintage({ layerType: "flood", bbl: "3000010001", cutoff: "2019-03-01", vintages: overlapping }),
      SeqraLayerVintageError,
    );
  });

  it("rejects a malformed vintage window (end not after start)", () => {
    const malformed = [{ vintage: "a", effective_start: "2020-01-01", effective_end: "2020-01-01" }];
    assert.throws(() => resolveLayerVintage({ layerType: "pluto", bbl: "3000010001", cutoff: "2020-06-01", vintages: malformed }));
  });

  it("buildSpatialCoverageGap never claims the join succeeded", () => {
    const gap = buildSpatialCoverageGap({ layerType: "zoning", bbl: "3000010001", cutoff: "2015-01-01", reason: "no_vintage_covers_cutoff" });
    assert.equal(gap.schema, SEQRA_SPATIAL_COVERAGE_GAP_SCHEMA);
    assert.match(gap.statement, /coverage gap/);
    assert.match(gap.statement, /refused/);
  });
});
