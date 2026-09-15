import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withPinnedClock } from "./helpers/test_clock.mjs";

import {
  analyzeResidentSources,
  evaluateDebt,
  runNoLiveExternalReads,
} from "../tools/no_live_external_reads.mjs";

const policy = {
  external_data_origins: ["data.cityofnewyork.us"],
  first_party_routes: { snapshot_only: ["/rules"], explicit_transaction: ["/nl"], temporary_debt: ["/legacy"] },
  temporary_debt_max_days: 30,
};

test("static gate rejects publisher fetches but not official navigation links", () => {
  const sources = new Map([["/repo/site/app/example.mjs", `
    const SODA = "https://data.cityofnewyork.us/resource/example.json";
    const official = "<a href='https://data.cityofnewyork.us/d/example'>Source</a>";
    async function load() { return fetch(SODA); }
  `]]);
  const findings = analyzeResidentSources(sources, policy);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].origin, "data.cityofnewyork.us");
  assert.match(findings[0].call_signature, /^fetch\(SODA\)$/);
});

test("static gate rejects unclassified first-party read routes", () => {
  const sources = new Map([["/repo/site/app/example.mjs", `
    workerFetch("/rules", {}, 1000);
    workerFetch("/new-reader", {}, 1000);
  `]]);
  const findings = analyzeResidentSources(sources, policy);
  assert.deepEqual(findings.map((item) => item.route), ["/new-reader"]);
});

test("static gate inventories temporary first-party reads as exact debt", () => {
  const sources = new Map([["/repo/site/app/example.mjs", `
    workerFetch("/legacy/" + encodeURIComponent(id), {}, 1000);
  `]]);
  const findings = analyzeResidentSources(sources, policy);
  assert.equal(findings[0].route, "/legacy");
  assert.equal(findings[0].origin, "first-party:temporary-debt");
});

test("debt ratchet requires an exact callsite and rejects stale allowances", () => {
  const finding = {
    path: "site/app/example.mjs",
    line: 2,
    call_signature: "fetch(SODA)",
    origin: "data.cityofnewyork.us",
    route: null,
  };
  const entry = {
    ...finding,
    id: "example",
    surface: "example",
    owner: "web",
    migration_card: "example-01",
    reason: "temporary migration debt",
    expires_on: "2026-08-20",
  };
  const debt = { schema_version: 1, generated_at: "2026-08-01", expires_on: "2026-08-20", entries: [entry] };
  assert.equal(evaluateDebt([finding], debt, policy, { today: "2026-08-15" }).approved.length, 1);
  const moved = { ...finding, line: 3 };
  const report = evaluateDebt([moved], debt, policy, { today: "2026-08-15" });
  assert.deepEqual(report.unapproved, [moved]);
  assert.deepEqual(report.stale_debt, [entry]);
});

test("a debt expiring today passes today but fails one day later", async () => {
  const finding = {
    path: "site/app/example.mjs",
    line: 2,
    call_signature: "fetch(SODA)",
    origin: "data.cityofnewyork.us",
    route: null,
  };
  const entry = {
    ...finding,
    id: "expiring-example",
    surface: "example",
    owner: "web",
    migration_card: "example-01",
    reason: "temporary migration debt",
    expires_on: "2026-09-15",
  };
  const debt = { schema_version: 1, generated_at: "2026-08-16", expires_on: "2026-09-15", entries: [entry] };
  await withPinnedClock("2026-09-15T00:00:00.000Z", () => {
    assert.doesNotThrow(() => evaluateDebt([finding], debt, policy));
  });
  await withPinnedClock("2026-09-16T00:00:00.000Z", () => {
    assert.throws(() => evaluateDebt([finding], debt, policy), /expired on 2026-09-15/);
  });
});

test("the CLI warns when the manifest has fewer than seven days remaining", () => {
  const preload = fileURLToPath(new URL("./helpers/test_clock_preload.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["tools/no_live_external_reads.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      CITYSCROLL_TEST_TIME_PIN: "2026-10-09T00:00:00.000Z",
      NODE_OPTIONS: `--import=${preload}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warning: no-live debt manifest expires in 6 day\(s\) on 2026-10-15/);
});

test("repository resident-read gate is green", async () => {
  await withPinnedClock("2026-09-14T00:00:00.000Z", () => {
    assert.doesNotThrow(() => runNoLiveExternalReads());
  });
});
