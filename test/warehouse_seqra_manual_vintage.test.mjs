import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MANUAL_VINTAGE_CROSSWALK,
  compareThresholdFact,
  crosswalkEntriesForTopic,
  getManualVintage,
  listManualVintages,
  resolveManualVintageForReview,
} from "../warehouse/lib/seqra_manual_vintage.mjs";

describe("seqra_manual_vintage: resolveManualVintageForReview", () => {
  it("resolves a 2019 CEQR review to the 2014 edition", () => {
    const result = resolveManualVintageForReview({ environmentalRegime: "CEQR", referenceDate: "2019-06-01" });
    assert.equal(result.status, "resolved");
    assert.equal(result.vintage.manual_vintage_id, "nyc_ceqr_technical_manual_2014");
  });

  it("resolves a 2024 CEQR review to the 2020 edition", () => {
    const result = resolveManualVintageForReview({ environmentalRegime: "CEQR", referenceDate: "2024-01-01" });
    assert.equal(result.status, "resolved");
    assert.equal(result.vintage.manual_vintage_id, "nyc_ceqr_technical_manual_2020");
  });

  it("returns unknown_vintage rather than guessing when no window covers the date", () => {
    const result = resolveManualVintageForReview({ environmentalRegime: "CEQR", referenceDate: "1999-01-01" });
    assert.equal(result.status, "unknown_vintage");
    assert.equal(result.vintage, null);
  });

  it("rejects an unrecognized environmentalRegime rather than silently returning nothing", () => {
    assert.throws(() => resolveManualVintageForReview({ environmentalRegime: "CEQA", referenceDate: "2024-01-01" }));
  });
});

describe("seqra_manual_vintage: compareThresholdFact (negative rule: no cross-vintage fallback)", () => {
  it("compares a shadows fact against the 2014 edition's own threshold", () => {
    const result = compareThresholdFact({
      manualVintageId: "nyc_ceqr_technical_manual_2014",
      technicalTopic: "shadows",
      factType: "open_space_shadow_duration",
      normalizedValue: 0.22,
    });
    assert.equal(result.status, "compared");
    assert.equal(result.exceeds_threshold, false); // 0.22 does not exceed the 2014 edition's >0.25 threshold
  });

  it("compares the identical fact against the 2020 edition and gets a different verdict", () => {
    const result = compareThresholdFact({
      manualVintageId: "nyc_ceqr_technical_manual_2020",
      technicalTopic: "shadows",
      factType: "open_space_shadow_duration",
      normalizedValue: 0.22,
    });
    assert.equal(result.status, "compared");
    assert.equal(result.exceeds_threshold, true); // 0.22 exceeds the 2020 edition's >0.2 threshold
  });

  it("never falls back to another vintage's definition when the named vintage has none for this topic/fact_type", () => {
    const result = compareThresholdFact({
      manualVintageId: "nys_seqr_handbook_2020",
      technicalTopic: "shadows",
      factType: "open_space_shadow_duration",
      normalizedValue: 0.22,
    });
    assert.equal(result.status, "no_threshold_definition_for_vintage");
    assert.equal(result.exceeds_threshold, null);
  });

  it("requires an explicit manualVintageId (no default, no implicit current)", () => {
    assert.throws(() => compareThresholdFact({ technicalTopic: "shadows", factType: "open_space_shadow_duration", normalizedValue: 0.22 }));
  });
});

describe("seqra_manual_vintage: registry and crosswalk", () => {
  it("lists only CEQR vintages when filtered by regime", () => {
    const vintages = listManualVintages({ environmentalRegime: "CEQR" });
    assert.ok(vintages.every((v) => v.environmental_regime === "CEQR"));
    assert.ok(vintages.length >= 2);
  });

  it("throws for an unknown manual_vintage_id rather than returning undefined", () => {
    assert.throws(() => getManualVintage("not_a_real_vintage"));
  });

  it("documents the shadows and transportation crosswalks between the two recorded CEQR editions", () => {
    assert.ok(MANUAL_VINTAGE_CROSSWALK.length >= 2);
    const shadowsEntries = crosswalkEntriesForTopic("shadows");
    assert.equal(shadowsEntries.length, 1);
    assert.equal(shadowsEntries[0].from_vintage_id, "nyc_ceqr_technical_manual_2014");
    assert.equal(shadowsEntries[0].to_vintage_id, "nyc_ceqr_technical_manual_2020");
  });
});
