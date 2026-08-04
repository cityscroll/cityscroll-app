/**
 * Characterization: versioned ops contract (desk ↔ worker narrow waist).
 * verify: node --test worker/test/ops_contract.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  handleAdminOpsContract,
  checkAdminKey,
} from "../src/admin.mjs";
import {
  OPS_CONTRACT_ID,
  OPS_CONTRACT_VERSION,
  buildOpsContract,
  closedDaylogActionIds,
  normalizeUsageTrafficClass,
  validateDaylogActionsCovered,
} from "../src/lib/ops_contract.mjs";
import {
  emitUsageEvent,
  isProductionUsageTraffic,
  normalizeUsageEvent,
  usageAnalyticsQuery,
  usageDataPoint,
} from "../src/lib/analytics.mjs";
import { digestDecision } from "../src/lib/digest.mjs";
import { toDayLogEntry, buildDayLog } from "../src/lib/digest_ops.mjs";
import { toRollupDayLogEntry } from "../src/lib/rollup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "worker/ops-contract.v1.json");

test("buildOpsContract: stable id/version and required sections", () => {
  const doc = buildOpsContract({ generated_at: "2026-08-01T00:00:00.000Z" });
  assert.equal(doc.contract, OPS_CONTRACT_ID);
  assert.equal(doc.version, OPS_CONTRACT_VERSION);
  assert.ok(Array.isArray(doc.digest_modes) && doc.digest_modes.length >= 5);
  const modeIds = doc.digest_modes.map((m) => m.id).sort();
  assert.deepEqual(modeIds, ["catch_up", "cron", "dry_run", "queue", "rollup", "shadow_run"].sort());
  assert.ok(doc.daylog.actions.length >= 5);
  assert.ok(doc.stats_metrics.some((m) => m.exclude_developer_traffic === true));
  assert.ok(doc.admin_routes.some((r) => r.path === "/admin/ops-contract"));
  assert.ok(doc.admin_routes.some((r) => r.path === "/admin/digest-shadow"));
  assert.equal(doc.digest_shadow.contract, "digest-shadow.v1");
  assert.equal(doc.digest_shadow.hold.contract, "digest-shadow-hold.v1");
  assert.equal(doc.digest_shadow.hold.cutoff_utc, "12:45");
  assert.equal(doc.digest_shadow.hold.delivery_boundary_utc, "13:00");
  assert.equal(doc.digest_shadow.hold.expires_utc, "14:00");
  assert.ok(doc.daylog.skip_reasons.includes("shadow-hold"));
  assert.deepEqual(doc.digest_shadow.redline_fields, ["code", "digest_id", "watch_id", "reason", "evidence"]);
  assert.ok(doc.auth_classes.some((a) => a.id === "ADMIN_KEY"));
  assert.ok(doc.auth_classes.some((a) => a.id === "USAGE_KEY"));
  assert.ok(doc.auth_classes.some((a) => a.id === "ANALYTICS_DEV_KEY"));
  assert.ok(doc.auth_classes.some((a) => a.id === "Access"));
  assert.ok(doc.kv_namespaces.some((n) => n.binding === "ALERT_STATE"));
  assert.ok(doc.kv_namespaces.some((n) => n.binding === "SUBS"));
  assert.ok(doc.feature_flags.some((f) => f.name === "QUEUE_DIGESTS"));
  assert.ok(doc.feature_flags.some((f) => f.name === "DIGEST_CATCH_UP"));
  assert.ok(doc.traffic_class.usage.some((t) => t.id === "production"));
  assert.ok(doc.traffic_class.usage.some((t) => t.id === "developer"));
});

test("committed fixture matches builder (desk CI pin)", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const live = buildOpsContract({ generated_at: fixture.generated_at });
  assert.deepEqual(live, fixture, "worker/ops-contract.v1.json must match buildOpsContract()");
});

test("daylog actions the worker writes are covered by the contract", () => {
  // Closed vocabulary from digestDecision + catch_up + rollup default.
  const fromDecision = [
    digestDecision({ freshCount: 2, freq: "daily", lastSentDate: "2026-07-01", today: "2026-08-01" }).action,
    digestDecision({ freshCount: 0, freq: "weekly", lastSentDate: "2026-07-01", today: "2026-08-01" }).action,
    digestDecision({
      freshCount: 0, freq: "daily", lastSentDate: "2026-07-01", today: "2026-08-01", heartbeatDays: 14,
    }).action,
    digestDecision({
      freshCount: 0, freq: "daily", lastSentDate: "2026-07-30", today: "2026-08-01", heartbeatDays: 14,
    }).action,
  ];
  assert.deepEqual(fromDecision.sort(), ["heartbeat", "match", "none", "weekly-empty"].sort());

  const written = new Set([
    ...fromDecision,
    "catch_up",
    "rollup",
    // toDayLogEntry skip prefix
    toDayLogEntry({ skipped: "paused" })?.action,
    toDayLogEntry({ skipped: "weekly" })?.action,
    toDayLogEntry({ skipped: "lens:people" })?.action,
    toDayLogEntry({ action: "catch_up", mode: "catch_up" })?.action,
    toRollupDayLogEntry({ action: "match", sections: [] })?.action,
    toRollupDayLogEntry({ skipped: "empty" })?.action,
  ].filter(Boolean));

  const check = validateDaylogActionsCovered(written);
  assert.equal(check.ok, true, `unknown daylog actions: ${check.unknown.join(", ")}`);

  // Contract closed set is a superset of decision vocabulary.
  for (const id of closedDaylogActionIds()) {
    assert.ok(typeof id === "string" && id.length > 0);
  }
  for (const a of fromDecision) {
    assert.ok(closedDaylogActionIds().includes(a), `missing closed action ${a}`);
  }
});

test("buildDayLog envelope fields are declared on the contract", () => {
  const log = buildDayLog({
    day: "2026-08-01",
    ranAt: "2026-08-01T13:00:00.000Z",
    live: true,
    mode: "inline",
    results: [
      { sub: "sub:ab***", new: 1, found: 1, noticeIds: ["1"], action: "match", sent: true },
    ],
  });
  const fieldNames = new Set(buildOpsContract().daylog.envelope_fields.map((f) => f.name));
  for (const key of Object.keys(log)) {
    assert.ok(fieldNames.has(key), `envelope field ${key} missing from contract`);
  }
  const entryFields = new Set(buildOpsContract().daylog.entry_fields.map((f) => f.name));
  for (const key of Object.keys(log.entries[0])) {
    assert.ok(entryFields.has(key), `entry field ${key} missing from contract`);
  }
});

test("handleAdminOpsContract: fail closed + serves contract under ADMIN_KEY", async () => {
  assert.equal(
    (await handleAdminOpsContract(new Request("https://w/admin/ops-contract"), {})).status,
    404,
  );
  assert.equal(
    (await handleAdminOpsContract(
      new Request("https://w/admin/ops-contract?key=wrong"),
      { ADMIN_KEY: "secret" },
    )).status,
    401,
  );
  assert.equal(
    (await handleAdminOpsContract(
      new Request("https://w/admin/ops-contract?key=secret", { method: "POST" }),
      { ADMIN_KEY: "secret" },
    )).status,
    405,
  );
  const ok = await handleAdminOpsContract(
    new Request("https://w/admin/ops-contract?key=secret"),
    { ADMIN_KEY: "secret" },
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.contract, OPS_CONTRACT_ID);
  assert.equal(body.version, OPS_CONTRACT_VERSION);
  assert.ok(body.admin_routes.some((r) => r.path === "/admin/ops-contract"));
  // Shared gate
  assert.equal(checkAdminKey(new Request("https://w/admin/ops-contract?key=secret"), { ADMIN_KEY: "secret" }).ok, true);
});

test("usage traffic_class: production default; developer excluded from AE write", () => {
  assert.equal(normalizeUsageTrafficClass(undefined), "production");
  assert.equal(normalizeUsageTrafficClass("developer"), "developer");
  assert.equal(isProductionUsageTraffic("production"), true);
  assert.equal(isProductionUsageTraffic("developer"), false);

  const prod = normalizeUsageEvent({ event: "page_view", surface: "home" });
  assert.equal(prod.traffic_class, "production");
  const dev = normalizeUsageEvent({ event: "page_view", surface: "home", traffic_class: "developer" });
  assert.equal(dev.traffic_class, "developer");

  const point = usageDataPoint({ event: "page_view", surface: "home", traffic_class: "developer" });
  assert.equal(point.blobs[6], "developer");

  const writes = [];
  const env = {
    ANALYTICS_ENVIRONMENT: "production",
    USAGE_ANALYTICS: { writeDataPoint: (p) => writes.push(p) },
  };
  assert.equal(emitUsageEvent(env, { event: "page_view", surface: "home", traffic_class: "developer" }), false);
  assert.equal(writes.length, 0);
  assert.equal(emitUsageEvent(env, { event: "page_view", surface: "home" }), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].blobs[6], "production");
});

test("usageAnalyticsQuery filters to production traffic_class", () => {
  const sql = usageAnalyticsQuery();
  assert.match(sql, /blob7/);
  assert.match(sql, /production/);
});
