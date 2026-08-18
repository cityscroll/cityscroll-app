/**
 * Land ZAP freshness publish loop — canaries, prefer-warehouse gate, drift, bulk lag.
 *
 *   node --test test/land_zap_freshness.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assessLandWarehouseFreshness,
  assessSellFacingDrift,
  assessZapBulkCsvFreshness,
  assertLandCanariesPresent,
  LAND_ZAP_FRESHNESS_CANARIES,
  missingLandCanaries,
  projectIdSet,
  sellFacingIdDelta,
  sodaSellFacingUrl,
} from "../warehouse/lib/zap_freshness.mjs";
import { fetchLandDefaultProjects } from "../tools/lib/batch_precompute_snapshots.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const LOOKUP_WORKER = join(ROOT, "worker/src/data/zap_projects_warehouse_lookup.json");
const KEYWORD = join(ROOT, "worker/src/data/keyword_search_index.json");
const WORKFLOW_FRESHNESS = join(
  ROOT,
  ".github/workflows/land-zap-freshness-refresh.yml",
);
const WORKFLOW_HEARINGS = join(ROOT, ".github/workflows/land-upcoming-hearings.yml");

describe("land ZAP freshness helpers", () => {
  it("names the two field-case canaries", () => {
    assert.deepEqual(
      LAND_ZAP_FRESHNESS_CANARIES.map((c) => c.project_id),
      ["2025Q0331", "2026K0123"],
    );
  });

  it("marks warehouse land default stale when milestone frontier lags", () => {
    const stale = assessLandWarehouseFreshness({
      rows: [
        { project_id: "A", current_milestone_date: "2026-04-24" },
        { project_id: "B", current_milestone_date: "2026-03-01" },
      ],
      now: new Date("2026-08-17T12:00:00Z"),
      bulkMilestoneMax: "2026-04-24",
    });
    assert.equal(stale.fresh, false);
    assert.ok(stale.reasons.some((r) => r.includes("warehouse_milestone_lag")));
    assert.equal(stale.max_milestone_date, "2026-04-24");

    const fresh = assessLandWarehouseFreshness({
      rows: [{ project_id: "C", current_milestone_date: "2026-08-10" }],
      now: new Date("2026-08-17T12:00:00Z"),
    });
    assert.equal(fresh.fresh, true);
  });

  it("fails closed when canaries are absent", () => {
    assert.equal(missingLandCanaries([{ project_id: "2022M0258" }]).length, 2);
    assert.throws(
      () => assertLandCanariesPresent([{ project_id: "2022M0258" }]),
      /2025Q0331/,
    );
  });

  it("detects sell-facing drift above threshold and canary misses", () => {
    const delta = sellFacingIdDelta(
      ["2025Q0331", "2026K0123", "X1", "X2", "X3", "X4", "X5", "X6"],
      ["2022M0258"],
    );
    assert.equal(delta.missing_count, 8);
    const assessment = assessSellFacingDrift(delta);
    assert.equal(assessment.ok, false);
    assert.ok(assessment.reasons.some((r) => r.includes("missing_")));
    assert.ok(assessment.canaries_missing.some((c) => c.project_id === "2025Q0331"));
  });

  it("detects bulk CSV vs live SODA milestone lag", () => {
    const assessment = assessZapBulkCsvFreshness({
      bulkLastModified: "Tue, 26 May 2026 16:35:56 GMT",
      bulkMilestoneMax: "2026-04-24",
      liveMilestoneMax: "2026-07-03",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    assert.equal(assessment.stale, true);
    assert.ok(assessment.rematerialize.includes("zap-projects"));
    assert.ok(assessment.rematerialize.includes("--bulk"));
  });

  it("builds a sell-facing SODA URL over the public_status universe", () => {
    const url = sodaSellFacingUrl({ limit: 50 });
    assert.match(url, /hgx4-8ukb\.json/);
    assert.match(url, /In(\+|%20)Public(\+|%20)Review/);
    assert.match(url, /Filed/);
    assert.match(url, /(?:\$|%24)limit=50/);
  });
});

describe("prefer-warehouse freshness gate", () => {
  it("falls through to SODA when warehouse prefer is disabled", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        async json() {
          return [
            {
              project_id: "SODA1",
              project_name: "From SODA",
              project_status: "Active",
              public_status: "In Public Review",
              current_milestone_date: "2026-08-01",
            },
          ];
        },
      };
    };
    const rows = await fetchLandDefaultProjects(fetchImpl, {
      preferWarehouse: false,
      now: new Date("2026-08-17T12:00:00Z"),
    });
    assert.equal(rows[0].project_id, "SODA1");
    assert.equal(rows[0].lookup_path, "soda");
    assert.ok(calls.length >= 1);
  });
});

describe("committed land freshness publish loop", () => {
  it("ships canaries in the sell-facing WH-05 twin lookup", () => {
    assert.ok(existsSync(LOOKUP), "site lookup missing — refresh with --from-soda");
    assert.ok(existsSync(LOOKUP_WORKER), "worker lookup twin missing");
    const site = JSON.parse(readFileSync(LOOKUP, "utf8"));
    const worker = JSON.parse(readFileSync(LOOKUP_WORKER, "utf8"));
    assert.deepEqual(site.rows, worker.rows);
    assertLandCanariesPresent(site);
    for (const canary of LAND_ZAP_FRESHNESS_CANARIES) {
      const row = site.rows.find((r) => r.project_id === canary.project_id);
      assert.ok(row, canary.project_id);
      assert.match(String(row.project_name || ""), /Greenpoint|Bedford/i);
    }
  });

  it("indexes both canaries in the land keyword family", () => {
    assert.ok(existsSync(KEYWORD), "keyword_search_index missing");
    const index = JSON.parse(readFileSync(KEYWORD, "utf8"));
    const landDocs = index.families?.land?.documents || [];
    const ids = new Set(
      landDocs.map((doc) =>
        String(doc.object_ref || "").replace(/^land_use_project:/, ""),
      ),
    );
    for (const canary of LAND_ZAP_FRESHNESS_CANARIES) {
      assert.ok(
        ids.has(canary.project_id),
        `keyword land family missing ${canary.project_id}`,
      );
    }
  });

  it("publishes land upcoming hearings through verified auto-merge (not artifact-only)", () => {
    const yml = readFileSync(WORKFLOW_HEARINGS, "utf8");
    assert.match(yml, /contents:\s*write/);
    assert.match(yml, /create-pull-request/);
    assert.match(yml, /automation\/land-upcoming-hearings/);
    assert.match(yml, /upload-artifact/);
    assert.match(yml, /generated_at did not advance/);
    assert.match(yml, /gh pr merge[\s\S]*--auto[\s\S]*--match-head-commit/);
  });

  it("schedules WH-05 + keyword refresh from SODA with a publish PR", () => {
    const yml = readFileSync(WORKFLOW_FRESHNESS, "utf8");
    assert.match(yml, /refresh_land_zap_freshness\.mjs/);
    assert.match(yml, /create-pull-request/);
    assert.match(yml, /automation\/land-zap-freshness-refresh/);
    assert.match(yml, /--against-live/);
  });
});
