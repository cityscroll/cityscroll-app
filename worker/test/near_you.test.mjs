import assert from "node:assert/strict";
import test from "node:test";

import { handleNearYou } from "../src/near_you.mjs";
import { buildNearYou } from "../../tools/build_worker_route_read_models.mjs";

test("native place searches resolve retained names to canonical geography without losing filters", async () => {
  const key = "geography:nta2020:MN0102";
  const activity = {
    records:{meetings:{m1:{id:"m1", title:"Local hearing"}}},
    by_level:{borough:{Manhattan:{meetings:1}}},
    district_items:{by_level:{borough:{Manhattan:{meetings:["m1"]}}}},
    geography_items:{definitions:{[key]:{key,type:"nta2020",id:"MN0102",label:"Tribeca-Civic Center"}},by_key:{[key]:{meetings:["m1"]}}},
  };
  const materialized = buildNearYou(activity, {}, "native-search-test");
  const values = new Map(materialized.entries.map(({key,value})=>[key,value]));
  values.set("route-read-model:near-you:manifest:v1", JSON.stringify(materialized.manifest));
  const response = await handleNearYou(new Request("https://cityscroll.org/near-you/?neighborhood=Tribeca-Civic+Center&lens=meetings&agency=Transportation&q=curb"), {ALERT_STATE:kv(values)});
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.searchParams.get("geo"), "nta2020:MN0102");
  assert.equal(target.searchParams.get("lens"), "meetings");
  assert.equal(target.searchParams.get("agency"), "Transportation");
  assert.equal(target.searchParams.get("q"), "curb");
  assert.equal(target.searchParams.has("neighborhood"), false);
  const deferred = await handleNearYou(new Request("https://cityscroll.org/near-you/deferred.json?neighborhood=Tribeca-Civic+Center&lens=meetings"), {ALERT_STATE:kv(values)});
  assert.equal(deferred.status, 303);
  const deferredTarget = new URL(deferred.headers.get("location"));
  assert.equal(deferredTarget.pathname, "/near-you/deferred.json");
  assert.equal(deferredTarget.searchParams.get("geo"), "nta2020:MN0102");
  const resolved = await handleNearYou(new Request(deferredTarget), {ALERT_STATE:kv(values)});
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).schema, "cityscroll.near_you_deferred.v1");
  const unknown = await handleNearYou(new Request("https://cityscroll.org/near-you/deferred.json?neighborhood=Unknown+Place&lens=meetings"), {ALERT_STATE:kv(values)});
  assert.equal(unknown.status, 200);
  const unknownBody = await unknown.json();
  assert.doesNotMatch(unknownBody.results_html, /data-record-id=/);
  assert.match(unknownBody.results_html, /unavailable/i);
});

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
  assert.match(html, /<h1[^>]*>Queens<\/h1>/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/civic-documents\.css"/);
  assert.match(html, /data-scope-axis="borough"[^>]*>[\s\S]*?Queens/);
  assert.match(html, /data-scope-axis="agency"[^>]*>[\s\S]*?Transportation/);
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

  assert.match(html, /data-scope-axis="map basis"[^>]*>[\s\S]*?Contract response address/);
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
  assert.match(html, /data-near-geometry-state="ready"/);
  assert.match(html, /data-near-map-state="ready"/);
  assert.match(html, /Matching records are temporarily unavailable/);
  assert.doesNotMatch(html, /buyer_history_retry/);
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

test("HTTP, malformed-payload, and bounded-timeout reads share the typed deferred failure contract", async () => {
  const requestUrl = "https://cityscroll.org/near-you?v=0&lens=meetings&boro=Queens&agency=Transportation&q=curb";
  const recoveryHref = requestUrl;
  const triggers = [
    ["http-error", new Map()],
    ["malformed-payload", new Map([["route-read-model:near-you:manifest:v1", "{not-json"]])],
    ["bounded-timeout", new Map([["route-read-model:near-you:manifest:v1", new Promise(() => {})]])],
  ];

  for (const [trigger, values] of triggers) {
    const env = {
      ALERT_STATE: kv(values),
      ...(trigger === "bounded-timeout" ? { NEAR_YOU_READ_MODEL_TIMEOUT_MS: 5 } : {}),
    };
    const documentResponse = await handleNearYou(new Request(requestUrl), env);
    const document = await documentResponse.text();
    assert.equal(documentResponse.status, 503, trigger);
    assert.match(document, /data-near-data-state="error"/, trigger);
    assert.match(document, /data-near-geometry-state="ready"/, trigger);
    assert.match(document, /data-near-map-state="ready"/, trigger);
    assert.match(document, /Matching records are temporarily unavailable/, trigger);
    assert.match(document, /data-near-recovery="retry"/, trigger);
    assert.doesNotMatch(document, /buyer_history_retry/, trigger);
    assert.doesNotMatch(document, /data-count="0"/, trigger);

    const deferredResponse = await handleNearYou(new Request(
      requestUrl.replace("/near-you?", "/near-you/deferred.json?"),
    ), {
      ALERT_STATE: kv(values),
      ...(trigger === "bounded-timeout" ? { NEAR_YOU_READ_MODEL_TIMEOUT_MS: 5 } : {}),
    });
    const payload = await deferredResponse.json();
    assert.equal(deferredResponse.status, 503, trigger);
    assert.equal(payload.schema, "cityscroll.near_you_deferred_error.v1", trigger);
    assert.equal(payload.recovery_href, recoveryHref, trigger);
  }
});
