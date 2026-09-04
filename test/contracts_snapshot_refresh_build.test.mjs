import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mergeResidentSnapshotRefreshEvidence } from "../tools/lib/resident_snapshot_refresh_receipt.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("--refresh-resident-snapshots is a recognized boolean build flag", () => {
  const source = read("tools/build_cloudflare_pages.mjs");
  assert.match(
    source,
    /key === "refresh-decision-outcomes" \|\| key === "refresh-resident-snapshots"/,
  );
  assert.match(source, /refreshResidentSnapshots = Boolean\(args\["refresh-resident-snapshots"\]\)/);
});

test("production refresh mode invokes the Money acquisition before dependent materialization", () => {
  const source = read("tools/build_cloudflare_pages.mjs");
  const refreshBlock = source.indexOf("if (refreshResidentSnapshots)");
  const moneyOnly = source.indexOf('"build_batch_precompute_snapshots.mjs", ["--money-only"]');
  const freshnessGuard = source.indexOf("check_money_snapshot_freshness.mjs");
  const derivedBoundary = source.indexOf('"derived_json_build_boundary.mjs"');
  assert.ok(refreshBlock >= 0, "refresh-resident-snapshots block is missing");
  assert.ok(
    refreshBlock < moneyOnly && moneyOnly < freshnessGuard && freshnessGuard < derivedBoundary,
    "Money acquisition and its freshness guard must run before derived_json_build_boundary.mjs",
  );
});

test("the resident-snapshot refresh step fails the build like every other build step (no error suppression)", () => {
  const source = read("tools/build_cloudflare_pages.mjs");
  const block = source.slice(
    source.indexOf("if (refreshResidentSnapshots)"),
    source.indexOf("const graphTool"),
  );
  // runNode()/run() already exit the process on a nonzero status; this step
  // must use that shared path, not a try/catch that could swallow a failure.
  assert.match(block, /runNode\(sourceDir, "build_batch_precompute_snapshots\.mjs", \["--money-only"\]\)/);
  assert.match(block, /runNode\(sourceDir, "check_money_snapshot_freshness\.mjs"/);
  assert.doesNotMatch(block, /try\s*{/);
});

test("the resident-snapshot refresh step writes into the existing generation-output receipt", () => {
  const source = read("tools/build_cloudflare_pages.mjs");
  assert.match(source, /generation-output-receipt\.json/);
  assert.match(source, /mergeResidentSnapshotRefreshEvidence\(/);
  // Written after build_public_site.mjs, which is what (re)creates that receipt.
  const publicSite = source.indexOf('"build_public_site.mjs"');
  const merge = source.indexOf("mergeResidentSnapshotRefreshEvidence(generationReceipt");
  assert.ok(publicSite >= 0 && publicSite < merge);
});

test("release evidence contains the deployed Contracts vintage, without disturbing existing receipt fields", () => {
  const generationReceipt = {
    schema: "cityscroll.generation-output-receipt.v1",
    boundary: "public-site-generation",
    status: "passed",
    source_commit_sha: "a".repeat(40),
    expected_artifacts: ["_site/index.html"],
    findings: [],
    generated_at: "2026-09-04T12:00:00.000Z",
  };
  const freshnessEvidence = {
    schema: "cityscroll.contracts_snapshot_freshness.v1",
    snapshot_path: "site/data/money_default_open.json",
    ok: true,
    freshnessState: "fresh",
    sourceVintage: "2026-09-04",
    rowCount: 40,
    maxAgeMs: 36 * 60 * 60 * 1000,
    checkedAt: "2026-09-04T12:05:00.000Z",
    findings: [],
  };
  const merged = mergeResidentSnapshotRefreshEvidence(generationReceipt, { contracts: freshnessEvidence });
  assert.equal(merged.resident_snapshot_refresh.contracts.sourceVintage, "2026-09-04");
  assert.equal(merged.resident_snapshot_refresh.contracts.freshnessState, "fresh");
  // Every pre-existing generation-output-receipt field survives unchanged.
  assert.equal(merged.schema, generationReceipt.schema);
  assert.equal(merged.status, "passed");
  assert.deepEqual(merged.expected_artifacts, generationReceipt.expected_artifacts);
});

test("--refresh-resident-snapshots is threaded through the shared build-site action", () => {
  const action = read(".github/actions/build-site/action.yml");
  assert.match(action, /refresh-resident-snapshots:\n\s+description:/);
  assert.match(action, /REFRESH_RESIDENT_SNAPSHOTS: \$\{\{ inputs\.refresh-resident-snapshots \}\}/);
  assert.match(action, /if \[ "\$REFRESH_RESIDENT_SNAPSHOTS" = "true" \]; then/);
  assert.match(action, /args\+=\(--refresh-resident-snapshots\)/);
});
