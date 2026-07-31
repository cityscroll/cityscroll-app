import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminPossiblySame, renderPossiblySamePage } from "../src/admin.mjs";
import { toReviewItem, toReviewItems } from "../../entity_resolution/review/index.mjs";

const req = (url, headers = {}) => new Request(url, { headers });

test("possibly-same shaping is non-assertive and preserves provenance", () => {
  const item = toReviewItem(
    { id: "pair-1", left: { id: "a1", vendor_name: "Acme LLC", source: "city_record" }, right: { id: "b2", vendor_name: "Acme Services Inc", source: "checkbook" } },
    { confidence: 0.72, method: "token_v0", evidence: { shared_token: "ACME" } },
  );
  assert.equal(item.decision, "review");
  assert.equal(item.label, "Possibly same vendor");
  assert.equal(item.review_status, "pending");
  assert.equal(item.left.source, "city_record");
  assert.equal(item.right.source, "checkbook");
  assert.deepEqual(item.evidence, { shared_token: "ACME" });
});

test("admin route fails closed and renders fixture pairs without writing", async () => {
  const pair = { id: "pair-1", left: { id: "a1", name: "Acme LLC" }, right: { id: "b2", name: "Acme Services Inc" }, score: 0.72 };
  const env = { ADMIN_KEY: "secret", ER_REVIEW_PAIRS: JSON.stringify([pair]) };

  assert.equal((await handleAdminPossiblySame(req("https://w/admin/possibly-same"), env)).status, 401);
  const response = await handleAdminPossiblySame(req("https://w/admin/possibly-same?key=secret"), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Possibly same vendors/);
  assert.match(html, /Acme LLC/);
  assert.match(html, /not a finding/);
  assert.doesNotMatch(html, /merge/i);
  assert.deepEqual(toReviewItems(JSON.parse(env.ER_REVIEW_PAIRS)).map((x) => x.id), ["pair-1"]);
});

test("admin route supports a read-only JSON representation", async () => {
  const env = { ADMIN_KEY: "secret", ENTITY_REVIEW_FIXTURE: JSON.stringify([{ left: { name: "One" }, right: { name: "Two" }, confidence: 0.5 }]) };
  const response = await handleAdminPossiblySame(req("https://w/admin/possibly-same?key=secret", { accept: "application/json" }), env);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.items[0].decision, "review");
});

test("empty desk view is explicit", () => {
  assert.match(renderPossiblySamePage([]), /No candidate pairs are queued/);
});
