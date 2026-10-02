import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleNearYou } from "../src/near_you.mjs";
import {
  LENSES,
  buildNearYou,
  decideNearYouManifestActivation,
  residentialPlacesFromNtaLayer,
  validateNearYouManifestCompleteness,
} from "../../tools/build_worker_route_read_models.mjs";

const ROOT = new URL("../../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const committedActivity = readJson("site/data/district_activity.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);

function kv(values) {
  return { async get(key) { return values.get(key) || null; } };
}

function materialize(activity, version = "near-you-place-slices") {
  const built = buildNearYou(activity, {}, version, { residentialPlaces });
  const values = new Map(built.entries.map(({ key, value }) => [key, value]));
  values.set("route-read-model:near-you:manifest:v1", JSON.stringify(built.manifest));
  return { built, values };
}

test("native place searches resolve retained names to canonical geography without losing filters", async () => {
  const key = "geography:nta2020:MN0102";
  const activity = {
    records:{meetings:{m1:{id:"m1", title:"Local hearing"}}},
    by_level:{borough:{Manhattan:{meetings:1}}},
    district_items:{by_level:{borough:{Manhattan:{meetings:["m1"]}}}},
    geography_items:{definitions:{[key]:{key,type:"nta2020",id:"MN0102",label:"Tribeca-Civic Center"}},by_key:{[key]:{meetings:["m1"]}}},
  };
  const { values } = materialize(activity, "native-search-test");
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
  assert.match(unknownBody.results_html, /data-near-local-recovery="unknown"/);
  assert.match(unknownBody.results_html, /We couldn’t find this place, so these meetings are not filtered to it\./);
});

test("A1: residential fixtures publish typed coverage instead of a fabricated zero or silent miss", async () => {
  const { built, values } = materialize(committedActivity, "residential-coverage");
  assert.equal(validateNearYouManifestCompleteness(built.manifest, residentialPlaces, LENSES).ok, true);

  for (const code of ["BK0101", "QN0103", "SI0101"]) {
    const sliceId = `geography:nta2020:${code}:meetings`;
    const slice = JSON.parse(values.get(built.manifest.slices[sliceId]));
    assert.equal(slice.coverage.state, "source_unavailable", code);
    const deferred = await handleNearYou(new Request(
      `https://cityscroll.org/near-you/deferred.json?geo=nta2020:${code}&lens=meetings&surface=map`,
    ), { ALERT_STATE: kv(values) });
    assert.equal(deferred.status, 200, code);
    const body = await deferred.json();
    assert.equal(body.schema, "cityscroll.near_you_deferred.v1", code);
    assert.doesNotMatch(body.results_html, /data-results-count="0"/, code);
    assert.match(body.results_html, /data-near-local-recovery="unsupported"/, code);
    assert.match(body.results_html, /We can’t filter these meetings to this neighborhood yet\./, code);
    assert.doesNotMatch(body.results_html, /materializ/i, code);
  }
});

test("A2: ready, zero, unknown geography, and transient failure remain distinct on the Worker path", async () => {
  const { built, values } = materialize(committedActivity, "distinct-states");

  const ready = await handleNearYou(new Request(
    "https://cityscroll.org/near-you/deferred.json?geo=nta2020:MN0102&lens=meetings",
  ), { ALERT_STATE: kv(values) });
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.schema, "cityscroll.near_you_deferred.v1");
  assert.match(readyBody.results_html, /data-record-id=/);
  assert.match(readyBody.results_html, /data-results-count="[1-9]/);

  const zero = await handleNearYou(new Request(
    "https://cityscroll.org/near-you/deferred.json?geo=nta2020:BX0101&lens=meetings",
  ), { ALERT_STATE: kv(values) });
  assert.equal(zero.status, 200);
  const zeroBody = await zero.json();
  assert.equal(zeroBody.schema, "cityscroll.near_you_deferred.v1");
  assert.match(zeroBody.results_html, /data-results-count="0"/);
  assert.doesNotMatch(zeroBody.results_html, /temporarily unavailable|could not load/i);
  assert.match(zeroBody.results_html, /data-near-local-recovery="zero"/);

  // Pattern-valid but unpublished identity: distinct from source_unavailable slices.
  const unknown = await handleNearYou(new Request(
    "https://cityscroll.org/near-you/deferred.json?geo=nta2020:BK9999&lens=meetings",
  ), { ALERT_STATE: kv(values) });
  assert.equal(unknown.status, 503);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.schema, "cityscroll.near_you_deferred_error.v1");
  assert.equal(unknownBody.reason, "near-you-read-model-unavailable");

  const transient = await handleNearYou(new Request(
    "https://cityscroll.org/near-you/deferred.json?geo=nta2020:BK0101&lens=meetings",
  ), { ALERT_STATE: kv(new Map()) });
  assert.equal(transient.status, 503);
  assert.equal((await transient.json()).schema, "cityscroll.near_you_deferred_error.v1");

  const previous = { ...built.manifest, version: "prior-good" };
  const refused = decideNearYouManifestActivation({
    previousManifest: previous,
    candidateManifest: {
      ...built.manifest,
      version: "partial-candidate",
      slices: Object.fromEntries(
        Object.entries(built.manifest.slices).filter(([sliceId]) => !sliceId.includes("BK0101")),
      ),
    },
    residentialPlaces,
  });
  assert.equal(refused.activate, false);
  assert.equal(refused.activeManifest.version, "prior-good");
});


/**
 * Return whether a CSP header's connect-src directive permits posting to url.
 * Mirrors the browser rule the synthetic probe hits: missing api host → zero
 * beacons even when the collector boots and flushes.
 */
function connectSrcAllows(csp, url) {
  const directive = String(csp || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  if (!directive) return false;
  const tokens = directive.slice("connect-src ".length).split(/\s+/).filter(Boolean);
  if (tokens.includes("*")) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = parsed.origin;
  return tokens.some((token) => {
    if (token === "'self'") return origin === "https://cityscroll.org";
    // Host-sources may be bare (*.example.com) or scheme-prefixed
    // (https://*.example.com); browsers match the hostname against the suffix.
    const wild = token.match(/^(?:https?:\/\/)?(\*\.[^/]+)$/i);
    if (wild) {
      const suffix = wild[1].slice(1); // .example.com
      const host = wild[1].slice(2); // example.com
      return parsed.hostname === host || parsed.hostname.endsWith(suffix);
    }
    try {
      return new URL(token).origin === origin;
    } catch {
      return token === origin || token === parsed.host;
    }
  });
}

test("Near You CSP connect-src allows first-party RUM and analytics delivery", async () => {
  // Behavioral contract: the page posts RUM batches to api.cityscroll.org.
  // A connect-src list that names only the document host and basemap tiles
  // blocks those POSTs in the browser, so a probe that reached /near-you and
  // flushed still records marked_beacons=0 / reached_but_no_beacons.
  const response = await handleNearYou(new Request("https://cityscroll.org/near-you"));
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy") || "";
  assert.equal(
    connectSrcAllows(csp, "https://api.cityscroll.org/performance-events?traffic_class=synthetic"),
    true,
    "connect-src must allow RUM delivery to api.cityscroll.org",
  );
  assert.equal(
    connectSrcAllows(csp, "https://api.cityscroll.org/events"),
    true,
    "connect-src must allow analytics delivery to api.cityscroll.org",
  );
  // Basemap tiles stay allowed; omitting cartocdn is a separate map concern.
  assert.equal(
    connectSrcAllows(csp, "https://a.basemaps.cartocdn.com/light_all/1/0/0.png"),
    true,
  );
  // An unrelated API host must stay blocked so the allowlist stays tight.
  assert.equal(connectSrcAllows(csp, "https://example.com/performance-events"), false);
});

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
  // The floor slice publishes no special-bucket lists, so no citywide, online
  // or unmapped collection is claimed, not even as zero.
  assert.equal(payload.bags_html, "");
  assert.doesNotMatch(html, /data-bag=/);
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
  assert.match(html, /These meetings could not load\./);
  assert.doesNotMatch(html, /buyer_history_retry/);
  const allNycHref = html.match(/<a href="([^"]+)" data-near-recovery="all-nyc">All NYC meetings<\/a>/)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(allNycHref);
  const allNyc = new URL(allNycHref, "https://cityscroll.org");
  assert.equal(allNyc.pathname, "/browse/meetings/");
  assert.equal(allNyc.searchParams.has("boro"), false);
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
    assert.match(document, /These meetings could not load\./, trigger);
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

// Separately loaded Near You sections (public alias ccfaadd338534). The real builder
// materializes frozen rows reduced from the pinned published snapshot; the real
// handler reads them through an in-memory KV with one injected fault per case.
import { ROUTE_READ_MODEL_CAUSES } from "../src/lib/route_read_model_kv.mjs";
import {
  MIDWOOD,
  SHEEPSHEAD_BAY,
  faultKv,
  readSectionIsolationFixture,
} from "../../test/helpers/near_you_section_isolation_fixture.mjs";
import { readLocalEscapeFixture } from "../../test/helpers/near_you_local_escape_fixture.mjs";
import { withPinnedClock } from "../../test/helpers/test_clock.mjs";

const { provenance: _isolationProvenance, ...isolationRows } = readSectionIsolationFixture();
const isolation = materialize(isolationRows, "section-isolation");
const isolationKey = (id) => isolation.built.manifest.slices[`${id}:meetings`];
const frozenBucket = (bucket) => isolationRows.district_items[bucket].meetings.map(String).sort();
const MIDWOOD_IDS = isolationRows.geography_items.by_key[MIDWOOD].meetings.map(String).sort();
const MIDWOOD_QUERY = "geo=nta2020:BK1403&lens=meetings&surface=records";
const SHEEPSHEAD_QUERY = "geo=nta2020:BK1503&lens=meetings&surface=records";
const CITYWIDE_QUERY = "lens=meetings&scope=citywide&surface=records";
const INTERNAL_TOKENS = [
  ...Object.values(ROUTE_READ_MODEL_CAUSES),
  "route-read-model", "near-you:v1", "section-isolation", "manifest", "KV", "schema_version",
  "RouteReadModelUnavailable", "injected", "Error:", "stack",
];

/** What a resident reads: text content, not markup or attribute names. */
function residentText(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
}

function recordIds(html) {
  return [...String(html).matchAll(/<li class="near-record" data-record-id="([^"]+)"/g)]
    .map((match) => match[1].replaceAll("&amp;", "&")).sort();
}

/** One special bucket's markup: the citywide preview block, or an online/unmapped link row. */
function bagHtml(html, kind) {
  const start = html.search(new RegExp(`<(?:div|li) [^>]*data-bag="${kind}"`));
  assert.ok(start >= 0, `${kind} section is rendered`);
  const end = kind === "citywide"
    ? html.indexOf('<ul class="near-special-links"', start)
    : html.indexOf("</li>", start);
  return html.slice(start, end < 0 ? html.indexOf("</section>", start) : end);
}

// At the frozen clock the citywide preview is the next two meetings, then the most recent past one.
const CITYWIDE_CLOCK = "2026-09-28T16:00:00.000Z";
const CITYWIDE_PREVIEW = Object.freeze(["20260826001", "meeting:nyc_legistar_events:22568", "20260817025"]);

/** A bucket's own Records route lists its whole membership; the page shows its preview and total. */
function bucketHref(html, kind) {
  const href = bagHtml(html, kind).match(/<a href="([^"]+)" data-near-special-link="/)?.[1];
  assert.ok(href, `${kind} links to its collection`);
  return href.replaceAll("&amp;", "&");
}

async function bucketRouteIds(html, kind, controls = []) {
  const url = new URL(bucketHref(html, kind));
  assert.equal(url.searchParams.get("scope"), kind);
  assert.equal(url.searchParams.get("surface"), "records");
  assert.equal(url.searchParams.has("geo"), false);
  const { body } = await sectionRequest(url.search.slice(1), controls);
  return recordIds(body.results_html);
}

/** The bucket route's total is the whole bucket; its first page lists members only. */
async function assertBucketRoute(html, kind, controls = []) {
  const url = new URL(bucketHref(html, kind));
  const { body } = await sectionRequest(url.search.slice(1), controls);
  const expected = frozenBucket(kind);
  const listed = recordIds(body.results_html);
  assert.match(body.results_html, new RegExp(`data-results-count="${expected.length}"`), kind);
  assert.equal(listed.length, Math.min(expected.length, 30), kind);
  assert.ok(listed.every((id) => expected.includes(id)), kind);
}

function withEdgeCache(body) {
  const puts = [];
  globalThis.caches = { default: {
    async match() { return null; },
    async put(request) { puts.push(request.url); },
  } };
  return Promise.resolve().then(() => body(puts)).finally(() => { delete globalThis.caches; });
}

async function sectionRequest(query, controls = [], { deferred = true, values = isolation.values } = {}) {
  const store = faultKv(values, new Map(controls));
  const path = deferred ? "/near-you/deferred.json" : "/near-you/";
  const response = await handleNearYou(new Request(`https://cityscroll.org${path}?${query}`), {
    ALERT_STATE: store,
    NEAR_YOU_READ_MODEL_TIMEOUT_MS: 20,
  });
  return { response, store, body: deferred ? await response.json() : await response.text() };
}

test("A6 control: with no fault Midwood, citywide, online and unmapped sections all load and cache", () => withPinnedClock(CITYWIDE_CLOCK, async () => {
  await withEdgeCache(async (puts) => {
    const { response, body, store } = await sectionRequest(MIDWOOD_QUERY);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /public/);
    assert.equal(body.schema, "cityscroll.near_you_deferred.v1");
    assert.equal(body.partial, undefined);
    assert.deepEqual(recordIds(body.results_html), MIDWOOD_IDS);
    assert.equal(MIDWOOD_IDS.length, 2);
    assert.deepEqual(recordIds(bagHtml(body.bags_html, "citywide")), [...CITYWIDE_PREVIEW].sort());
    for (const bucket of ["citywide", "virtual", "unlocated"]) {
      assert.match(bagHtml(body.bags_html, bucket), new RegExp(`<strong>${frozenBucket(bucket).length}</strong>`), bucket);
      assert.deepEqual(body.sections[bucket], { state: "ready", count: frozenBucket(bucket).length }, bucket);
    }
    assert.deepEqual(body.sections.primary, { state: "ready", count: 2 });
    assert.doesNotMatch(body.bags_html + body.results_html, /data-near-section-state/);
    assert.equal(puts.length, 1, "a complete response is edge-cached");
    for (const [key, count] of store.reads) assert.equal(count, 1, key);
  });
}));

for (const control of ["reject", "timeout", "corrupt", "missing"]) {
  test(`A1/A6: a ${control} citywide read keeps both Midwood meetings visible and citywide unavailable, never 0`, () => withPinnedClock(CITYWIDE_CLOCK, async () => {
    await withEdgeCache(async (puts) => {
      const { response, body, store } = await sectionRequest(MIDWOOD_QUERY, [[isolationKey("citywide"), control]]);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(body.schema, "cityscroll.near_you_deferred.v1");
      assert.equal(body.partial, true);
      assert.deepEqual(body.sections.citywide.state, "unavailable");
      assert.equal(body.sections.citywide.count, null);
      assert.deepEqual(recordIds(body.results_html), MIDWOOD_IDS);
      assert.match(body.results_html, /data-results-count="2"/);
      // Midwood records keep their native full-record and inspection controls.
      assert.equal((body.results_html.match(/data-near-you-record-inspection=/g) || []).length, 2);
      const citywide = bagHtml(body.bags_html, "citywide");
      assert.match(citywide, /data-near-section-state="unavailable"/);
      assert.match(citywide, /aria-label="Count unavailable"/);
      assert.match(citywide, /Citywide meetings could not load\./);
      assert.match(citywide, /data-near-recovery="retry"/);
      assert.deepEqual(recordIds(citywide), []);
      assert.doesNotMatch(citywide, /<strong>0<\/strong>|No citywide meetings match/);
      for (const token of INTERNAL_TOKENS) assert.equal(residentText(body.bags_html).includes(token), false, token);
      assert.match(bagHtml(body.bags_html, "virtual"), /<strong>1<\/strong>/);
      assert.equal(puts.length, 0, "a partial response is never edge-cached as complete");
      for (const [key, count] of store.reads) assert.equal(count, 1, `no added or repeated read of ${key}`);
      // The failed preview still links the whole bucket, which loads on its own.
      assert.deepEqual(await bucketRouteIds(body.bags_html, "citywide"), frozenBucket("citywide"));
    });
  }));
}

test("A1 reverse: a failed Sheepshead Bay read leaves the 20 frozen citywide meetings navigable and not local", () => withPinnedClock(CITYWIDE_CLOCK, async () => {
  let reverseBags = "";
  const control = await sectionRequest(SHEEPSHEAD_QUERY);
  assert.equal(control.response.status, 200);
  assert.match(control.body.results_html, /data-near-local-recovery="unsupported"/);

  await withEdgeCache(async (puts) => {
    const { response, body } = await sectionRequest(SHEEPSHEAD_QUERY, [[isolationKey(SHEEPSHEAD_BAY), "reject"]]);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.schema, "cityscroll.near_you_deferred_error.v1");
    assert.equal(body.partial, true);
    assert.deepEqual(body.sections.primary, { state: "unavailable", count: null, cause: ROUTE_READ_MODEL_CAUSES.readFailed });
    const citywide = bagHtml(body.bags_html, "citywide");
    assert.deepEqual(recordIds(citywide), [...CITYWIDE_PREVIEW].sort());
    assert.equal(frozenBucket("citywide").length, 20);
    assert.match(citywide, /<strong>20<\/strong>/);
    assert.match(citywide, /View all 20 citywide meetings/);
    for (const anchor of ["20260826001", "meeting:nyc_legistar_events:22568"]) assert.ok(citywide.includes(`data-record-id="${anchor}"`), anchor);
    reverseBags = body.bags_html;
    // The requested local section is an explicit failure, never those records.
    assert.deepEqual(recordIds(body.results_html), []);
    assert.doesNotMatch(body.results_html, /data-results-count=/);
    assert.match(body.results_html, /data-near-section-state="unavailable"/);
    assert.match(body.results_html, /data-near-local-recovery="error"/);
    assert.match(body.results_html, /data-near-recovery="all-nyc"/);
    assert.match(body.results_html, /data-near-recovery="retry"/);
    assert.notEqual(body.results_html.match(/data-near-local-recovery="(\w+)"/)[1], control.body.results_html.match(/data-near-local-recovery="(\w+)"/)[1]);
    assert.equal(puts.length, 0);
  });
  // Navigable: View all lists all 20, with the local place cleared.
  assert.deepEqual(await bucketRouteIds(reverseBags, "citywide", [[isolationKey(SHEEPSHEAD_BAY), "reject"]]), frozenBucket("citywide"));

  const page = await sectionRequest(SHEEPSHEAD_QUERY, [[isolationKey(SHEEPSHEAD_BAY), "reject"]], { deferred: false });
  assert.equal(page.response.status, 503);
  assert.equal(page.response.headers.get("cache-control"), "no-store");
  assert.match(page.body, /data-near-data-state="error"/);
  const allNyc = page.body.match(/<a href="([^"]+)" data-near-recovery="all-nyc">/)?.[1];
  assert.ok(allNyc, "the no-JavaScript document keeps its All NYC Browse route");
  assert.equal(new URL(allNyc.replaceAll("&amp;", "&")).pathname, "/browse/meetings/");
  for (const token of INTERNAL_TOKENS) assert.equal(residentText(page.body).includes(token), false, token);
  // Positive control: the same check finds a leaked cause in resident text.
  assert.equal(residentText(`<p>${ROUTE_READ_MODEL_CAUSES.timeout}</p>`).includes(ROUTE_READ_MODEL_CAUSES.timeout), true);
}));

test("A2: failing only online or only unmapped records leaves local and citywide ID sets unchanged, and Retry restores them", () => withPinnedClock(CITYWIDE_CLOCK, async () => {
  const baseline = (await sectionRequest(MIDWOOD_QUERY)).body;
  for (const bucket of ["virtual", "unlocated"]) {
    const controls = [[isolationKey(bucket), "reject"]];
    const { response, body } = await sectionRequest(MIDWOOD_QUERY, controls);
    assert.equal(response.status, 200, bucket);
    assert.equal(body.partial, true, bucket);
    assert.deepEqual(recordIds(body.results_html), recordIds(baseline.results_html), bucket);
    assert.deepEqual(recordIds(bagHtml(body.bags_html, "citywide")), recordIds(bagHtml(baseline.bags_html, "citywide")), bucket);
    assert.deepEqual(recordIds(bagHtml(body.bags_html, "citywide")), [...CITYWIDE_PREVIEW].sort(), bucket);
    // The whole citywide set is unchanged under the same fault, not just its preview.
    assert.deepEqual(await bucketRouteIds(body.bags_html, "citywide", controls), frozenBucket("citywide"), bucket);
    assert.match(bagHtml(body.bags_html, bucket), /data-near-section-state="unavailable"/, bucket);
    assert.match(bagHtml(body.bags_html, bucket), /aria-label="Count unavailable"/, bucket);
    assert.equal(body.sections[bucket].count, null, bucket);
    for (const other of ["virtual", "unlocated"].filter((name) => name !== bucket)) {
      assert.match(bagHtml(body.bags_html, other), new RegExp(`<strong>${frozenBucket(other).length}</strong>`), `${bucket} failure leaves ${other}`);
      await assertBucketRoute(body.bags_html, other, controls);
    }
  }
  // Retry: the same request after a transient failure succeeds with the right IDs.
  const store = faultKv(isolation.values, new Map([[isolationKey("virtual"), { failTimes: 1 }]]));
  const env = { ALERT_STATE: store, NEAR_YOU_READ_MODEL_TIMEOUT_MS: 20 };
  const href = `https://cityscroll.org/near-you/deferred.json?${MIDWOOD_QUERY}`;
  const failed = await (await handleNearYou(new Request(href), env)).json();
  assert.equal(failed.sections.virtual.state, "unavailable");
  const retried = await handleNearYou(new Request(href), env);
  const retriedBody = await retried.json();
  assert.equal(retried.status, 200);
  assert.equal(retriedBody.partial, undefined);
  assert.doesNotMatch(bagHtml(retriedBody.bags_html, "virtual"), /data-near-section-state/);
  assert.match(bagHtml(retriedBody.bags_html, "virtual"), /<strong>1<\/strong>/);
  assert.deepEqual(await bucketRouteIds(retriedBody.bags_html, "virtual"), ["20260624005"]);
  assert.deepEqual(recordIds(retriedBody.results_html), MIDWOOD_IDS);
}));

test("A4: an explicit citywide scope whose citywide read fails is a requested-results failure", async () => {
  const control = await sectionRequest(CITYWIDE_QUERY);
  assert.equal(control.response.status, 200);
  assert.deepEqual(recordIds(control.body.results_html), frozenBucket("citywide"));
  assert.match(control.body.results_html, /data-results-count="20"/);

  const { response, body } = await sectionRequest(CITYWIDE_QUERY, [[isolationKey("citywide"), "reject"]]);
  assert.equal(response.status, 503);
  assert.equal(body.schema, "cityscroll.near_you_deferred_error.v1");
  assert.equal(body.sections.primary.state, "unavailable");
  assert.equal(body.sections.citywide.state, "unavailable");
  assert.deepEqual(recordIds(body.results_html), [], "loaded online and unmapped records do not stand in for citywide");
  assert.doesNotMatch(body.results_html, /data-results-count=|No records match|No mapped meetings/);
  assert.match(body.results_html, /data-near-section-state="unavailable"/);
  // The requested bucket is the page's primary list, so it has no preview of itself.
  assert.doesNotMatch(body.bags_html, /data-bag="citywide"/);
  assert.match(bagHtml(body.bags_html, "virtual"), /<strong>1<\/strong>/);
});

test("A3: explicit published zero and a refused incomplete candidate stay distinct from read failures", async () => {
  const { provenance: _escapeProvenance, ...escapeRows } = readLocalEscapeFixture();
  const zeroValues = materialize(escapeRows, "published-zero").values;
  const zero = await sectionRequest("geo=nta2020:BX0101&lens=meetings", [], { values: zeroValues });
  assert.equal(zero.response.status, 200);
  assert.deepEqual(zero.body.sections.primary, { state: "ready", count: 0 });
  assert.match(zero.body.results_html, /data-near-local-recovery="zero"/);

  const refused = decideNearYouManifestActivation({
    previousManifest: isolation.built.manifest,
    candidateManifest: { ...isolation.built.manifest, version: "candidate", slices: {} },
    residentialPlaces: [{ key: MIDWOOD }],
  });
  assert.equal(refused.activate, false);
  assert.equal(refused.activeManifest.version, "section-isolation");
  const causes = new Set([
    ...Object.values(ROUTE_READ_MODEL_CAUSES),
    refused.reason,
    zero.body.sections.primary.state,
  ]);
  assert.equal(causes.size, Object.values(ROUTE_READ_MODEL_CAUSES).length + 2);
});

// Neighborhood suggestions (public alias c0cece577f277): the Worker root ranks
// the current-category borough slices it already reads; a failed borough or
// manifest read offers no ranking, and no neighborhood slice is fetched.
import { readPlaceSuggestionsFixture } from "../../test/helpers/near_you_place_suggestions_fixture.mjs";

const placeSuggestionRows = readPlaceSuggestionsFixture().activity;
const placeSuggestions = materialize(placeSuggestionRows, "place-suggestions");
const placeSuggestionSlice = (id) => placeSuggestions.built.manifest.slices[`${id}:meetings`];
const NEAR_YOU_MANIFEST_KEY = "route-read-model:near-you:manifest:v1";
const BOROUGH_NAMES = Object.freeze(["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"]);

function placeSuggestionLinks(html) {
  const nav = String(html).match(/<nav class="near-place-suggestions"[\s\S]*?<\/nav>/)?.[0] || "";
  return [...nav.matchAll(/<a href="([^"]+)" data-near-place-suggestion="([^"]+)" data-geography-key="([^"]+)" data-count="(\d+)">/g)]
    .map(([, href, id, key, count]) => ({ href: href.replaceAll("&amp;", "&"), id, key, count: Number(count) }));
}

/** The logical slice each KV read named, so reads from different builds compare. */
function logicalReads(store, manifest) {
  const names = new Map([[NEAR_YOU_MANIFEST_KEY, "manifest"]]);
  for (const [name, value] of Object.entries(manifest.slices)) {
    if (typeof value === "string") names.set(value, name);
    else for (const [lens, key] of Object.entries(value || {})) names.set(key, `${name}:${lens}`);
  }
  return [...store.reads.keys()].map((key) => names.get(key) || `unknown:${key}`).sort();
}

function assertEntryControls(html, label) {
  assert.match(html, /data-geography-search/, label);
  assert.match(html, /data-use-location/, label);
  assert.match(html, /data-near-collection-entry/, label);
  assert.match(html, /data-near-surface="records"/, label);
}

test("A1/A6: the Worker root suggests from its borough slices, each link lists its neighborhood's IDs, and no read is added", () => withPinnedClock(CITYWIDE_CLOCK, async () => {
  const { response, body, store } = await sectionRequest("", [], { deferred: false, values: placeSuggestions.values });
  assert.equal(response.status, 200);
  const links = placeSuggestionLinks(body);
  assert.deepEqual(links.map((link) => `${link.id}:${link.count}`), ["MN0102:26", "MN0402:12", "MN0101:9"]);
  for (const link of links) {
    const url = new URL(link.href);
    assert.equal(url.searchParams.get("surface"), "records");
    const destination = await sectionRequest(url.search.slice(1), [], { values: placeSuggestions.values });
    const published = [...new Set(placeSuggestionRows.geography_items.by_key[link.key].meetings.map(String))].sort();
    assert.match(destination.body.results_html, new RegExp(`data-results-count="${link.count}"`), link.id);
    assert.deepEqual(recordIds(destination.body.results_html), published, link.id);
  }
  // The root reads the manifest, the five borough slices and the three
  // special buckets once each, exactly as the citywide-preview root does, and
  // never a neighborhood slice.
  const reads = logicalReads(store, placeSuggestions.built.manifest);
  assert.deepEqual(reads, [
    "borough:Bronx:meetings", "borough:Brooklyn:meetings", "borough:Manhattan:meetings",
    "borough:Queens:meetings", "borough:Staten Island:meetings",
    "citywide:meetings", "manifest", "unlocated:meetings", "virtual:meetings",
  ]);
  for (const [key, count] of store.reads) assert.equal(count, 1, key);
  assert.equal(reads.some((name) => name.startsWith("geography:")), false);
  const previous = await sectionRequest("", [], { deferred: false, values: isolation.values });
  assert.deepEqual(reads, logicalReads(previous.store, isolation.built.manifest));
  // Positive control: a selected neighborhood does read its own slice.
  const selected = await sectionRequest("geo=nta2020:MN0102&lens=meetings&surface=records", [], { values: placeSuggestions.values });
  assert.ok(logicalReads(selected.store, placeSuggestions.built.manifest).includes("geography:nta2020:MN0102:meetings"));
}));

test("A4: one failed borough slice or a failed manifest offers no ranked suggestions while entry controls survive", () => withPinnedClock(CITYWIDE_CLOCK, async () => {
  const cases = [
    ...["reject", "timeout", "corrupt", "missing"].map((control) => [`Brooklyn ${control}`, [[placeSuggestionSlice("borough:Brooklyn"), control]]]),
    ["Staten Island reject", [[placeSuggestionSlice("borough:Staten Island"), "reject"]]],
    ["manifest reject", [[NEAR_YOU_MANIFEST_KEY, "reject"]]],
    ["manifest missing", [[NEAR_YOU_MANIFEST_KEY, "missing"]]],
  ];
  for (const [label, controls] of cases) {
    for (const [key] of controls) assert.ok(key, `${label} names a real read`);
    const { response, body } = await sectionRequest("", controls, { deferred: false, values: placeSuggestions.values });
    assert.equal(response.status, 503, label);
    assert.deepEqual(placeSuggestionLinks(body), [], label);
    assert.doesNotMatch(body, /near-place-suggestions|\(26 meetings\)/, label);
    assertEntryControls(body, label);
  }
  // Positive control: the Manhattan slice alone still holds Tribeca's 26
  // meetings, so omitting the ranking is the partial-read rule, not missing data.
  for (const name of BOROUGH_NAMES) assert.ok(placeSuggestionSlice(`borough:${name}`), name);
  const manhattan = JSON.parse(placeSuggestions.values.get(placeSuggestionSlice("borough:Manhattan")));
  assert.equal(manhattan.activity.geography_items.by_key["geography:nta2020:MN0102"].meetings.length, 26);
}));
