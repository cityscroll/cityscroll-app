import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEQRA_SOURCE_REGISTRY, getSeqraSourceRegistryEntry, seqraSourceRegistryByTier } from "../warehouse/lib/seqra_source_registry.mjs";
import { SEQRA_SODA_SOURCE_CONFIG, SEQRA_SODA_SOURCE_IDS } from "../warehouse/lib/seqra_soda_source_config.mjs";

const REQUIRED_FIELDS = [
  "source_id", "source_name", "publisher", "jurisdiction_level", "environmental_regime",
  "access_type", "base_url", "dataset_identifier", "coverage_start", "coverage_end",
  "update_frequency", "observed_latency", "parser_version", "last_success_at", "last_row_count",
  "last_content_hash", "known_gaps",
];

describe("SEQRA source registry", () => {
  it("carries every commission-required SOURCE RECEIPTS field on each entry", () => {
    for (const entry of SEQRA_SOURCE_REGISTRY) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `${entry.source_id} missing ${field}`);
      }
      assert.ok(entry.known_gaps.length > 0, `${entry.source_id} must document at least one known gap`);
    }
  });

  it("has no duplicate source_id", () => {
    const ids = SEQRA_SOURCE_REGISTRY.map((entry) => entry.source_id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("registers no California/CEQA source: every entry resolves to NYS or NYC and SEQRA or CEQR", () => {
    for (const entry of SEQRA_SOURCE_REGISTRY) {
      assert.ok(["NYS", "NYC"].includes(entry.jurisdiction_level), `${entry.source_id} has an out-of-scope jurisdiction_level`);
      assert.ok(["SEQRA", "CEQR"].includes(entry.environmental_regime), `${entry.source_id} has an out-of-scope environmental_regime`);
    }
  });

  it("keeps the current and historical DEC Environmental Notice Bulletin as separate registry entries", () => {
    assert.ok(getSeqraSourceRegistryEntry("nys_dec_enb_current"));
    assert.ok(getSeqraSourceRegistryEntry("nys_dec_enb_historical_archive"));
    assert.notEqual(
      getSeqraSourceRegistryEntry("nys_dec_enb_current").base_url,
      getSeqraSourceRegistryEntry("nys_dec_enb_historical_archive").base_url,
    );
  });

  it("every soda_api access_type entry has a matching SODA query config, and vice versa", () => {
    const sodaEntries = SEQRA_SOURCE_REGISTRY.filter((entry) => entry.access_type === "soda_api").map((entry) => entry.source_id);
    assert.deepEqual([...sodaEntries].sort(), [...SEQRA_SODA_SOURCE_IDS].sort());
    for (const sourceId of SEQRA_SODA_SOURCE_IDS) {
      assert.ok(SEQRA_SODA_SOURCE_CONFIG[sourceId].datasetId);
    }
  });

  it("groups registry entries by the commission's four tiers", () => {
    const byTier = seqraSourceRegistryByTier();
    assert.ok(byTier[1].includes("ceqr_projects"));
    assert.ok(byTier[2].includes("ceqr_access"));
    assert.ok(byTier[3].includes("spatial_implementation_context"));
    assert.ok(byTier[4].includes("nyscef"));
  });
});
