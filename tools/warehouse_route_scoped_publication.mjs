#!/usr/bin/env node
/**
 * CLI for owned route-scoped warehouse shard publication (cc-06).
 *
 * Commands:
 *   plan                 — build a local publication plan (no provider I/O)
 *   preflight-readonly   — plan + optional live KV GETs; never puts/deletes
 *   publish              — GO-gated; requires CC06_PUBLISH_EXECUTE_CODE=C6-<8hex>
 *   cleanup              — GO-gated exact-value cleanup; same code env
 *
 * Publishing shards does not enable WAREHOUSE_ROUTE_SCOPED_SHARDS.
 * Live measure/stage remain separate GOs. Never overlap the frozen cc-05
 * measurement window (finish+restore before 06:30Z or run after that window).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWranglerInvoker } from "./lib/wrangler_exec.mjs";
import {
  WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES,
  cleanupWarehouseRouteScopedShards,
  loadShardPublicationLedger,
  loadWarehouseRouteScopedMaterializations,
  persistShardPublicationLedger,
  planWarehouseRouteScopedCleanup,
  planWarehouseRouteScopedPublication,
  preflightWarehouseRouteScopedPublicationReadonly,
  publishWarehouseRouteScopedShards,
} from "./lib/warehouse_route_scoped_publication.mjs";
import { warehouseRouteScopedShardKey } from "../worker/src/lib/warehouse_route_scoped_shards.mjs";
import { WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES } from "../worker/src/lib/warehouse_route_scoped_shards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GO_CODE_RE = /^C6-[0-9a-fA-F]{8}$/;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return `usage:
  node tools/warehouse_route_scoped_publication.mjs plan --revision <40-hex> [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs preflight-readonly --revision <40-hex> [--live-kv] [--health-commit <40-hex>] [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs publish --revision <40-hex> --ledger <path> --attempt-id <id>
      (requires CC06_PUBLISH_EXECUTE_CODE=C6-<8hex> and GO-cc06-A1-publish EXECUTE)
  node tools/warehouse_route_scoped_publication.mjs cleanup --revision <40-hex> --ledger <path>
      (requires CC06_PUBLISH_EXECUTE_CODE=C6-<8hex>; exact-value only; protects --active/--rollback)`;
}

function requireGoCode(command) {
  const raw = process.env.CC06_PUBLISH_EXECUTE_CODE || "";
  if (!GO_CODE_RE.test(raw)) {
    throw new Error(
      `${command} refuses without CC06_PUBLISH_EXECUTE_CODE=C6-<8 hex chars>; `
      + "bare GO-cc06-A1-publish is not a go",
    );
  }
  const hex = raw.slice(3).toLowerCase();
  return `C6-${hex}`;
}

function refuseWindowOverlap() {
  // Soft guard: refuse live publish/cleanup during the frozen cc-05 attach window
  // on 2026-10-20 (06:30Z–09:00Z inclusive of buffer). Override only with
  // CC06_ALLOW_WINDOW_OVERLAP=1 for non-production drills.
  if (process.env.CC06_ALLOW_WINDOW_OVERLAP === "1") return;
  const now = Date.now();
  const start = Date.parse("2026-10-20T06:30:00.000Z");
  const end = Date.parse("2026-10-20T09:00:00.000Z");
  if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end) {
    throw new Error(
      "refusing cc-06 provider mutation during frozen cc-05 window buffer "
      + "(2026-10-20T06:30Z..09:00Z); finish before 06:30Z or run after the window",
    );
  }
}

function writeJson(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const command = process.argv[2];
if (!command || hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(command ? 0 : 2);
}

const revision = arg("--revision");
if (!revision) {
  console.error("--revision <40-hex> is required");
  console.error(usage());
  process.exit(2);
}

const outPath = arg("--out");
const activeRevision = arg("--active");
const rollbackRevision = arg("--rollback");

if (command === "plan") {
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  const summary = {
    schema: plan.schema,
    decision: plan.decision,
    deployed_revision: plan.deployed_revision,
    control_routes: plan.control_routes,
    lookup_routes: plan.lookup_routes,
    planned: plan.planned,
    shards: plan.shards.map((shard) => ({
      route: shard.route,
      key: shard.key,
      value_sha256: shard.value_sha256,
      row_count: shard.row_count,
    })),
    activation: plan.activation,
    abort_rules: plan.abort_rules,
    financial_savings_claimed: false,
  };
  writeJson(outPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (command === "preflight-readonly") {
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  let liveShardValues = null;
  if (hasFlag("--live-kv")) {
    const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
    liveShardValues = {};
    for (const route of WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES) {
      const key = warehouseRouteScopedShardKey(route, revision.toLowerCase());
      try {
        const result = await invoke([
          "kv", "key", "get", key,
          "--binding", "ALERT_STATE",
          "--remote",
          "--config", "worker/wrangler.toml",
          "--text",
        ]);
        const text = String(result?.stdout || "").trim();
        liveShardValues[key] = (!text || text === "Value not found") ? null : text;
      } catch (error) {
        const providerText = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
        if (/\b404:?\s+Not Found\b/.test(providerText) || /\bValue not found\b/i.test(providerText)) {
          liveShardValues[key] = null;
        } else {
          throw error;
        }
      }
    }
  }

  const report = preflightWarehouseRouteScopedPublicationReadonly({
    deployed_revision: revision,
    materializations,
    live_shard_values: liveShardValues,
    flag_binding_present: null,
    health_commit: arg("--health-commit"),
    control_routes: [...WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES],
  });
  writeJson(outPath, report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.outcome === "preflight-readonly-passed" ? 0 : 1);
}

if (command === "publish") {
  refuseWindowOverlap();
  const goCode = requireGoCode("publish");
  const ledgerPath = arg("--ledger");
  const attemptId = arg("--attempt-id");
  if (!ledgerPath) throw new Error("--ledger is required for publish");
  if (!attemptId) throw new Error("--attempt-id is required for publish");

  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
  try {
    const receipt = await publishWarehouseRouteScopedShards({
      plan,
      invoke,
      ledgerPath,
      attempt_id: attemptId,
    });
    const out = { ...receipt, go_code: goCode, ledger: undefined };
    // Persist full ledger separately; stdout keeps receipt without raw shard bodies.
    persistShardPublicationLedger(ledgerPath, receipt.ledger);
    writeJson(outPath, out);
    console.log(JSON.stringify({
      schema: out.schema,
      decision: out.decision,
      deployed_revision: out.deployed_revision,
      planned: out.planned,
      attempted: out.attempted,
      confirmed: out.confirmed,
      shards: out.shards,
      go_code: goCode,
      activation: out.activation,
    }, null, 2));
  } catch (error) {
    if (error?.publication_receipt) {
      console.error(JSON.stringify(error.publication_receipt));
    }
    throw error;
  }
  process.exit(0);
}

if (command === "cleanup") {
  refuseWindowOverlap();
  const goCode = requireGoCode("cleanup");
  const ledgerPath = arg("--ledger");
  if (!ledgerPath) throw new Error("--ledger is required for cleanup");
  const ledger = loadShardPublicationLedger(ledgerPath);
  const ownedValues = {};
  for (const [key, entry] of Object.entries(ledger.entries || {})) {
    if (entry?.value) ownedValues[key] = entry.value;
  }
  const plan = planWarehouseRouteScopedCleanup({
    deployed_revision: revision,
    owned_entries: ledger.entries,
    active_revision: activeRevision || ledger.active_revision,
    rollback_revision: rollbackRevision || ledger.rollback_revision,
  });
  const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
  try {
    const receipt = await cleanupWarehouseRouteScopedShards({
      plan,
      invoke,
      owned_values: ownedValues,
      ledger,
      ledgerPath,
    });
    writeJson(outPath, { ...receipt, go_code: goCode, ledger: undefined });
    console.log(JSON.stringify({
      schema: receipt.schema,
      decision: receipt.decision,
      reason: receipt.reason || null,
      deployed_revision: receipt.deployed_revision,
      planned: receipt.planned,
      attempted: receipt.attempted,
      confirmed: receipt.confirmed,
      actions: receipt.actions,
      go_code: goCode,
    }, null, 2));
  } catch (error) {
    if (error?.publication_receipt) {
      console.error(JSON.stringify(error.publication_receipt));
    }
    throw error;
  }
  process.exit(0);
}

console.error(usage());
process.exit(2);
