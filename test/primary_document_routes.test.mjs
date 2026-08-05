import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { BROWSE_FACETS, buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { forwardLegacyFragment } from "../site/legacy_hash_forward.mjs";
import { edgeRequestKind, renderEdgeNotice } from "../site/pages_edge.mjs";
import { primaryDocumentOutputs } from "../tools/build_primary_documents.mjs";
import { handleStats } from "../worker/src/stats.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

test("primary navigation is four real document links on every promoted shell", () => {
  for (const html of [read("../site/index.html"), read("../site/near-you/index.html"), read("../site/following/index.html")]) {
    assert.match(html, /aria-label="Primary"/);
    for (const route of ["/now/", "/near-you/", "/following/", "/browse/"]) {
      assert.match(html, new RegExp(`href="${route.replaceAll("/", "\\/")}"`));
    }
  }
  const root = read("../site/index.html");
  for (const facet of ["money", "people", "land", "property", "rules", "meetings"]) {
    assert.match(root, new RegExp(`data-tab="${facet}"`), `${facet} stays reachable as a Browse facet`);
  }
});

test("Now and every bounded Browse default are exact build outputs with useful no-JS HTML", () => {
  const outputs = primaryDocumentOutputs();
  assert.equal(outputs.length, 8);
  for (const [path, generated] of outputs) {
    if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), generated, `${path} is stale`);
    assert.match(generated, /<base href="\/">/);
    assert.match(generated, /data-document-rendered="true"/);
    assert.doesNotMatch(generated, /<link rel="canonical" href="https:\/\/cityscroll\.org\/">/);
  }
  const output = (suffix) => outputs.find(([path]) => path.endsWith(suffix))?.[1] || "";
  const now = output("/site/now/index.html");
  assert.match(now, /data-build-rendered="now"/);
  assert.match(now, /data-now-item=/);
  assert.match(now, /href="\/notices\/[A-Za-z0-9_-]+"/);
  for (const facet of Object.keys(BROWSE_FACETS)) {
    const html = output(`/site/browse/${facet}/index.html`);
    assert.match(html, new RegExp(`data-browse-facet="${facet}"`));
    assert.match(html, /data-record-id=/);
    assert.doesNotMatch(html, /data-build-rendered="browse"[\s\S]{0,200}<span class="loading"/);
  }
});

test("Browse edge filtering is bounded, semantic, and discloses live-only controls", () => {
  const payload = {
    open_as_of: "2026-08-05",
    notices: [
      { request_id: "1", short_title: "Queens bridge repair", agency_name: "DOT", due_date: "2026-08-09" },
      { request_id: "2", short_title: "Bronx tree care", agency_name: "Parks", due_date: "2026-09-30" },
    ],
  };
  const view = buildBrowseView("contracts", payload, new URLSearchParams("q=bridge&closing=week&mode=award"));
  assert.equal(view.total, 1);
  assert.deepEqual(view.liveOnlyFilters, ["mode"]);
  const html = renderBrowseView(view);
  assert.match(html, /href="\/notices\/1"/);
  assert.match(html, /need the live Browse controls: mode/);
  assert.doesNotMatch(html, /Bronx tree care/);
});

test("legacy fragments use a finite location.replace bridge and preserve language", () => {
  const calls = [];
  const location = {
    href: "https://cityscroll.org/?lang=es#notice/20240515016",
    pathname: "/",
    search: "?lang=es",
    hash: "#notice/20240515016",
    replace(value) { calls.push(value); },
  };
  assert.equal(forwardLegacyFragment(location), true);
  assert.deepEqual(calls, ["/notices/20240515016?lang=es"]);
  location.href = "https://cityscroll.org/#matter/84124P0003001";
  location.search = "";
  location.hash = "#matter/84124P0003001";
  assert.equal(forwardLegacyFragment(location), false);
  assert.equal(calls.length, 1);
});

test("notice response renderer supplies semantic HTML before the enhancement island", () => {
  const html = renderEdgeNotice({
    request_id: "20240515016",
    short_title: "Forest <management>",
    agency_name: "Parks & Recreation",
    type_of_notice_description: "Solicitation",
    due_date: "2026-08-20T00:00:00.000",
    pin: "PIN-1",
    additional_description_1: "Public notice text",
  }, "20240515016");
  assert.match(html, /data-edge-rendered="notice"/);
  assert.match(html, /Forest &lt;management&gt;/);
  assert.match(html, /<dt>Responses due<\/dt>/);
  assert.match(html, /RequestDetail\/20240515016/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /class="loading"/);
});

test("Pages edge routing is a narrow waist and explicitly excludes the public Stats document", () => {
  assert.equal(edgeRequestKind("https://cityscroll.org/notices/20240515016"), "notice");
  assert.equal(edgeRequestKind("https://cityscroll.org/browse/rules/?q=air"), "browse");
  assert.equal(edgeRequestKind("https://cityscroll.org/stats.html"), "asset");
  assert.equal(edgeRequestKind("https://api.cityscroll.org/stats"), "asset");
  const routes = JSON.parse(read("../site/_routes.json"));
  assert.deepEqual(routes.exclude, ["/stats.html"]);
  assert.ok(routes.include.includes("/notices/*"));
  assert.ok(routes.include.includes("/browse/*"));
});

test("Stats document and API keep their exact public endpoints with the reduced coverage contract", async () => {
  const html = read("../site/stats.html");
  assert.match(html, /<link rel="canonical" href="https:\/\/cityscroll\.org\/stats\.html">/);
  assert.match(html, /https:\/\/api\.cityscroll\.org\/stats/);
  const worker = read("../worker/src/worker.mjs");
  assert.match(worker, /pathname === "\/stats"\) return handleStats/);
  const env = { ALERT_STATE: fakeKV(), NL_METER: fakeKV(), SUBS: fakeKV() };
  const response = await handleStats(new Request("https://api.cityscroll.org/stats"), env, { waitUntil() {} }, {
    now: "2026-08-05T12:00:00Z",
    fetchImpl: async () => Response.json([{
      notice_count: "1099194",
      first_notice_date: "2003-01-02T00:00:00.000",
      latest_notice_date: "2026-08-05T00:00:00.000",
    }]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.schema, "public-stats.v2");
  assert.equal(body.city_record.notice_count, 1099194);
  assert.equal(body.sources.primary_system_count, 6);
  assert.equal(body.language_coverage.site_languages, 11);
  for (const privateField of ["subscriptions", "digests", "nl_search", "history", "usage"]) {
    assert.equal(Object.hasOwn(body, privateField), false, `${privateField} stays behind the desk`);
  }
});

test("client island recognizes promoted document routes without converting entity or matter pages", () => {
  const routing = read("../site/app/routing.mjs");
  const main = read("../site/app/main.mjs");
  assert.match(routing, /function documentRouteRaw\(\)/);
  assert.match(routing, /\^\\\/notices\\\//);
  assert.match(routing, /\^\\\/browse/);
  assert.match(main, /CrolRouteMigration = await import/);
  assert.doesNotMatch(routing, /pathname.*(?:entity|matter)/);
});
