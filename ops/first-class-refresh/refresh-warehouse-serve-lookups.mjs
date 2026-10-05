#!/usr/bin/env node
/**
 * Refresh the warehouse serve lookups that CI gates with a wall-clock age
 * contract (and the two digests that must stay coherent with ZAP twins).
 *
 * Hosted first-class refresh cannot run these builders: the runner has no
 * DuckDB catalog. The warehouse-held half of the refresh
 * (run-warehouse-refresh.sh) invokes this after --run-due so every lookup is
 * rematerialized well inside its serve max age instead of aging out silently.
 *
 * Usage:
 *   node ops/first-class-refresh/refresh-warehouse-serve-lookups.mjs
 *   node ops/first-class-refresh/refresh-warehouse-serve-lookups.mjs --plan
 *   node ops/first-class-refresh/refresh-warehouse-serve-lookups.mjs --force
 *   node ops/first-class-refresh/refresh-warehouse-serve-lookups.mjs --source-dir <tmp>
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SERVE_LOOKUP_CONTRACTS,
  servePublishFindings,
} from "../../warehouse/lib/serve_publish_contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");
export const RECEIPT_PATH = ".artifacts/warehouse-serve-lookup-refresh-receipt.json";

/** Fraction of max_age_days at which a serve lookup becomes due. */
export const REFRESH_FRACTION = 0.5;

/**
 * The seven builders the static-standards "Warehouse serve refresh-to-publish
 * contract" step checks, plus payroll (same serve-publish family).
 */
export const WAREHOUSE_SERVE_LOOKUPS = Object.freeze([
  Object.freeze({
    id: "ocp_awards",
    kind: "serve",
    contract_id: "ocp_awards",
    builder: "tools/build_ocp_warehouse_lookup.mjs",
    site_path: "site/data/ocp_awards_warehouse_lookup.json",
    worker_path: null,
  }),
  Object.freeze({
    id: "zap_projects",
    kind: "serve",
    contract_id: "zap_projects",
    builder: "tools/build_zap_warehouse_lookup.mjs",
    builder_args: Object.freeze(["--from-soda"]),
    site_path: "site/data/zap_projects_warehouse_lookup.json",
    worker_path: "worker/src/data/zap_projects_warehouse_lookup.json",
  }),
  Object.freeze({
    id: "zap_bbl",
    kind: "serve",
    contract_id: "zap_bbl",
    builder: "tools/build_zap_bbl_warehouse_lookup.mjs",
    builder_args: Object.freeze(["--all"]),
    site_path: "site/data/zap_bbl_warehouse_lookup.json",
    worker_path: "worker/src/data/zap_bbl_warehouse_lookup.json",
  }),
  Object.freeze({
    id: "doing_business",
    kind: "serve",
    contract_id: "doing_business",
    builder: "tools/build_doing_business_warehouse_lookup.mjs",
    site_path: "site/data/doing_business_warehouse_lookup.json",
    worker_path: "worker/src/data/doing_business_warehouse_lookup.json",
  }),
  Object.freeze({
    id: "city_record_pin_chain",
    kind: "serve",
    contract_id: "city_record_pin_chain",
    builder: "tools/build_city_record_pin_chain_lookup.mjs",
    site_path: "site/data/city_record_pin_chain_warehouse_lookup.json",
    worker_path: "worker/src/data/city_record_pin_chain_warehouse_lookup.json",
  }),
  Object.freeze({
    id: "e_designation",
    kind: "digest",
    builder: "tools/build_e_designation_digest.mjs",
    site_path: "site/data/e_designation_project_digest.json",
    after: Object.freeze(["zap_projects", "zap_bbl"]),
  }),
  Object.freeze({
    id: "later_housing_activity",
    kind: "digest",
    builder: "tools/build_later_housing_activity.mjs",
    site_path: "site/data/later_housing_activity.json",
    after: Object.freeze(["zap_projects", "zap_bbl"]),
  }),
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function serveAgeDays(doc, contract, now = new Date()) {
  const field = contract?.timestamp_field || "materialized_at";
  const stamped = Date.parse(String(doc?.[field] || ""));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(stamped) || !Number.isFinite(nowMs)) return null;
  return (nowMs - stamped) / 86_400_000;
}

export function dueThresholdDays(contract, fraction = REFRESH_FRACTION) {
  const max = Number(contract?.max_age_days);
  if (!Number.isFinite(max) || max <= 0) return null;
  return max * fraction;
}

/**
 * Decide whether one serve lookup should rematerialize.
 * A lookup is due when its serve age exceeds half its max age (well inside the
 * CI limit), when the stamp is already over the limit, or when --force is set.
 */
export function isServeLookupDue(entry, options = {}) {
  const root = options.root || REPO_ROOT;
  const now = options.now || new Date();
  const force = Boolean(options.force);
  if (force) return { due: true, reason: "force" };
  if (entry.kind === "digest") {
    return { due: false, reason: "digest_waits_on_dependencies" };
  }
  const contract = SERVE_LOOKUP_CONTRACTS[entry.contract_id];
  if (!contract) return { due: false, reason: "missing_contract" };
  const sitePath = join(root, entry.site_path);
  if (!existsSync(sitePath)) return { due: true, reason: "missing_artifact" };
  const doc = readJson(sitePath);
  const age = serveAgeDays(doc, contract, now);
  if (age == null) return { due: true, reason: "unparseable_stamp" };
  const findings = servePublishFindings(doc, contract, { now });
  if (findings.some((f) => /exceeds max/.test(f))) {
    return { due: true, reason: "over_max_age", age_days: age };
  }
  const threshold = dueThresholdDays(contract, options.refreshFraction ?? REFRESH_FRACTION);
  if (threshold != null && age > threshold) {
    return { due: true, reason: "past_refresh_fraction", age_days: age, threshold_days: threshold };
  }
  return { due: false, reason: "fresh", age_days: age, threshold_days: threshold };
}

export function planServeLookupRefresh(options = {}) {
  const force = Boolean(options.force);
  const decisions = [];
  const refreshed = new Set();
  for (const entry of WAREHOUSE_SERVE_LOOKUPS) {
    if (entry.kind === "digest") {
      const deps = entry.after || [];
      const depHit = deps.some((id) => refreshed.has(id));
      const due = force || depHit;
      decisions.push({
        ...entry,
        due,
        reason: force ? "force" : depHit ? "dependency_refreshed" : "digest_idle",
      });
      if (due) refreshed.add(entry.id);
      continue;
    }
    const verdict = isServeLookupDue(entry, options);
    decisions.push({ ...entry, ...verdict });
    if (verdict.due) refreshed.add(entry.id);
  }
  return {
    schema: "cityscroll.warehouse_serve_lookup_refresh_plan.v1",
    generated_at: (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).toISOString?.()
      || new Date().toISOString(),
    refresh_fraction: options.refreshFraction ?? REFRESH_FRACTION,
    due_count: decisions.filter((row) => row.due).length,
    lookups: decisions,
  };
}

export function runServeLookupRefresh(options = {}) {
  const root = options.root || REPO_ROOT;
  const spawn = options.spawn || spawnSync;
  const plan = planServeLookupRefresh(options);
  const commands = [];
  for (const entry of plan.lookups) {
    if (!entry.due) {
      commands.push({
        id: entry.id,
        builder: entry.builder,
        status: "skipped",
        reason: entry.reason,
      });
      continue;
    }
    if (typeof options.runBuilder === "function") {
      const result = options.runBuilder(entry, { root, plan });
      commands.push({
        id: entry.id,
        builder: entry.builder,
        status: result?.status || "succeeded",
        reason: entry.reason,
        detail: result?.detail || null,
      });
      continue;
    }
    const args = [join(root, entry.builder), ...(entry.builder_args || [])];
    const result = spawn(process.execPath, args, {
      cwd: root,
      env: options.env || process.env,
      stdio: options.stdio || "inherit",
    });
    commands.push({
      id: entry.id,
      builder: entry.builder,
      status: result?.error || result?.status !== 0 ? "failed" : "succeeded",
      reason: entry.reason,
      exit_code: result?.status ?? null,
    });
  }
  const failed = commands.some((row) => row.status === "failed");
  return {
    schema: "cityscroll.warehouse_serve_lookup_refresh_receipt.v1",
    generated_at: plan.generated_at,
    status: failed ? "failed" : "ok",
    refresh_fraction: plan.refresh_fraction,
    due_count: plan.due_count,
    plan,
    commands,
  };
}

function parseArgs(argv) {
  const out = { plan: false, force: false, sourceDir: null, receiptOut: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = true;
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--source-dir") out.sourceDir = argv[++i];
    else if (argv[i] === "--receipt-out") out.receiptOut = argv[++i];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = resolve(args.sourceDir || REPO_ROOT);
  if (args.plan) {
    const plan = planServeLookupRefresh({ root, force: args.force });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const receipt = runServeLookupRefresh({ root, force: args.force });
  const out = resolve(root, args.receiptOut || RECEIPT_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${out} status=${receipt.status} due=${receipt.due_count}`);
  if (receipt.status !== "ok") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
