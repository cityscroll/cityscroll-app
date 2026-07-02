// Live end-to-end tests for the deployed /usage endpoint. Read-only — no model calls, no cost.
// Run against prod:   npm run usage:live
// Against local:      CROL_WORKER_URL=http://localhost:8787 USAGE_KEY=<secret> npm run usage:live
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.CROL_WORKER_URL || "https://crol-worker.crol-worker.workers.dev").replace(/\/+$/, "");
const USAGE = `${BASE}/usage`;
const KEY = process.env.USAGE_KEY || "";

// 404 only if USAGE_KEY is unset on the worker; 401 once the secret is configured. Either is "locked".
test("no key → 401 or 404 (never 200)", async () => {
  const r = await fetch(USAGE);
  assert.ok(r.status === 401 || r.status === 404, `expected 401/404, got ${r.status}`);
});

test("wrong key → 401 or 404 (never 200)", async () => {
  const r = await fetch(`${USAGE}?key=definitely-wrong`);
  assert.ok(r.status === 401 || r.status === 404, `expected 401/404, got ${r.status}`);
});

test(
  "correct key → 200 with the documented shape",
  { skip: KEY ? false : "set USAGE_KEY env to run the authed check" },
  async () => {
    const r = await fetch(`${USAGE}?key=${encodeURIComponent(KEY)}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.today.calls, "number");
    assert.equal(typeof j.today.est_cost_usd, "number");
    assert.equal(typeof j.last_7d.calls, "number");
    assert.equal(typeof j.last_7d.est_cost_usd, "number");
    assert.equal(typeof j.model, "string");
    assert.match(j.pricing_note, /ESTIMATE/);
  },
);
