import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAdminWatchSeenMembership } from "../src/admin.mjs";
import { digestShadowId } from "../src/digest_shadow_hold.mjs";
import {
  MAX_IDS_PER_WATCH,
  parseCandidateIds,
  parseWatchQueries,
  seenMembership,
} from "../src/lib/watch_seen_membership.mjs";
import worker from "../src/worker.mjs";

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

const WATCH_KEY = "sub:abcdef0123456789";
const OTHER_KEY = "sub:ffffffffffffffff";

function envWith(seenIds, { lastSent = "2026-09-07", record = "{}" } = {}) {
  return {
    ADMIN_KEY: "admin-key",
    SUBS: new MockKV({ [WATCH_KEY]: record }),
    ALERT_STATE: new MockKV({
      [`seen:${WATCH_KEY}`]: JSON.stringify(seenIds),
      [`lastsent:${WATCH_KEY}`]: lastSent,
    }),
  };
}

test("seenMembership reports only the supplied ids", () => {
  const result = seenMembership(["a", "b", "c", "hidden"], ["b", "z", "a"]);
  assert.equal(result.seen_set_size, 4);
  assert.deepEqual(result.seen_member_ids, ["b", "a"]);
  assert.deepEqual(result.unseen_member_ids, ["z"]);
  assert.equal(result.unseen_member_count, 1);
});

test("parseCandidateIds rejects oversized or malformed lists", () => {
  assert.equal(parseCandidateIds(["ok-id"]).ok, true);
  assert.equal(parseCandidateIds("nope").error, "ids-not-array");
  assert.equal(parseCandidateIds(["bad id"]).error, "invalid-id");
  assert.equal(parseCandidateIds(Array(MAX_IDS_PER_WATCH + 1).fill("x")).error, "too-many-ids");
});

test("parseWatchQueries accepts GET one-watch form and POST list form", () => {
  const get = parseWatchQueries(null, { watchKeyParam: WATCH_KEY, idsParam: "20260831025,20260831021" });
  assert.equal(get.ok, true);
  assert.equal(get.watches[0].ids.length, 2);
  const post = parseWatchQueries({ watches: [{ watch_key: WATCH_KEY, ids: ["20260831025"] }] });
  assert.equal(post.ok, true);
  assert.equal(parseWatchQueries({}).error, "watches-required");
  assert.equal(parseWatchQueries({ watches: [{ watch_key: "not-a-sub" }] }).error, "invalid-watch-key");
});

test("handleAdminWatchSeenMembership: 404 until ADMIN_KEY, 401 on a wrong key", async () => {
  const missing = await handleAdminWatchSeenMembership(
    new Request("https://w/admin/watch-seen-membership?watch_key=" + WATCH_KEY),
    {},
  );
  assert.equal(missing.status, 404);
  const wrong = await handleAdminWatchSeenMembership(
    new Request("https://w/admin/watch-seen-membership?key=wrong&watch_key=" + WATCH_KEY),
    { ADMIN_KEY: "admin-key", ALERT_STATE: new MockKV() },
  );
  assert.equal(wrong.status, 401);
});

test("handleAdminWatchSeenMembership: returns size and supplied-id membership only", async () => {
  const env = envWith(["20260831025", "old-id", "also-old"]);
  const res = await handleAdminWatchSeenMembership(
    new Request("https://w/admin/watch-seen-membership", {
      method: "POST",
      headers: { authorization: "Bearer admin-key", "content-type": "application/json" },
      body: JSON.stringify({
        watches: [{ watch_key: WATCH_KEY, ids: ["20260831025", "20260831021"] }],
      }),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, "cityscroll.watch_seen_membership.v1");
  assert.equal(body.watches.length, 1);
  const row = body.watches[0];
  assert.equal(row.internal_reference, await digestShadowId("digest", WATCH_KEY));
  assert.equal(row.seen_set_size, 3);
  assert.equal(row.last_sent_on, "2026-09-07");
  assert.deepEqual(row.seen_member_ids, ["20260831025"]);
  assert.deepEqual(row.unseen_member_ids, ["20260831021"]);
  assert.equal(JSON.stringify(body).includes("old-id"), false);
  assert.equal(JSON.stringify(body).includes(WATCH_KEY), false);
});

test("handleAdminWatchSeenMembership: unknown watch is watch-not-found without a seen dump", async () => {
  const env = envWith(["secret-id"]);
  const res = await handleAdminWatchSeenMembership(
    new Request(`https://w/admin/watch-seen-membership?key=admin-key&watch_key=${OTHER_KEY}&ids=secret-id`),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.watches[0].error, "watch-not-found");
  assert.equal(JSON.stringify(body).includes("secret-id"), false);
});

test("worker route: SHADOW_STATUS_KEY cannot read watch-seen-membership", async () => {
  const env = {
    ADMIN_KEY: "admin-key",
    SHADOW_STATUS_KEY: "shadow-key",
    ALERT_STATE: new MockKV(),
  };
  for (const method of ["GET", "POST"]) {
    const response = await worker.fetch(new Request("https://w/admin/watch-seen-membership", {
      method,
      headers: { authorization: "Bearer shadow-key" },
    }), env, {});
    assert.equal(response.status, 401, method);
  }
});
