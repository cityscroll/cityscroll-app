#!/usr/bin/env node
/**
 * WH-02 ops: detect when the committed ZAP projects bulk CSV receipt lags live
 * SODA (Last-Modified / milestone frontier). Extends the existing bulk runner —
 * does not invent a parallel scaffold.
 *
 * Usage:
 *   node tools/check_zap_bulk_freshness.mjs            # compare receipt vs live
 *   node tools/check_zap_bulk_freshness.mjs --check     # same; exit 1 when stale
 *   node tools/check_zap_bulk_freshness.mjs --offline   # receipt age only
 *   node tools/check_zap_bulk_freshness.mjs --rematerialize-if-stale
 *       # when stale and warehouse/.venv exists, re-run ingest --bulk --ack-large
 *       # for zap-projects (then zap-bbl). Honors headroom / lock like WH-02.
 *
 * When stale, print the exact ingest rematerialize command for zap-projects
 * (and zap-bbl when that receipt is also present).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, WAREHOUSE_DIR } from "../warehouse/lib/catalog.mjs";
import {
  assessZapBulkCsvFreshness,
  bulkReceiptLastModified,
  bulkReceiptMilestoneMax,
  normalizeSodaMilestoneDay,
  readZapProjectsBulkReceipt,
  sodaLiveMilestoneMaxUrl,
  ZAP_BBL_BULK_RECEIPT,
  ZAP_PROJECTS_BULK_RECEIPT,
} from "../warehouse/lib/zap_freshness.mjs";

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    offline: argv.includes("--offline"),
    rematerializeIfStale: argv.includes("--rematerialize-if-stale"),
  };
}

async function fetchLiveMilestoneMax(fetchImpl = fetch) {
  const url = sodaLiveMilestoneMaxUrl();
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`live SODA milestone probe HTTP ${response.status}`);
  }
  const body = await response.json();
  const raw = Array.isArray(body) ? body[0]?.max_milestone : null;
  return normalizeSodaMilestoneDay(raw);
}

function bblRematerializeHint() {
  if (!existsSync(ZAP_BBL_BULK_RECEIPT)) return null;
  return (
    "warehouse/.venv/bin/python warehouse/scripts/ingest.py " +
    "--dataset zap-bbl --bulk --ack-large --write-sample 25"
  );
}

function runBulkIngest(datasetId) {
  const py = path.join(WAREHOUSE_DIR, ".venv", "bin", "python");
  if (!existsSync(py)) {
    return {
      ok: false,
      skipped: true,
      reason: "warehouse_venv_missing",
      dataset: datasetId,
    };
  }
  const result = spawnSync(
    py,
    [
      path.join(WAREHOUSE_DIR, "scripts", "ingest.py"),
      "--dataset",
      datasetId,
      "--bulk",
      "--ack-large",
      "--write-sample",
      "25",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    skipped: false,
    dataset: datasetId,
    status: result.status,
    stdout_tail: String(result.stdout || "").slice(-2000),
    stderr_tail: String(result.stderr || "").slice(-2000),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const receipt = readZapProjectsBulkReceipt();
  if (!receipt) {
    const msg = `missing bulk receipt ${path.relative(REPO_ROOT, ZAP_PROJECTS_BULK_RECEIPT)}`;
    if (args.check) {
      console.error(msg);
      process.exit(1);
    }
    console.log(JSON.stringify({ status: "missing_receipt", error: msg }, null, 2));
    return;
  }

  let liveMilestoneMax = null;
  if (!args.offline) {
    try {
      liveMilestoneMax = await fetchLiveMilestoneMax();
    } catch (err) {
      if (args.check) {
        console.error(`zap bulk freshness live probe failed: ${err.message || err}`);
        process.exit(1);
      }
      console.log(
        JSON.stringify(
          {
            status: "live_probe_failed",
            error: String(err && err.message ? err.message : err),
            bulk_last_modified: bulkReceiptLastModified(receipt),
            bulk_milestone_max: bulkReceiptMilestoneMax(receipt),
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  const assessment = assessZapBulkCsvFreshness({
    bulkLastModified: bulkReceiptLastModified(receipt),
    bulkMilestoneMax: bulkReceiptMilestoneMax(receipt),
    liveMilestoneMax,
    now: new Date(),
  });

  const bblHint = bblRematerializeHint();
  const payload = {
    status: assessment.stale ? "stale" : "fresh",
    dataset: "zap-projects",
    receipt: path.relative(REPO_ROOT, ZAP_PROJECTS_BULK_RECEIPT),
    observed_at: receipt.observed_at || null,
    ...assessment,
    also_refresh_zap_bbl: bblHint,
  };

  if (args.rematerializeIfStale && assessment.stale) {
    const projects = runBulkIngest("zap-projects");
    payload.rematerialize_projects = projects;
    if (projects.ok && bblHint) {
      payload.rematerialize_bbl = runBulkIngest("zap-bbl");
    }
    // Re-read receipt after a successful projects pull.
    if (projects.ok) {
      const refreshed = readZapProjectsBulkReceipt();
      payload.post_rematerialize = assessZapBulkCsvFreshness({
        bulkLastModified: bulkReceiptLastModified(refreshed),
        bulkMilestoneMax: bulkReceiptMilestoneMax(refreshed),
        liveMilestoneMax,
        now: new Date(),
      });
      payload.status = payload.post_rematerialize.stale ? "stale_after_rematerialize" : "fresh";
    }
  }

  console.log(JSON.stringify(payload, null, 2));

  if (args.check && (payload.status === "stale" || payload.status === "stale_after_rematerialize")) {
    console.error(
      [
        "ZAP projects bulk CSV lags live SODA.",
        `Reasons: ${assessment.reasons.join("; ")}`,
        `Re-pull: ${assessment.rematerialize}`,
        bblHint ? `Then BBL: ${bblHint}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
