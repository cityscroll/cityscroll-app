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
import { withScratchWarehouseRoot } from "./helpers/scratch_warehouse_root.mjs";
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
  sqlWarehouseOcpSlice,
  pinnedOcpSnapshotFromReceipt,
  batchReportFromMetrics,
  promotionDecision,
  identityPublicationFindings,
  buildErBatchCheckpoint,
  erBatchCheckpointFindings,
  MAX_LIVE_OCP_ROWS as LIB_LIVE_CAP,
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

  it("keeps accepted same links evidenced and unresolved pairs unpublished as identity", () => {
    const batch = runErBatch({
      ocpRows: [
        {
          request_id: "ER001",
          vendor_name: "ACME WIDGETS INC",
          agency_name: "DCAS",
        },
        {
          request_id: "ER002",
          vendor_name: "Acme Widgets Incorporated",
          agency_name: "DCAS",
        },
        {
          request_id: "ER003",
          vendor_name: "UNRELATED HOLDINGS LLC",
          agency_name: "DOT",
        },
      ],
      now: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(identityPublicationFindings(batch).length, 0);
    assert.ok(batch.metrics.pair_same >= 1);
    assert.ok(batch.metrics.unresolved === batch.metrics.pair_unresolved);
    const sameLinks = batch.entity_links.filter((link) => {
      const evidence = JSON.parse(link.evidence_json);
      return evidence.match === "pair_same";
    });
    for (const link of sameLinks) {
      const evidence = JSON.parse(link.evidence_json);
      assert.ok(evidence.left_source_record_id);
      assert.ok(evidence.right_source_record_id);
      assert.ok(evidence.stem);
    }
    for (const pair of batch.pair_receipts) {
      if (pair.decision === "unresolved" || pair.decision === "different") {
        const leaked = batch.entity_links.some((link) => {
          const evidence = JSON.parse(link.evidence_json);
          return (
            evidence.match === "pair_same" &&
            evidence.left_source_record_id === pair.left_source_record_id &&
            evidence.right_source_record_id === pair.right_source_record_id
          );
        });
        assert.equal(leaked, false);
      }
    }
    const leakedUnresolved = identityPublicationFindings({
      entity_links: [
        {
          id: "link_bad",
          decision: DECISION.AUTO_LINK,
          source_record_id: "ocp:1",
          evidence_json: JSON.stringify({
            match: "pair_same",
            left_source_record_id: "ocp:1",
            right_source_record_id: "ocp:2",
          }),
        },
      ],
      pair_receipts: [
        {
          decision: "unresolved",
          left_source_record_id: "ocp:1",
          right_source_record_id: "ocp:2",
        },
      ],
    });
    assert.ok(leakedUnresolved.length >= 1);
  });

  it("pins warehouse replay to a WH-02 receipt and keeps promotion blocked", () => {
    const snapshot = pinnedOcpSnapshotFromReceipt(
      {
        snapshot_date: "2026-08-05",
        socrata_dataset_id: "qyyg-4tf5",
        source_contract_id: "ocp-recent-contract-awards",
        raw: { sha256: "a".repeat(64), row_count: 53251, mode: "soda_bulk" },
        parquet: { row_count: 53251 },
      },
      "warehouse/receipts/proof/ocp-recent-contract-awards_bulk_latest.json"
    );
    assert.equal(snapshot.source_row_count, 53251);
    assert.equal(snapshot.source_snapshot_hash, "a".repeat(64));
    const sql = sqlWarehouseOcpSlice("ocp_recent_contract_awards", 200);
    assert.match(sql, /ORDER BY start_date DESC NULLS LAST/);
    assert.match(sql, /CAST\(request_id AS VARCHAR\) DESC/);
    assert.match(sql, /LIMIT 200/);
    const report = batchReportFromMetrics(
      { pair_candidates: 562, pair_same: 45, pair_unresolved: 517, pair_different: 0 },
      1453.742
    );
    assert.deepEqual(report, {
      candidates: 562,
      accepted: 45,
      unresolved: 517,
      rejected: 0,
      runtime_ms: 1453.742,
    });
    assert.equal(promotionDecision({ limit: 200 }).allowed, false);
    assert.equal(promotionDecision({ limit: 201 }).allowed, false);
    assert.equal(
      promotionDecision({ limit: 201, precisionReviewBeyondCap: true }).allowed,
      true
    );
    assert.equal(LIB_LIVE_CAP, 200);
  });

  it("refuses to resume when the source snapshot hash changed", () => {
    const snapshot = {
      source_snapshot_hash: "b".repeat(64),
      snapshot_date: "2026-08-05",
    };
    const checkpoint = buildErBatchCheckpoint({
      snapshot: { ...snapshot, source_snapshot_hash: "c".repeat(64) },
      limit: 200,
      metrics: { pair_candidates: 1, pair_same: 0, pair_unresolved: 1, pair_different: 0 },
      query: sqlWarehouseOcpSlice("ocp_recent_contract_awards", 200),
      created_at: "2026-08-05T00:00:00.000Z",
    });
    const findings = erBatchCheckpointFindings(checkpoint, {
      snapshot,
      limit: 200,
    });
    assert.ok(findings.some((line) => /snapshot hash changed/.test(line)));
  });
});

describe("WH-04 fixtures + capped runner layout", () => {
  it("enforces the 200-row live OCP cap even with a headroom override", () => {
    assert.equal(
      parseArgs(["node", "er_batch.mjs", "--limit", "200"]).limit,
      MAX_LIVE_OCP_ROWS
    );
    assert.equal(
      parseArgs(["node", "er_batch.mjs", "--limit", "200", "--resume"]).resume,
      true
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
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "scripts", "verify_er_batch_receipt.py"))
    );
    assert.equal(ER_BATCH_VERSION, "wh04_er_batch_v1");
  });

  it("verifies the committed 200-row receipt without requiring local parquet", () => {
    const python = pyBin() || "python3";
    const r = spawnSync(
      python,
      [join(WAREHOUSE_DIR, "scripts", "verify_er_batch_receipt.py"), "--check"],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(r.status, 0, `${r.stdout || ""}\n${r.stderr || ""}`);
    assert.match(`${r.stdout || ""}\n${r.stderr || ""}`, /OK WH-04 receipt verified/);
    assert.match(`${r.stdout || ""}\n${r.stderr || ""}`, /not present in this checkout/);
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

    withScratchWarehouseRoot(() => {
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
      { cwd: ROOT, encoding: "utf8", env: { ...process.env } }
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
      { cwd: ROOT, encoding: "utf8", env: { ...process.env } }
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
    // er_batch_run.py writes its fixture receipt beside the repository warehouse
    // directory, not under the scratch data root.
    const proof = join(WAREHOUSE_DIR, "receipts", "wh04_er_batch_fixture.json");
    assert.ok(existsSync(proof));
    const receipt = JSON.parse(readFileSync(proof, "utf8"));
    assert.equal(receipt.phase, "WH-04");
    assert.equal(receipt.mode, "fixture");
    assert.equal(receipt.promotion.allowed, false);
    assert.equal(receipt.publication_gate.unresolved_published_as_identity, false);
    assert.match(receipt.source_snapshot.source_snapshot_hash, /^[a-f0-9]{64}$/);
    assert.equal(receipt.batch_report.candidates, receipt.metrics.pair_candidates);
    assert.ok(receipt.metrics.unique_vendor_entities >= 1);
    assert.ok(receipt.metrics.cross_source_stem_hits >= 1);
    assert.ok(receipt.cpu_discipline.single_job_lock);
    assert.ok(receipt.cpu_discipline.resumable);
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
});
