// The board-notification bridge (T8): signature gate, payload classification,
// dry-run behavior, and the daily cap — mocked end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, classify, formatComment, handleBoardHook } from "../src/boardhook.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
}

const SECRET = "hook-secret-for-tests";
function sig(body) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}
function payload(overrides = {}) {
  return {
    action: "edited",
    sender: { login: "devdoshi" },
    projects_v2_item: {
      project_node_id: "PVT_test", content_type: "Issue", content_node_id: "I_node123",
      ...(overrides.item || {}),
    },
    changes: { field_value: { field_name: "Status", from: { name: "Todo" }, to: { name: "In Progress" }, ...(overrides.change || {}) } },
    ...(overrides.top || {}),
  };
}
function req(body, s = sig(body)) {
  return new Request("https://api.crol-list.org/board-hook", {
    method: "POST", headers: { "x-hub-signature-256": s }, body,
  });
}

test("signature: valid accepts, tampered/absent rejects", async () => {
  const body = JSON.stringify(payload());
  assert.equal(await verifySignature(SECRET, body, sig(body)), true);
  assert.equal(await verifySignature(SECRET, body + " ", sig(body)), false);
  assert.equal(await verifySignature(SECRET, body, ""), false);
  assert.equal(await verifySignature("", body, sig(body)), false);
});

test("classify: status change on an issue in our project notifies", () => {
  const c = classify(payload(), "PVT_test");
  assert.deepEqual(c, { contentNodeId: "I_node123", from: "Todo", to: "In Progress", mover: "devdoshi" });
});

test("classify skips: drafts, other projects, non-status edits, no-op transitions", () => {
  assert.equal(classify(payload({ item: { content_type: "DraftIssue" } }), "PVT_test").skip, "draft-or-pr");
  assert.equal(classify(payload(), "PVT_other").skip, "other-project");
  assert.equal(classify(payload({ change: { field_name: "Priority" } }), "PVT_test").skip, "not-a-status-change");
  assert.equal(classify(payload({ change: { from: { name: "Done" }, to: { name: "Done" } } }), "PVT_test").skip, "no-transition");
  assert.equal(classify({ action: "created" }, "PVT_test").skip, "not-an-edit");
});

test("formatComment: transition, mover, and the native-controls note", () => {
  const b = formatComment({ from: "Todo", to: "In Progress", mover: "devdoshi" });
  assert.match(b, /Todo → In Progress/);
  assert.match(b, /moved by devdoshi/);
  assert.match(b, /Subscribe button/);
});

test("handler: bad signature 401; unconfigured secret 503 (fails closed)", async () => {
  const body = JSON.stringify(payload());
  const env = { BOARD_HOOK_SECRET: SECRET, NL_METER: new MockKV() };
  assert.equal((await handleBoardHook(req(body, "sha256=deadbeef".padEnd(71, "0")), env)).status, 401);
  assert.equal((await handleBoardHook(req(body), {})).status, 503);
});

test("handler dry-run: valid transition returns dry ack, posts nothing", async () => {
  const body = JSON.stringify(payload());
  const env = { BOARD_HOOK_SECRET: SECRET, BOARD_HOOK_DRY: "true", BOARD_PROJECT_ID: "PVT_test", NL_METER: new MockKV() };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network must not be touched in dry-run"); };
  try {
    const r = await handleBoardHook(req(body), env);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, dry: true, from: "Todo", to: "In Progress" });
  } finally { globalThis.fetch = realFetch; }
});

test("handler: live path posts the comment via lookup + REST (mocked)", async () => {
  const body = JSON.stringify(payload());
  const env = { BOARD_HOOK_SECRET: SECRET, BOARD_PROJECT_ID: "PVT_test", GITHUB_BOT_TOKEN: "tok", NL_METER: new MockKV() };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith("/graphql")) {
      return Response.json({ data: { node: { number: 3, repository: { name: "crol-list", owner: { login: "cityscroll" } } } } });
    }
    assert.match(String(url), /repos\/cityscroll\/crol-list\/issues\/3\/comments/);
    assert.match(JSON.parse(opts.body).body, /Todo → In Progress/);
    return Response.json({ id: 1 }, { status: 201 });
  };
  try {
    const r = await handleBoardHook(req(body), env);
    assert.deepEqual(await r.json(), { ok: true, issue: 3 });
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = realFetch; }
});

test("handler: daily cap drops with a 200 ack (webhook must not retry-storm)", async () => {
  const body = JSON.stringify(payload());
  const env = { BOARD_HOOK_SECRET: SECRET, BOARD_PROJECT_ID: "PVT_test", BOARD_HOOK_MAX_PER_DAY: "1", BOARD_HOOK_DRY: "true", NL_METER: new MockKV() };
  await handleBoardHook(req(body), env);
  const r = await handleBoardHook(req(body), env);
  assert.deepEqual(await r.json(), { ok: true, skipped: "daily-cap" });
});
