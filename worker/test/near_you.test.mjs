import assert from "node:assert/strict";
import test from "node:test";

import { handleNearYou } from "../src/near_you.mjs";

test("the edge renderer returns an inspectable scoped HTML document and public cache policy", async () => {
  const response = await handleNearYou(new Request(
    "https://api.cityscroll.org/near-you?v=0&lens=meetings&boro=Queens&agency=Transportation",
  ));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /public/);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://cityscroll.org");
  assert.match(html, /<h1[^>]*>Near you<\/h1>/);
  assert.match(html, /data-scope-axis="borough"[^>]*>Queens/);
  assert.match(html, /data-scope-axis="agency"[^>]*>Transportation/);
  assert.match(html, /data-results-count=/);
  assert.match(html, /data-record-id=/);
  assert.match(html, /data-map-area=/);
});

test("contract response-address scope remains separate from performance geography", async () => {
  const response = await handleNearYou(new Request(
    "https://api.cityscroll.org/near-you?v=0&lens=money&basis=contract_action_address&boro=Manhattan",
  ));
  const html = await response.text();

  assert.match(html, /data-scope-axis="map basis"[^>]*>Contract response address/);
  assert.match(html, /does not say where the contract work will happen/);
  assert.match(html, /Located by (?:submission address|pre-bid venue)/);
});

test("the Near-you handler does not claim the public Stats routes", async () => {
  for (const pathname of ["/stats", "/stats.html"]) {
    const response = await handleNearYou(new Request(`https://api.cityscroll.org${pathname}`));
    assert.equal(response.status, 404);
  }
});
