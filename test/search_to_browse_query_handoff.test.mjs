/**
 * Route-level `rats` specimen for the Search-to-Browse query handoff.
 *
 * One topic is followed through every control a resident can reach it from: the
 * root Browse record-search form, the address that form used to produce, the
 * typed Contracts and Meetings destinations of a query-bearing walk, and the
 * cross-type lens handoff. Each case pins route, canonical query, graph context,
 * family filters, coverage state, and record rendering, so a return to
 * topic-as-traversal-metadata fails here instead of in front of a resident.
 *
 * The two records are the production-shaped `rats` rows already in this
 * repository: the Contracts row in `site/data/procurement_browse_rows.json` and
 * the Meetings row in `test/fixtures/calendar-contract/cases.json`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker from "../site/pages_edge.mjs";
import { buildBrowseView, renderBrowseLanding, renderBrowseView } from "../site/browse_view.mjs";
import { legacyBrowseRecordSearchTarget } from "../site/route_migration.mjs";
import { buildSearchLensHandoffHref } from "../site/search_lens_handoff.mjs";
import { walkEntryHref } from "../site/walk_entry.mjs";

const ORIGIN = "https://cityscroll.org";

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const contractsRow = readJson("../site/data/procurement_browse_rows.json")
  .rows.find((row) => row.short_title === "Mayoral Rat Reduction Initiative");
const meetingsRow = readJson("./fixtures/calendar-contract/cases.json").keyword_agency_feed.rows[0];
const contractsSnapshot = readJson("../site/data/money_default_open.json");
const meetingsSnapshot = readJson("../site/data/meetings_domain_observations.json");

const CONTROL_CONTRACT = contractsSnapshot.notices[0];
const CONTROL_MEETING = meetingsSnapshot.rows.find((row) => row.agency_name === "Citywide Administrative Services");

const contractsPayload = {
  ...contractsSnapshot,
  notices: [
    {
      request_id: contractsRow.request_id,
      start_date: contractsRow.start_date,
      agency_name: contractsRow.agency_name,
      type_of_notice_description: "Solicitation",
      category_description: "Services (other than human services)",
      short_title: contractsRow.short_title,
      pin: contractsRow.pin,
    },
    CONTROL_CONTRACT,
  ],
};
const meetingsPayload = { ...meetingsSnapshot, rows: [meetingsRow, CONTROL_MEETING] };

const landing = renderBrowseLanding({
  cards: [
    {
      id: "money",
      label: "Money",
      primaryFacet: "contracts",
      count: 4,
      description: "Awards and solicitations",
      children: [{ id: "contracts", facet: "contracts", label: "Contracts", route: "/browse/contracts/" }],
    },
    {
      id: "meetings",
      label: "Meetings",
      primaryFacet: "meetings",
      count: 9,
      description: "Public meetings and hearings",
      children: [{ id: "meetings", facet: "meetings", label: "Meetings", route: "/browse/meetings/" }],
    },
  ],
});

/** Serialize a GET submission of the rendered record-search control. */
function submittedHref(html, typed) {
  const form = html.match(/<form[^>]*data-walk-search-form[\s\S]*?<\/form>/)?.[0] || "";
  const url = new URL(form.match(/action="([^"]*)"/)?.[1] || "/", ORIGIN);
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    url.searchParams.set(name, /id="walk-entry-query"/.test(tag) ? typed : (tag.match(/value="([^"]*)"/)?.[1] ?? ""));
  }
  return `${url.pathname}${url.search}`;
}

function assetEnv() {
  return {
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  };
}

async function routed(href) {
  const response = await edgeWorker.fetch(new Request(`${ORIGIN}${href}`), assetEnv());
  return { status: response.status, location: response.headers.get("location") };
}

test("A1: the root Browse record-search control lands on canonical Search", async () => {
  assert.match(landing, /<form[^>]*action="\/search\/"/);
  assert.match(landing, /<button type="submit">Search records<\/button>/);
  assert.doesNotMatch(landing, /name="walk_query"/);
  assert.doesNotMatch(landing, /name="walk_source"/);
  assert.equal(submittedHref(landing, "rats"), "/search/?q=rats");
  // The same canonical form contract the homepage entry uses.
  const homepage = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(homepage, /<form class="home-topic-form" method="get" action="\/search\/">/);
  assert.match(homepage, /id="home-topic-query" name="q"/);
  assert.deepEqual(await routed("/search/?q=rats"), { status: 200, location: null });
});

test("A2: the legacy root-Browse record-search address canonically reaches Search", async () => {
  assert.equal(legacyBrowseRecordSearchTarget("/browse/?walk_query=rats&walk_source=browse"), "/search/?q=rats");
  assert.deepEqual(
    await routed("/browse/?walk_query=rats&walk_source=browse"),
    { status: 302, location: `${ORIGIN}/search/?q=rats` },
  );
  // Language and explicitly supported place context ride the canonical codecs.
  assert.equal(
    legacyBrowseRecordSearchTarget("/browse/?walk_query=rats&walk_source=browse&lang=es&boro=Queens&cd=Q04&lat=40.7"),
    "/search/?q=rats&lang=es&boro=Queens&cd=Q04",
  );
});

test("A5: an explicitly chosen traversal is never rewritten into a record search", async () => {
  for (const source of ["search", "near_you", "object"]) {
    const href = `/browse/?walk_query=rats&walk_source=${source}`;
    assert.equal(legacyBrowseRecordSearchTarget(href), null, `${source} keeps its own address`);
    assert.deepEqual(await routed(href), { status: 200, location: null }, `${source} is served, not redirected`);
  }
  // A topic with no declared origin is not a browse-origin record search either.
  assert.equal(legacyBrowseRecordSearchTarget("/browse/?walk_query=rats"), null);
  assert.equal(legacyBrowseRecordSearchTarget("/browse/contracts/?walk_query=rats&walk_source=browse"), null);
  // The traversal address still carries source, topic, place, and its return path.
  const traversal = new URL(walkEntryHref("/browse/", {
    source: "object",
    query: "rats",
    place: { borough: "Queens", community_district: "Q04" },
  }), ORIGIN);
  assert.equal(traversal.pathname, "/browse/");
  assert.equal(traversal.searchParams.get("walk_source"), "object");
  assert.equal(traversal.searchParams.get("walk_query"), "rats");
  assert.equal(traversal.searchParams.get("boro"), "Queens");
  assert.equal(traversal.searchParams.get("cd"), "Q04");
});

test("A3: a query-bearing family handoff hands `rats` to Contracts and Meetings as canonical q", async () => {
  const destinations = {
    contracts: walkEntryHref("/browse/contracts/", { source: "search", query: "rats" }),
    meetings: walkEntryHref("/browse/meetings/", { source: "search", query: "rats" }),
  };
  assert.ok(destinations.contracts.includes("/browse/contracts/?q=rats"), destinations.contracts);
  assert.ok(destinations.meetings.includes("/browse/meetings/?q=rats"), destinations.meetings);
  for (const [family, href] of Object.entries(destinations)) {
    const url = new URL(href, ORIGIN);
    assert.equal(url.searchParams.get("q"), "rats", `${family} keeps the canonical topic`);
    assert.equal(url.searchParams.get("walk_source"), "search", `${family} keeps its traversal origin`);
    assert.equal(url.searchParams.get("walk_query"), "rats", `${family} keeps its traversal topic`);
    assert.deepEqual(await routed(href), { status: 200, location: null }, `${family} is reachable, not redirected`);
  }
});

test("A3: the cross-type lens handoff carries the same canonical topic to the same routes", () => {
  const response = { query: "rats", resolved_term: { canonical_tokens: ["rat"] } };
  const contracts = buildSearchLensHandoffHref({ domain: "contracts", object_ref: "procurement:contract:CT181620258801318" }, response, "?q=rats");
  const meetings = buildSearchLensHandoffHref({ domain: "meetings", object_ref: "meeting:city_record:20260803009" }, response, "?q=rats");
  assert.ok(contracts.startsWith("/browse/contracts/?q=rats"), contracts);
  assert.ok(meetings.startsWith("/browse/meetings/?q=rats"), meetings);
});

test("A3: the typed destination applies the canonical topic and keeps its local filters usable", () => {
  const withTopic = buildBrowseView("contracts", contractsPayload, new URLSearchParams("q=rat reduction"));
  assert.equal(withTopic.total, 1);
  assert.deepEqual(withTopic.rows.map((row) => row.short_title), ["Mayoral Rat Reduction Initiative"]);
  const html = renderBrowseView(withTopic);
  assert.match(html, /Mayoral Rat Reduction Initiative/);
  assert.doesNotMatch(html, new RegExp(CONTROL_CONTRACT.short_title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const meetingsView = buildBrowseView("meetings", meetingsPayload, new URLSearchParams("q=rat inspections"));
  assert.deepEqual(meetingsView.rows.map((row) => row.short_title), ["New Rules Relating to Rat Inspections"]);

  // A second local dimension still narrows on top of the canonical topic.
  const scoped = buildBrowseView("contracts", contractsPayload, new URLSearchParams("q=rat reduction&agency=Finance"));
  assert.equal(scoped.total, 0);
  assert.equal(
    buildBrowseView("contracts", contractsPayload, new URLSearchParams("q=rat reduction&agency=Health and Mental Hygiene")).total,
    1,
  );
});

test("A3: a typed destination reports an honest empty state rather than an unfiltered list", () => {
  // The typed collections match their own rows literally. Where that finds
  // nothing for a topic, the destination says so; it does not fall back to the
  // unfiltered snapshot and does not claim a result it cannot show.
  const view = buildBrowseView("contracts", contractsPayload, new URLSearchParams("q=rats"));
  assert.equal(view.total, 0);
  assert.deepEqual(view.rows, []);
  const html = renderBrowseView(view);
  assert.match(html, /data-scope-count="0"/);
  assert.match(html, /0 available records/);
  assert.doesNotMatch(html, /Mayoral Rat Reduction Initiative/);
});

test("A4: topics are normalized through the existing query contract and never interpolated unsafely", () => {
  const legacy = (query) => legacyBrowseRecordSearchTarget(`/browse/?walk_source=browse&walk_query=${encodeURIComponent(query)}`);
  // An empty or whitespace-only topic is not a record search at all.
  assert.equal(legacy(""), null);
  assert.equal(legacy("   "), null);
  assert.equal(legacy(" "), null);
  // Control characters collapse; the surviving topic is the normalized one.
  assert.equal(legacy("  rats  rats  "), "/search/?q=rats+rats");

  const cases = [
    ['<script>alert("x")</script>', '<script>alert("x")</script>'],
    ["rats%2520", "rats%2520"],
    ["老鼠", "老鼠"],
    ["ратс", "ратс"],
  ];
  for (const [typed, expected] of cases) {
    const target = legacy(typed);
    const url = new URL(target, ORIGIN);
    assert.equal(url.pathname, "/search/");
    assert.equal(url.searchParams.get("q"), expected, `${typed} decodes back to itself exactly once`);
    assert.ok(!target.includes("<script>"), `${typed} is percent-encoded in the address`);
    assert.equal(submittedHref(landing, typed), `/search/?${new URLSearchParams({ q: expected })}`);
  }
  // A topic longer than the shared contract's bound is cut at the bound, not rejected.
  assert.equal(new URL(legacy("r".repeat(400)), ORIGIN).searchParams.get("q").length, 240);
});

test("record-search state and graph state stay distinguishable in the address bar", () => {
  const recordSearch = new URL(submittedHref(landing, "rats"), ORIGIN);
  assert.equal(recordSearch.pathname, "/search/");
  assert.equal(recordSearch.searchParams.get("q"), "rats");
  assert.equal(recordSearch.searchParams.has("walk_source"), false);
  assert.equal(recordSearch.searchParams.has("walk_query"), false);

  const walk = new URL(walkEntryHref("/browse/", { source: "search", query: "rats" }), ORIGIN);
  assert.equal(walk.pathname, "/browse/");
  assert.equal(walk.searchParams.has("q"), false);
  assert.equal(walk.searchParams.get("walk_source"), "search");
  assert.equal(walk.searchParams.get("walk_query"), "rats");
});
