import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBoundedCommunityBoardTransport,
} from "../site/community_board_source_adapters.mjs";

const headers = (map = {}) => ({ get: (name) => map[name.toLowerCase()] || null });
const response = (status, body, contentType = "text/html", extra = {}) => {
  const bytes = new TextEncoder().encode(body);
  return { ok: status >= 200 && status < 300, status, headers: headers({ "content-type": contentType, ...extra }),
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
};

const source = { adapter: "html_pdf_v1", board_id: "bronx-cb-01", url: "https://board.example/calendar" };

test("transport records bounded request graphs and enforces request, byte, and run limits", async () => {
  const transport = createBoundedCommunityBoardTransport(async () => response(200, "okay"), {
    minOriginIntervalMs: 0, maxRequests: 1, maxBytes: 2, maxRunMs: 1000,
  });
  const first = await transport(source.url);
  assert.equal(first.ok, false);
  assert.equal(first.receipt.reason, "byte_limit_exceeded");
  const second = await transport(source.url);
  assert.equal(second.receipt.reason, "request_limit_exceeded");
  assert.equal(transport.stats().requests, 2);
  assert.equal(transport.graph[0].content_hash, null);
});

test("required child failures remain linked and cannot become checked-empty", async () => {
  const transport = createBoundedCommunityBoardTransport(async (url) => url.endsWith("/parent")
    ? response(200, "parent") : response(403, "denied"), { minOriginIntervalMs: 0 });
  const parent = await transport("https://board.example/parent");
  transport.parentRequestId = parent.requestId;
  const child = await transport("https://board.example/child");
  assert.equal(child.ok, false);
  assert.equal(transport.graph.at(-1).reason, "http_403");
  assert.equal(transport.graph.at(-1).parent_request_id, transport.graph[0].request_id);
  assert.equal(transport.graph.every((entry) => entry.outcome === "ok"), false);
});

test("403, 429, timeout, redirect exhaustion, challenge HTML, and 304 retain explicit failures", async (t) => {
  const cases = [
    ["403", () => response(403, "denied"), "http_403"],
    ["429", () => response(429, "busy"), "http_429"],
    ["redirect exhaustion", () => response(302, "", "text/html", { location: "https://board.example/next" }), "redirect_limit_exceeded"],
    // Bare "challenge"/"challenges" in ordinary page copy must not trip this;
    // require Cloudflare/captcha wall markers instead.
    ["challenge HTML", () => response(200, "<html><title>Just a moment...</title><div id=\"cf-challenge-running\"></div><p>cloudflare ray id: 00aabb</p></html>"), "challenge_html"],
    ["304 without cache", () => response(304, ""), "not_modified_without_verified_cache"],
  ];
  for (const [name, fetchImpl, reason] of cases) await t.test(name, async () => {
    const transport = createBoundedCommunityBoardTransport(fetchImpl, { minOriginIntervalMs: 0, maxRedirects: 2, maxRetries: 2, requestTimeoutMs: 5 });
    const result = await transport(source.url);
    assert.equal(result.ok, false); assert.equal(result.receipt.reason, reason); assert.equal(result.receipt.outcome, "failed");
    assert.ok(result.receipt.retries <= 2);
  });
  await t.test("timeout", async () => {
    const transport = createBoundedCommunityBoardTransport(() => new Promise(() => {}), { minOriginIntervalMs: 0, requestTimeoutMs: 2 });
    assert.equal((await transport(source.url)).receipt.reason, "timeout");
  });
  await t.test("malformed child JSON", async () => {
    const transport = createBoundedCommunityBoardTransport(() => Promise.resolve(response(200, "not-json", "application/json")), { minOriginIntervalMs: 0 });
    assert.equal((await transport(source.url, { _expectedJson: true })).receipt.reason, "malformed_json");
  });
});
