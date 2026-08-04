import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lookupSubsidyProjects,
  subsidyProjectMaterializationReady,
} from "../src/lib/subsidy_project_lookup.mjs";
import { computeLifecycle } from "../src/subsidy_lifecycle.mjs";

const NOTICE = {
  request_id: "20260313009",
  start_date: "2026-03-19",
  event_date: "2026-03-19",
  agency_name: "Build NYC Resource Corporation",
  type_of_notice_description: "Public Hearing",
  short_title: "Build NYC public hearing",
};

test("materialization admits only a receipt that clears its precision threshold", () => {
  assert.equal(subsidyProjectMaterializationReady(), true);
  assert.equal(subsidyProjectMaterializationReady({
    receipt: { bridge_status: "accepted", join_rate: 0.29, threshold: 0.3 },
    by_notice: { x: [{ receipt_backed: true, join_confidence: 1 }] },
  }), false);
  assert.equal(subsidyProjectMaterializationReady({
    receipt: { bridge_status: "killed", join_rate: 1, threshold: 0.3 },
    by_notice: { x: [{ receipt_backed: true, join_confidence: 1 }] },
  }), false);
});

test("lookup returns accepted projects and leaves unmatched notices unchanged", () => {
  const hit = lookupSubsidyProjects("20260313009");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].project_name, "Brooklyn Friends School");
  assert.equal(hit[0].receipt_backed, true);
  assert.equal(hit[0].join_confidence, 1);
  assert.deepEqual(lookupSubsidyProjects("unmatched"), []);
});

test("subsidy lifecycle uses the precomputed RC-2 hit without a publisher fetch", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("publisher fetch should not run on a materialized hit");
  };
  try {
    const result = await computeLifecycle({}, NOTICE.request_id, NOTICE);
    assert.equal(result.ok, true);
    assert.equal(calls, 0);
    assert.equal(result.lifecycle.join.method, "receipt-backed-name-address-date");
    assert.equal(result.lifecycle.project_identity.length, 1);
    assert.equal(result.lifecycle.project_identity[0].project_name, "Brooklyn Friends School");
    assert.equal(result.lifecycle.stage, "board_decision");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
