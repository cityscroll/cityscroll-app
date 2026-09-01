import assert from "node:assert/strict";
import test from "node:test";

import {
  renderWalkEntry,
  walkEntryHref,
  walkEntryPlaceLabel,
} from "../site/walk_entry.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { BROWSE_GROUPS, buildBrowseLanding, renderBrowseLanding } from "../site/browse_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

// The six canonical record families, and the payloads that give each one a
// measured primary count, so a landing test reasons about the real taxonomy.
const CANONICAL_FAMILIES = ["Contracts", "People + organizations", "Land", "Rules", "Meetings", "Exams"];
const LANDING_PAYLOADS = {
  contracts: { open_as_of: "2026-08-03", notices: [{ request_id: "C1" }] },
  staffing: { generated_at: "2026-08-02T12:00:00Z", notices: [{ request_id: "S1" }] },
  zoning: { generated_at: "2026-08-05T12:00:00Z", projects: [{ project_id: "P1" }] },
  property: { generated_at: "2026-08-02T12:00:00Z", property_rows: [{ request_id: "PR1" }] },
  rules: { retrieved_at: "2026-08-03T12:00:00Z", rows: [{ request_id: "R1" }] },
  meetings: { retrieved_at: "2026-08-02T12:00:00Z", rows: [{ request_id: "M1" }] },
};
const LANDING_METRICS = {
  "people-organizations": { count: 12, countLabel: "people" },
  exams: { count: 9, countLabel: "civil-service exams" },
};

function landingHtml() {
  return renderBrowseLanding(buildBrowseLanding(LANDING_PAYLOADS, { groupMetrics: LANDING_METRICS }));
}

test("walk entry URLs carry source, query, and explicit place fields only", () => {
  const href = walkEntryHref("/browse/?latitude=40.7&longitude=-73.9&council=C01", {
    source: "search",
    query: "parks",
    place: {
      borough: "Manhattan",
      community_district: "M03",
      latitude: "40.7",
      longitude: "-73.9",
    },
  });
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.pathname, "/browse/");
  assert.equal(url.searchParams.get("walk_source"), "search");
  assert.equal(url.searchParams.get("walk_query"), "parks");
  assert.equal(url.searchParams.get("boro"), "Manhattan");
  assert.equal(url.searchParams.get("cd"), "M03");
  assert.equal(url.searchParams.has("council"), false);
  assert.equal(url.searchParams.has("latitude"), false);
  assert.equal(url.searchParams.has("longitude"), false);
});

test("walk entry renders an origin chip and measured family states", () => {
  const html = renderWalkEntry({
    source: "search",
    query: "parks",
    placeLabel: "Manhattan · CD M03",
    families: [
      { id: "land", label: "Land", count: 12, href: "/browse/zoning/", status: "available" },
      { id: "people", label: "People", count: null, href: "/browse/people/", status: "unknown" },
      { id: "rules", label: "Rules", count: 0, href: "/browse/rules/", status: "empty" },
    ],
  });
  assert.match(html, /data-walk-entry/);
  assert.match(html, /TEXT.*parks/);
  assert.match(html, /PLACE.*Manhattan · CD M03/);
  assert.match(html, /START.*Search/);
  assert.match(html, /data-walk-family-state="available"/);
  assert.match(html, /12 records in this family/);
  assert.match(html, /Records not shown/);
  assert.doesNotMatch(html, /No records in this snapshot/);
});

test("Browse landing exposes all measured entry families, including Places", () => {
  const html = renderBrowseLanding({
    cards: [
      { id: "money", label: "Money", primaryFacet: "contracts", count: 4, description: "Awards", children: [{ id: "contracts", facet: "contracts", label: "Contracts", route: "/browse/contracts/" }] },
      { id: "places", label: "Places", primaryFacet: null, count: 1, description: "Places", children: [{ id: "near-you", label: "Near you", route: "/near-you/" }] },
    ],
  });
  assert.match(html, /data-walk-family="money"/);
  assert.match(html, /data-walk-family="places"/);
  assert.match(html, /href="\/near-you\/"/);
});

test("the Browse record-search control submits canonical Search state, not traversal metadata", () => {
  const html = renderWalkEntry({ source: "browse", recordSearch: true, actionLabel: "Search records" });
  assert.match(html, /<form[^>]*action="\/search\/"[^>]*data-walk-record-search="true"/);
  assert.match(html, /<input id="walk-entry-query" name="q"/);
  assert.match(html, /<button type="submit">Search records<\/button>/);
  assert.doesNotMatch(html, /name="walk_query"/);
  assert.doesNotMatch(html, /name="walk_source"/);
  // The control is record search, so it no longer announces itself as a walk.
  assert.doesNotMatch(html, /Start a walk/);
});

test("a record-search control carries explicit place context into canonical Search", () => {
  const html = renderWalkEntry({
    source: "browse",
    recordSearch: true,
    place: { borough: "Queens", community_district: "Q04", latitude: "40.7" },
  });
  assert.match(html, /<input type="hidden" name="boro" value="Queens">/);
  assert.match(html, /<input type="hidden" name="cd" value="Q04">/);
  assert.doesNotMatch(html, /name="latitude"/);
});

test("an explicit walk control keeps its own traversal fields", () => {
  const html = renderWalkEntry({
    source: "near_you",
    query: "rats",
    actionHref: "/near-you/?v=0&q=rats&walk_source=near_you&walk_query=rats",
    actionLabel: "Walk this place",
  });
  assert.match(html, /Start a walk/);
  assert.match(html, /<input id="walk-entry-query" name="walk_query" value="rats"/);
  assert.match(html, /<input type="hidden" name="walk_source" value="near_you">/);
  assert.doesNotMatch(html, /data-walk-record-search/);
});

test("a query-bearing walk hands the topic to a typed destination as canonical q", () => {
  for (const [route, expected] of [
    ["/browse/contracts/", "/browse/contracts/?q=rats"],
    ["/browse/meetings/", "/browse/meetings/?q=rats"],
  ]) {
    const href = walkEntryHref(route, { source: "search", query: "rats" });
    assert.ok(href.includes(expected), `${href} carries ${expected}`);
    const url = new URL(href, "https://cityscroll.org");
    assert.equal(url.searchParams.get("q"), "rats");
    // T7 traversal context survives beside the canonical topic.
    assert.equal(url.searchParams.get("walk_source"), "search");
    assert.equal(url.searchParams.get("walk_query"), "rats");
  }
});

test("the Browse landing itself stays a walk address rather than a record-search address", () => {
  const href = walkEntryHref("/browse/", { source: "search", query: "rats" });
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.searchParams.has("q"), false);
  assert.equal(url.searchParams.get("walk_query"), "rats");
});

test("a typed destination receives a normalized topic and escapes it in rendered markup", () => {
  const malicious = '<script>alert("x")</script>';
  const href = walkEntryHref("/browse/meetings/", { source: "object", query: `  ${malicious}  ` });
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.searchParams.get("q"), malicious);
  assert.ok(!href.includes("<script>"), "the topic is percent-encoded in the address");
  const html = renderWalkEntry({ source: "browse", recordSearch: true, query: malicious });
  assert.match(html, /value="&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("place labels remain human-readable and coordinate-free", () => {
  assert.equal(
    walkEntryPlaceLabel({ place: { boroughs: ["Queens"], community_districts: ["Q04"] } }),
    "Queens · CD Q04",
  );
});

// --- Browse is the filter-first record-family entrance -----------------------

test("the Browse landing puts record-family choices before graph traversal", () => {
  const html = landingHtml();
  const families = html.indexOf("data-browse-families");
  const grid = html.indexOf("browse-source-grid");
  const explore = html.indexOf("data-browse-explore-connections");
  assert.ok(families >= 0 && grid > families, "the family grid is rendered as its own section");
  assert.ok(explore > grid, "graph traversal follows the family choices");
  // Nothing that announces traversal may precede the family choices.
  for (const marker of ["Graph entry", "Start a walk", "data-walk-entry", "Explore connections"]) {
    const at = html.indexOf(marker);
    assert.ok(at > grid, `${marker} appears after the record families, not before them`);
  }
});

test("the Browse landing opens with resident-task language, not graph language", () => {
  const html = landingHtml();
  assert.match(html, /<h2>Browse NYC public records<\/h2>/);
  assert.match(html, /Choose a type of record, then search or filter that collection\./);
  const head = html.slice(0, html.indexOf("data-browse-families"));
  assert.doesNotMatch(head, /Follow the edges|civic object|Graph entry|Start a walk/);
});

test("every canonical record family offers a direct, queryless collection entrance", () => {
  const html = landingHtml();
  const cards = [...html.matchAll(/<article class="browse-source-card"[\s\S]*?<\/article>/g)].map((match) => match[0]);
  assert.equal(cards.length, 6, "all six canonical families are presented");
  for (const label of CANONICAL_FAMILIES) {
    const card = cards.find((markup) => markup.includes(`<h3>${label}</h3>`));
    assert.ok(card, `${label} is presented as a record family`);
    const actions = card.slice(card.indexOf('class="browse-source-actions"'));
    assert.match(actions, /href="\/browse\/[a-z-]+\//, `${label} links straight to a /browse/ collection`);
    // A family entrance carries no topic, walk, or graph state.
    assert.doesNotMatch(actions, /walk_query|walk_source|[?&]q=/, `${label} needs no query to be useful`);
  }
});

test("the three named resident journeys reach their typed collection in one step", () => {
  const html = landingHtml();
  for (const [label, route] of [["Contracts", "/browse/contracts/"], ["Land", "/browse/zoning/"], ["Meetings", "/browse/meetings/"]]) {
    const start = html.indexOf(`<h3>${label}</h3>`);
    const card = html.slice(start, html.indexOf("</article>", start));
    assert.ok(card.includes(`href="${route}"`), `${label} opens ${route} directly`);
    assert.ok(card.indexOf(`href="${route}"`) < html.indexOf("data-browse-explore-connections"), `${label} needs no intermediate graph step`);
  }
});

test("advertised family filters name controls the destination actually renders", () => {
  // The root advertises refinement only where the typed destination owns it, so
  // every named control is read back out of the markup that renders it.
  const destinations = [read("site/index.html"), read("site/browse_concept_view.mjs")];
  for (const group of BROWSE_GROUPS) {
    assert.ok(group.filters, `${group.label} explains how its collection is refined`);
    assert.ok(Array.isArray(group.filterControls) && group.filterControls.length, `${group.label} names its controls`);
    for (const control of group.filterControls) {
      assert.ok(
        destinations.some((source) => source.includes(`id="${control}"`)),
        `${group.label} advertises "${control}", which its destination renders`,
      );
    }
  }
  const html = landingHtml();
  for (const group of BROWSE_GROUPS) {
    assert.ok(html.includes(group.filters), `${group.label} shows its supported refinement`);
  }
  // The root selects a family; it never grows a universal filter of its own.
  const root = html.slice(0, html.indexOf("data-browse-explore-connections"));
  assert.doesNotMatch(root, /<select|<input/, "the root page adds no filter controls of its own");
});

test("graph traversal stays reachable as a clearly secondary Explore connections journey", () => {
  const html = landingHtml();
  const section = html.slice(html.indexOf("data-browse-explore-connections"));
  assert.match(section, /<h2 id="browse-explore-connections-heading">Explore connections<\/h2>/);
  assert.match(section, /Follow the relationships between civic objects/);
  // Progressive disclosure keeps it from competing with the primary Browse task.
  assert.match(section, /<details class="browse-explore-disclosure"[^>]*>\s*<summary>Start a walk<\/summary>/);
  // The traversal contract itself is preserved, not rewritten.
  assert.match(section, /data-walk-entry/);
  assert.match(section, /Graph entry/);
  assert.equal([...section.matchAll(/data-walk-family="/g)].length, 6);
  assert.match(section, /data-walk-family-state="available"/);
});

test("the Browse landing's Search records form never posts walk state back to Browse", () => {
  const html = landingHtml();
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  assert.ok(form.includes("Search records") || html.includes("<button type=\"submit\">Search records</button>"));
  assert.match(form, /action="\/search\/"/);
  assert.match(form, /name="q"/);
  assert.doesNotMatch(form, /name="walk_query"/);
  assert.doesNotMatch(form, /name="walk_source"/);
  assert.doesNotMatch(form, /action="\/browse\/"/);
});

test("family coverage states stay honest when a family has no measured count", () => {
  // Contracts alone is measured, so no other family may claim a positive count.
  const html = renderBrowseLanding(buildBrowseLanding({ contracts: { open_as_of: "2026-08-03", notices: [{ request_id: "C1" }] } }));
  assert.match(html, /id="source-contracts"/);
  assert.equal([...html.matchAll(/<article class="browse-source-card"/g)].length, 1, "unmeasured families are not fabricated into cards");
  const section = html.slice(html.indexOf("data-browse-explore-connections"));
  assert.match(section, /data-walk-family-state="unknown"/);
  assert.match(section, /Records not shown/);
  assert.doesNotMatch(html, /0 records in this family/);
});

test("an explicit traversal arrival opens the connections disclosure it lands in", () => {
  // The static landing keeps the walk folded; hydration runs only for an arrival
  // that already names its traversal context, and opens that context with it.
  const hydration = read("site/app/walk-entry.mjs");
  assert.match(hydration, /const disclosure = root\.closest\("details"\);/);
  assert.match(hydration, /if \(disclosure\) disclosure\.open = true;/);
  assert.match(hydration, /if \(!\["search", "near_you", "object"\]\.includes\(source\)\) return;/);
});
