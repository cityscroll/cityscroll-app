import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS,
  SEQRA_INSTITUTIONAL_SIGNAL_SOURCES,
  getInstitutionalSignalSource,
} from "../warehouse/lib/seqra_institutional_signal_sources.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "build_seqra_institutional_signal_adapters.mjs");
const RECEIPT = path.join(ROOT, "warehouse", "receipts", "proof", "seqra_institutional_signal_adapters_latest.json");

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("SEQRA-07 institutional-signal source registry", () => {
  it("declares exactly the card's six adapters (Council, City Record, Community Board, agency, eLobbyist, COELIG)", () => {
    assert.equal(SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS.length, 6);
    assert.deepEqual(new Set(SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS), new Set([
      "nyc_council_legislative_records",
      "nyc_city_record_notices",
      "community_board_positions",
      "agency_position_records",
      "nyc_elobbyist",
      "nys_coelig_lobbying",
    ]));
  });

  it("reuses the SEQRA-01 SODA dataset ids rather than re-declaring them", () => {
    assert.equal(getInstitutionalSignalSource("nyc_elobbyist").dataset_id, "fmf3-knd8");
    assert.equal(getInstitutionalSignalSource("nyc_city_record_notices").dataset_id, "dg92-zbpx");
  });

  it("throws on an unknown source id rather than returning undefined", () => {
    assert.throws(() => getInstitutionalSignalSource("not_a_real_source"), /unknown SEQRA-07 institutional-signal source/);
  });

  it("every non-SODA source is a bounded_discovery_probe, never a claimed stable API", () => {
    for (const sourceId of SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS) {
      const source = SEQRA_INSTITUTIONAL_SIGNAL_SOURCES[sourceId];
      assert.ok(["soda", "bounded_discovery_probe"].includes(source.kind), `${sourceId}: kind`);
    }
  });
});

describe("SEQRA-07 institutional-signal-adapters CLI", () => {
  it("default mode passes the gate over the committed fixtures for all six sources", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SEQRA institutional-signal-adapters gate OK \(\d+ checks, 6 sources\)/);
  });

  it("--check passes against the committed receipt (no drift since the last build)", () => {
    const result = run("--check");
    assert.equal(result.status, 0, result.stderr);
  });

  it("running the builder twice produces a byte-identical receipt", () => {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(RECEIPT, "utf8");

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const secondBytes = readFileSync(RECEIPT, "utf8");

    assert.equal(firstBytes, secondBytes);
  });

  it("the committed receipt asserts resident ingestion is not committed for every source", () => {
    const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
    assert.equal(receipt.gate.resident_ingestion_committed, false);
    for (const sourceId of SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS) {
      assert.equal(receipt.sources[sourceId].resident_ingestion.committed, false, sourceId);
    }
  });

  it("the committed receipt's demo positions are all attributed to a resolved organization (A1)", () => {
    const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
    assert.ok(receipt.demo_positions.length > 0);
    for (const position of receipt.demo_positions) {
      assert.match(position.organization_key, /^organization:/);
      assert.ok(position.source_id);
      assert.ok(position.source_record_id);
    }
  });

  it("the committed receipt's derived signals each carry a rival explanation and suppression rule (A5 / A3)", () => {
    const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
    for (const issue of receipt.demo_issue_preservation.issues) {
      assert.ok(issue.rival_explanation);
      assert.ok(issue.suppression_rule);
    }
    for (const entry of receipt.demo_coalition_continuity.coalitions) {
      assert.ok(entry.rival_explanation);
      assert.ok(entry.suppression_rule);
    }
  });

  it("no misconduct/motive assertion appears anywhere in the committed receipt (negative rule)", () => {
    const raw = readFileSync(RECEIPT, "utf8");
    assert.doesNotMatch(raw, /\b(misconduct (occurred|found|confirmed|detected)|is corrupt\b|engaged in (bribery|collusion|fraud)|is guilty\b|colluded with)\b/i);
  });

  it("rejects an unrecognized flag rather than silently ignoring it", () => {
    const result = run("--bogus");
    assert.notEqual(result.status, 0);
  });
});
