/**
 * WH-04 batch entity-resolution over warehouse tables.
 * Pure identity reuse + optional fixture materialization (no bulk download).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { WAREHOUSE_DIR, catalogExists, duckdbPath } from "../warehouse/lib/catalog.mjs";
import { queryWarehouse } from "../warehouse/lib/query.mjs";
import {
  runErBatch,
  observationFromOcpRow,
  buildVendorStemLinks,
  scoreObservationPairs,
  vendorStem,
  canonicalVendorIdForStem,
  ER_BATCH_VERSION,
  VENDOR_STEM_METHOD,
  DECISION,
  sqlVerifyVendorResolution,
} from "../warehouse/lib/er_batch.mjs";
import {
  MAX_LIVE_OCP_ROWS,
  parseArgs,
} from "../warehouse/scripts/er_batch.mjs";
import {
  vendorStem as erVendorStem,
  generateCandidates,
  scorePair,
} from "../entity_resolution/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROVENANCE_FIXTURE = join(
  WAREHOUSE_DIR,
  "fixtures",
  "er-batch",
  "provenance_lineage.json",
);

function pyBin() {
  const venv = join(WAREHOUSE_DIR, ".venv", "bin", "python");
  return existsSync(venv) ? venv : null;
}

describe("WH-04 pure ER batch (reuse entity_resolution)", () => {
  it("reuses vendorStem identity (same as entity_resolution package)", () => {
    assert.equal(vendorStem("ACME WIDGETS INC"), erVendorStem("ACME WIDGETS INC"));
    assert.equal(
      vendorStem("Acme Widgets Incorporated"),
      vendorStem("ACME WIDGETS INC")
    );
    assert.equal(
      canonicalVendorIdForStem(vendorStem("ACME WIDGETS INC")),
      "vendor:stem:ACME WIDGETS"
    );
  });

  it("collapses Inc/Incorporated OCP rows onto one vendor entity", () => {
    const rows = [
      {
        request_id: "ER001",
        vendor_name: "ACME WIDGETS INC",
        agency_name: "Department of Citywide Administrative Services",
        pin: "P1",
      },
      {
        request_id: "ER002",
        vendor_name: "Acme Widgets Incorporated",
        agency_name: "Department of Citywide Administrative Services",
        pin: "P2",
      },
    ];
    const batch = runErBatch({ ocpRows: rows, now: "2026-08-02T00:00:00.000Z" });
    const vendorLinks = batch.entity_links.filter(
      (l) => l.entity_type === "vendor" && l.decision === DECISION.AUTO_LINK
    );
    assert.equal(vendorLinks.length, 2);
    assert.equal(vendorLinks[0].canonical_entity_id, vendorLinks[1].canonical_entity_id);
    assert.equal(vendorLinks[0].method, VENDOR_STEM_METHOD);
    assert.equal(batch.metrics.unique_vendor_entities, 1);
    assert.ok(batch.metrics.pair_candidates >= 1);
    assert.ok(
      batch.canonical_entities.some((e) => e.id === "vendor:stem:ACME WIDGETS")
    );
    assert.match(batch.resolution_run.model_artifact_hash, /^[a-f0-9]{64}$/);
    assert.equal(batch.resolution_run.gold_version, "not_used");
    assert.equal(batch.resolution_run.feature_version, "pair_features_v2");
    assert.equal(batch.resolution_run.blocking_version, "token_v0_v0");
    assert.equal(batch.resolution_run.policy_version, "conservative_v1");
    assert.deepEqual(JSON.parse(batch.resolution_run.watermarks_json), {});
  });

  it("records append-only supersession lineage when a source link changes", () => {
    const fixture = JSON.parse(readFileSync(PROVENANCE_FIXTURE, "utf8"));
    const prior = runErBatch({
      ocpRows: [{ request_id: fixture.request_id, vendor_name: fixture.prior_vendor_name }],
      now: "2026-08-02T00:00:00.000Z",
    });
    const current = runErBatch({
      ocpRows: [{ request_id: fixture.request_id, vendor_name: fixture.current_vendor_name }],
      priorEntityLinks: prior.entity_links,
      watermarks: fixture.watermarks,
      now: "2026-08-03T00:00:00.000Z",
    });
    assert.equal(current.entity_link_supersessions.length, 1);
    assert.equal(current.entity_link_supersessions[0].superseded_link_id, prior.entity_links[0].id);
    assert.equal(current.entity_link_supersessions[0].superseding_link_id, current.entity_links[0].id);
    assert.equal(current.entity_link_supersessions[0].reason, fixture.expected_supersession_reason);
    assert.equal(current.entity_links[0].supersedes_link_id, prior.entity_links[0].id);
    assert.equal(current.entity_links[0].supersession_reason, fixture.expected_supersession_reason);
    assert.deepEqual(current.provenance.watermarks, fixture.watermarks);
    assert.equal(current.resolution_run.provenance_json.includes("watermarks"), true);
  });

  it("links agencies via canonicalAgency (DoITT/OTI-style alias surface)", () => {
    const rows = [
      {
        request_id: "A1",
        vendor_name: "SOME VENDOR LLC",
        agency_name: "Office of Technology and Innovation",
        pin: "X",
      },
    ];
    const batch = runErBatch({ ocpRows: rows, now: "2026-08-02T00:00:00.000Z" });
    const agency = batch.entity_links.filter((l) => l.entity_type === "agency");
    assert.equal(agency.length, 1);
    assert.match(agency[0].canonical_entity_id, /^agency:id:/);
    assert.equal(agency[0].decision, DECISION.AUTO_LINK);
  });

  it("scores token_v0 candidates with entity_resolution scorePair", () => {
    const obs = [
      observationFromOcpRow({
        request_id: "1",
        vendor_name: "SINERGIA INC",
        agency_name: "DOT",
      }),
      observationFromOcpRow({
        request_id: "2",
        vendor_name: "Sinergia Incorporated",
        agency_name: "DOT",
      }),
    ];
    const pairs = scoreObservationPairs(obs);
    assert.ok(pairs.length >= 1);
    const same = pairs.find((p) => p.decision === "same");
    assert.ok(same, "expected stem-equal pair to score same");
    // Direct package parity
    const cand = generateCandidates(obs, { blocker: "token_v0" });
    assert.ok(cand.length >= 1);
    const scored = scorePair(
      { display_name: "SINERGIA INC", entity_type: "vendor" },
      { display_name: "Sinergia Incorporated", entity_type: "vendor" }
    );
    assert.equal(scored.decision, "same");
  });

  it("cross-links OCP and Doing Business rows that share a vendor stem", () => {
    const batch = runErBatch({
      ocpRows: [
        {
          request_id: "ER001",
          vendor_name: "ACME WIDGETS INC",
          agency_name: "DCAS",
        },
      ],
      doingBusinessRows: [
        { organization_name: "ACME WIDGETS INC", ownership_structure_code: "COR" },
        { organization_name: "UNRELATED HOLDINGS LLC", ownership_structure_code: "LLC" },
      ],
      now: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(batch.metrics.cross_source_stem_hits, 1);
    const acmeLinks = batch.entity_links.filter(
      (l) =>
        l.entity_type === "vendor" &&
        l.canonical_entity_id === "vendor:stem:ACME WIDGETS"
    );
    assert.ok(acmeLinks.length >= 2, "OCP + Doing Business should both link to ACME");
  });

  it("exports verify SQL for the warehouse join view", () => {
    const sql = sqlVerifyVendorResolution({ limit: 10 });
    assert.match(sql, /er_entity_link/);
    assert.match(sql, /ocp_recent_contract_awards/);
    assert.match(sql, /canonical_entity_id/);
  });
});

describe("WH-04 fixtures + capped runner layout", () => {
  it("enforces the 200-row live OCP cap even with a headroom override", () => {
    assert.equal(
      parseArgs(["node", "er_batch.mjs", "--limit", "200"]).limit,
      MAX_LIVE_OCP_ROWS
    );
    assert.throws(
      () =>
        parseArgs([
          "node",
          "er_batch.mjs",
          "--limit",
          "201",
          "--force-headroom",
        ]),
      /live OCP cap of 200/
    );
  });

  it("ships er-batch fixtures, scripts, and verify SQL", () => {
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "fixtures", "er-batch", "ocp_vendor_variants.csv"))
    );
    assert.ok(
      existsSync(
        join(WAREHOUSE_DIR, "fixtures", "er-batch", "doing_business_sample.csv")
      )
    );
    assert.ok(existsSync(PROVENANCE_FIXTURE));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "er_batch.mjs")));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "er_batch_run.py")));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "materialize_er_batch.py")));
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "er_entity_links_verify.sql"))
    );
    assert.ok(existsSync(join(WAREHOUSE_DIR, "lib", "er_batch.mjs")));
    assert.equal(ER_BATCH_VERSION, "wh04_er_batch_v1");
  });
});

/** Spawn with a few retries when the shared warehouse ingest lock is busy. */
function spawnWithLockRetry(cmd, args, opts, attempts = 8) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = spawnSync(cmd, args, opts);
    const out = `${last.stdout || ""}\n${last.stderr || ""}`;
    if (last.status === 0) return last;
    if (!/holds the lock|One job at a time/i.test(out)) return last;
    spawnSync("sleep", ["0.4"], { encoding: "utf8" });
  }
  return last;
}

describe("WH-04 end-to-end fixture materialization", () => {
  it("capped runner materializes queryable er_* views", () => {
    const py = pyBin();
    if (!py) {
      // CI without venv: pure tests above still run.
      return;
    }

    // Ensure OCP awards view exists so er_ocp_vendor_resolved can join.
    // Retry on lock contention (parallel WH-01 scaffold test may hold it).
    const ingest = spawnWithLockRetry(
      py,
      [
        join(WAREHOUSE_DIR, "scripts", "ingest.py"),
        "--dataset",
        "ocp-recent-contract-awards",
        "--from-fixture",
        "--limit",
        "5",
        "--force-headroom",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(ingest.status, 0, ingest.stderr || ingest.stdout);

    const er = spawnWithLockRetry(
      py,
      [
        join(WAREHOUSE_DIR, "scripts", "er_batch_run.py"),
        "--from-fixture",
        "--limit",
        "25",
        "--force-headroom",
        "--snapshot-date",
        "fixture",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(er.status, 0, er.stderr || er.stdout);
    assert.match(er.stdout, /OK/);

    assert.ok(catalogExists(), `expected catalog at ${duckdbPath()}`);

    const counts = queryWarehouse(
      `SELECT 'links' AS k, COUNT(*)::INTEGER AS n FROM er_entity_link
       UNION ALL
       SELECT 'entities', COUNT(*)::INTEGER FROM er_canonical_entity
       UNION ALL
       SELECT 'runs', COUNT(*)::INTEGER FROM er_resolution_run`
    );
    const byK = Object.fromEntries(counts.map((r) => [r.k, Number(r.n)]));
    assert.ok(byK.links >= 2, `expected entity_link rows, got ${byK.links}`);
    assert.ok(byK.entities >= 1, `expected canonical entities, got ${byK.entities}`);
    assert.ok(byK.runs >= 1);

    // Multi-row ACME collapse must appear in SQL.
    const acme = queryWarehouse(
      `SELECT canonical_entity_id, COUNT(*)::INTEGER AS n
       FROM er_entity_link
       WHERE canonical_entity_id = 'vendor:stem:ACME WIDGETS'
         AND decision = 'auto_link'
       GROUP BY 1`
    );
    assert.ok(acme.length >= 1);
    assert.ok(Number(acme[0].n) >= 2, "ACME Inc + Incorporated should share entity");

    // Resolved join view paints vendor ids onto fixture awards when request_ids match.
    // Fixture variants use ER00x ids not in the 5-row OCP sample — check metrics receipt.
    const proof = join(
      WAREHOUSE_DIR,
      "receipts",
      "proof",
      "wh04_er_batch_latest.json"
    );
    assert.ok(existsSync(proof));
    const receipt = JSON.parse(readFileSync(proof, "utf8"));
    assert.equal(receipt.phase, "WH-04");
    assert.ok(receipt.metrics.unique_vendor_entities >= 1);
    assert.ok(receipt.metrics.cross_source_stem_hits >= 1);
    assert.ok(receipt.cpu_discipline.single_job_lock);
    assert.ok(receipt.runner?.cpu_discipline?.single_job_lock);

    // Gold matcher harness still green (no ER package regression).
    const gold = spawnSync(
      "node",
      [
        "entity_resolution/eval/run_metrics.mjs",
        "--gold",
        "entity_resolution/eval/gold_v0.jsonl",
        "--blocker",
        "token_v0",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(gold.status, 0, gold.stderr || gold.stdout);
  });
});
