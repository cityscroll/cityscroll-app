// Regression guard for the board-notification bridge, now that the logic lives in the
// "board-notify" package (extracted 2026-07-13; see docs/consumers/crol-list.md in that
// repo). board-notify has its own exhaustive unit suite (HMAC, App-JWT, classify, caps);
// this file proves two things instead: (1) worker.mjs's route wiring still reaches it, and
// (2) the OPTIONALITY contract — with no board-notify secrets/vars configured, /board-hook
// fails closed with zero effect on the rest of the worker, which is the whole point of
// keeping this dependency optional (a fork that never sets these still ships a working
// crol-list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/worker.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
}

const SECRET = "hook-secret-for-tests";
function sig(body) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}
function payload() {
  return {
    action: "edited",
    sender: { login: "devdoshi" },
    projects_v2_item: {
      project_node_id: "PVT_test", content_type: "Issue", content_node_id: "I_node123",
    },
    changes: { field_value: { field_name: "Status", from: { name: "Todo" }, to: { name: "In Progress" } } },
  };
}
function req(body, headers = {}) {
  return new Request("https://api.crol-list.org/board-hook", { method: "POST", headers, body });
}

test("optionality: no board-notify secrets configured -> route fails closed (503), no crash", async () => {
  const body = JSON.stringify(payload());
  const r = await worker.fetch(req(body), {});
  assert.equal(r.status, 503);
});

test("route wiring: worker.mjs dispatches /board-hook to board-notify's handleBoardHook (bad signature -> 401)", async () => {
  const body = JSON.stringify(payload());
  const env = { BOARD_HOOK_SECRET: SECRET, METER: new MockKV() };
  const r = await worker.fetch(req(body, { "x-hub-signature-256": "sha256=" + "0".repeat(64) }), env);
  assert.equal(r.status, 401);
});

test("integration: valid signature + BOARD_PROJECT_IDS/METER config shape -> dry-run ack", async () => {
  const body = JSON.stringify(payload());
  const env = {
    BOARD_HOOK_SECRET: SECRET, BOARD_HOOK_DRY: "true", BOARD_PROJECT_IDS: "PVT_test",
    BOARD_ORG: "cityscroll", METER: new MockKV(),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network must not be touched in dry-run"); };
  try {
    const r = await worker.fetch(req(body, { "x-hub-signature-256": sig(body) }), env);
    assert.deepEqual(await r.json(), { ok: true, dry: true, from: "Todo", to: "In Progress" });
  } finally { globalThis.fetch = realFetch; }
});

test("integration: daily cap (shared METER binding) still drops with a 200 ack", async () => {
  const body = JSON.stringify(payload());
  const env = {
    BOARD_HOOK_SECRET: SECRET, BOARD_PROJECT_IDS: "PVT_test", BOARD_HOOK_MAX_PER_DAY: "1",
    BOARD_HOOK_DRY: "true", METER: new MockKV(),
  };
  await worker.fetch(req(body, { "x-hub-signature-256": sig(body) }), env);
  const r = await worker.fetch(req(body, { "x-hub-signature-256": sig(body) }), env);
  assert.deepEqual(await r.json(), { ok: true, skipped: "daily-cap" });
});
