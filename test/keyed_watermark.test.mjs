import assert from "node:assert/strict";
import test from "node:test";

import {
  compareWatermarks,
  composeKeyedWatermark,
  expandWatermarkEntry,
  parseWatermarkComponents,
  watermarkRegressedByCompare,
} from "../tools/lib/keyed_watermark.mjs";

test("composeKeyedWatermark names sources and flattens nested keyed composites", () => {
  const token = composeKeyedWatermark({
    obligations: "2026-10-06T13:48:38.716Z",
    certification: "2026-08-06T00:00:00Z",
    process_conformance: composeKeyedWatermark({
      obligations_lookup: "2026-10-06T13:48:38.716Z",
      rules_domain: "2026-08-11T21:12:40.677Z",
    }),
  });
  assert.equal(
    token,
    [
      "certification=2026-08-06T00:00:00Z",
      "obligations=2026-10-06T13:48:38.716Z",
      "process_conformance.obligations_lookup=2026-10-06T13:48:38.716Z",
      "process_conformance.rules_domain=2026-08-11T21:12:40.677Z",
    ].join("|"),
  );
  const parsed = parseWatermarkComponents(token);
  assert.equal(parsed.keyed, true);
  assert.equal(parsed.map.obligations, "2026-10-06T13:48:38.716Z");
});

test("expandWatermarkEntry indexes legacy nested anonymous composites", () => {
  assert.deepEqual(
    expandWatermarkEntry("fiscal_context", "2026-08-18T04:05:51.552Z|2026-08-26T00:00:00.000Z"),
    [
      ["fiscal_context.0", "2026-08-18T04:05:51.552Z"],
      ["fiscal_context.1", "2026-08-26T00:00:00.000Z"],
    ],
  );
});

test("compareWatermarks allows source-set change and refuses shared-source regression", () => {
  const prior = composeKeyedWatermark({
    obligations: "2026-08-07T23:52:53.226Z",
    certification: "2026-08-06T00:00:00Z",
  });
  const advanced = composeKeyedWatermark({
    obligations: "2026-10-06T13:48:38.716Z",
    certification: "2026-08-06T00:00:00Z",
    intelligence: "2026-09-30T13:15:55.664Z",
  });
  const change = compareWatermarks(prior, advanced);
  assert.equal(change.regressed, false);
  assert.equal(change.source_set_changed, true);
  assert.deepEqual(change.added, ["intelligence"]);
  assert.deepEqual(change.removed, []);

  const regressed = composeKeyedWatermark({
    obligations: "2026-08-01T00:00:00Z",
    certification: "2026-08-06T00:00:00Z",
  });
  assert.equal(watermarkRegressedByCompare(prior, regressed), true);
  assert.deepEqual(compareWatermarks(prior, regressed).shared_regressed, ["obligations"]);
});

test("legacy anonymous multi-component disappearance is a source-set change", () => {
  const prior = "12796|2026-08-06T00:00:00Z|2026-08-07T23:52:53.226Z|2026-08-11T21:12:40.677Z";
  const current = "12796|2026-08-06T00:00:00Z|2026-08-11T21:12:40.677Z|2026-10-06T13:48:38.716Z";
  const change = compareWatermarks(prior, current);
  assert.equal(change.regressed, false);
  assert.equal(change.source_set_changed, true);
  assert.equal(watermarkRegressedByCompare("2026-09-01T00:00:00Z", "2026-08-01T00:00:00Z"), true);
});
