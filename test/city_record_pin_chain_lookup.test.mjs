import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertCityRecordPinChainServeGate,
  buildMaterializationDoc,
  buildPinChainLookupIndex,
  cityRecordPinChainServeGateFindings,
  loadProductSeedRows,
  lookupPinChainInIndex,
  rowToSodaShape,
} from "../warehouse/lib/city_record_pin_chain_lookup.mjs";
import {
  assertServePublishTwins,
  SERVE_LOOKUP_CONTRACTS,
} from "../warehouse/lib/serve_publish_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("WH-07 City Record PIN-chain serve lookup", () => {
  it("loads verified seed field cases", () => {
    const rows = loadProductSeedRows();
    assert.ok(rows.length >= 3);
    assert.ok(rows.some((r) => r.pin === "07219P0148001R004"));
    assert.ok(rows.some((r) => r.request_id === "20260723031"));
  });

  it("indexes exact PIN siblings and rejects non-procurement types", () => {
    const shaped = rowToSodaShape({
      request_id: "x",
      pin: "81626W0043001",
      type_of_notice_description: "Award",
      start_date: "2026-01-01",
      agency_name: "A",
      short_title: "T",
    });
    assert.equal(shaped.pin, "81626W0043001");
    assert.equal(
      rowToSodaShape({
        request_id: "y",
        pin: "81626W0043001",
        type_of_notice_description: "Changes in Personnel",
      }),
      null,
    );
    const index = buildPinChainLookupIndex([
      shaped,
      {
        request_id: "s",
        pin: "81626W0043001",
        type_of_notice_description: "Solicitation",
        start_date: "2025-12-01",
        agency_name: "A",
        short_title: "T",
      },
    ]);
    const hit = lookupPinChainInIndex("81626W0043001", index);
    assert.equal(hit.hit, true);
    assert.equal(hit.rows.length, 2);
    assert.equal(hit.rows[0].type_of_notice_description, "Solicitation");
  });

  it("serve gate fails empty and accepts verified seed with canaries", () => {
    const emptyFindings = cityRecordPinChainServeGateFindings({
      schema_version: 1,
      mode: "verified_seed",
      materialized_at: "2026-08-18T00:00:00.000Z",
      row_count: 0,
      pin_count: 0,
      rows: [],
    });
    assert.ok(emptyFindings.some((f) => /empty/i.test(f)));

    const seed = loadProductSeedRows();
    const doc = buildMaterializationDoc(seed, {
      mode: "verified_seed",
      now: "2026-08-18T00:00:00.000Z",
      bulkSnapshotDate: "2026-08-05",
    });
    assert.equal(assertCityRecordPinChainServeGate(doc, { now: "2026-08-18T12:00:00.000Z" }), true);
  });

  it("committed site/Worker twins pass the publish contract", () => {
    const site = JSON.parse(
      readFileSync(
        join(ROOT, "site/data/city_record_pin_chain_warehouse_lookup.json"),
        "utf8",
      ),
    );
    const worker = JSON.parse(
      readFileSync(
        join(ROOT, "worker/src/data/city_record_pin_chain_warehouse_lookup.json"),
        "utf8",
      ),
    );
    assertServePublishTwins(
      site,
      worker,
      SERVE_LOOKUP_CONTRACTS.city_record_pin_chain,
      { now: "2026-08-18T12:00:00.000Z" },
    );
    assertCityRecordPinChainServeGate(site, { now: "2026-08-18T12:00:00.000Z" });
  });
});
