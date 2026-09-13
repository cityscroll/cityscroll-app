import assert from "node:assert/strict";
import test from "node:test";

import { handleNearYou } from "../src/near_you.mjs";

function kv(values) {
  return { async get(key) { return values.get(key) || null; } };
}

test("the edge renderer returns an inspectable scoped HTML document and public cache policy", async () => {
  const response = await handleNearYou(new Request(
    "https://cityscroll.org/near-you?v=0&lens=meetings&boro=Queens&agency=Transportation",
  ));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /public/);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://cityscroll.org");
  assert.match(response.headers.get("content-security-policy") || "", /style-src[^;]+https:\/\/cityscroll\.org/);
  assert.match(response.headers.get("content-security-policy") || "", /font-src https:\/\/fonts\.gstatic\.com/);
  assert.match(html, /<h1[^>]*>Near you<\/h1>/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/civic-documents\.css"/);
  assert.match(html, /data-scope-axis="borough"[^>]*>Queens/);
  assert.match(html, /data-scope-axis="agency"[^>]*>Transportation/);
  assert.match(html, /data-near-deferred-href="https:\/\/cityscroll\.org\/near-you\/deferred\.json/);
  assert.match(html, /data-map-area=/);

  const deferred = await handleNearYou(new Request(
    "https://cityscroll.org/near-you/deferred.json?v=0&lens=meetings&boro=Queens&agency=Transportation",
  ));
  const payload = await deferred.json();
  assert.equal(payload.schema, "cityscroll.near_you_deferred.v1");
  assert.match(payload.results_html, /data-results-count=/);
  assert.match(payload.results_html, /data-record-id=/);
  assert.match(payload.bags_html, /data-bag=/);
});

test("shared API-host Near-you documents permanently recover to the canonical host", async () => {
  const response = await handleNearYou(new Request(
    "https://api.cityscroll.org/near-you?v=0&lens=land&boro=Bronx&cd=X08",
  ));

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://cityscroll.org/near-you?v=0&lens=land&boro=Bronx&cd=X08",
  );
});

test("contract response-address scope remains separate from performance geography", async () => {
  const response = await handleNearYou(new Request(
    "https://cityscroll.org/near-you?v=0&lens=money&basis=contract_action_address&boro=Manhattan",
  ));
  const html = await response.text();

  assert.match(html, /data-scope-axis="map basis"[^>]*>Contract response address/);
  assert.match(html, /does not say where the contract work will happen/);
  const deferred = await handleNearYou(new Request(
    "https://cityscroll.org/near-you/deferred.json?v=0&lens=money&basis=contract_action_address&boro=Manhattan",
  ));
  assert.match(await deferred.text(), /Located by (?:submission address|pre-bid venue)/);
});

test("the Near-you handler does not claim the public Stats routes", async () => {
  for (const pathname of ["/stats", "/stats.html"]) {
    const response = await handleNearYou(new Request(`https://api.cityscroll.org${pathname}`));
    assert.equal(response.status, 404);
  }
});

test("a failed Near You read serves an honest error document and scoped retry", async () => {
  const requestUrl = "https://cityscroll.org/near-you?v=0&lens=meetings&boro=Queens&agency=Transportation";
  const response = await handleNearYou(new Request(requestUrl), { ALERT_STATE: kv(new Map()) });
  const html = await response.text();

  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(html, /data-near-data-state="error"/);
  assert.match(html, /data-near-map-state="error"/);
  assert.match(html, /Map data is temporarily unavailable/);
  const retryHref = html.match(/<a href="([^"]+)" data-near-recovery="retry">/)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(retryHref);
  assert.equal(new URL(retryHref).searchParams.get("agency"), "Transportation");
  assert.equal(new URL(retryHref).searchParams.get("boro"), "Queens");
  assert.doesNotMatch(html, /data-count="0"/);

  const deferred = await handleNearYou(new Request(
    `${requestUrl.replace("/near-you?", "/near-you/deferred.json?")}`,
  ), { ALERT_STATE: kv(new Map()) });
  const payload = await deferred.json();
  assert.equal(deferred.status, 503);
  assert.equal(payload.schema, "cityscroll.near_you_deferred_error.v1");
  assert.equal(payload.recovery_href, "https://cityscroll.org/near-you?v=0&lens=meetings&boro=Queens&agency=Transportation");
});
