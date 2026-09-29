/**
 * Near You scope adoption must stay coherent across topic changes.
 *
 *   node --test test/near_you_scope_adoption.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  adoptNearYouDeferredShellsOnly,
  adoptNearYouDocumentScope,
  applyNearYouDeferredPayload,
  beginNearYouDeferredGeneration,
  isNearYouDeferredGenerationCurrent,
  NEAR_YOU_SCOPE_REGION_ATTRIBUTE,
  NEAR_YOU_SCOPE_REGION_SELECTORS,
} from "../site/near_you_scope_adoption.mjs";
import { mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = process.cwd();
const EVIDENCE_PATH = join("docs", "evidence", "near-you-scope-adoption", "acceptance-manifest.json");
const MAP_PATH = join("site", "app", "map.mjs");
const ADOPTION_PATH = join("site", "near_you_scope_adoption.mjs");
const ROUTE = "/near-you/?v=0&level=community_district&lens=people&boro=Brooklyn&cd=K15";
const MEETINGS_ROUTE = "/near-you/?v=0&level=community_district&lens=meetings&boro=Brooklyn&cd=K15";
const VIEWPORT = Object.freeze([1440, 900]);
const FIXTURE_VINTAGE = "2026-09-17";

function staffingResolvedMarkup() {
  return `
<main id="main" data-near-you-root data-lens="people" data-level="community_district"
  data-near-data-state="ready" data-near-map-state="populated"
  data-near-recovery-href="${ROUTE}" data-near-deferred-href="/near-you/deferred.json?lens=people&amp;cd=K15"
  data-near-deferred-state="ready"
  data-message-deferred-unavailable="Matching records are temporarily unavailable."
  data-message-bags-unavailable="Other place records are temporarily unavailable.">
  <section class="near-hero">
    <ul class="near-scope" aria-label="Active filters"><li data-scope-axis="topic"><span>Topic: Staffing</span></li></ul>
    <h1>Brooklyn Community District 15</h1>
  </section>
  <form class="near-form" method="get" action="/near-you/">
    <label>Topic<select name="lens"><option value="people" selected>Staffing</option><option value="meetings">Meetings</option></select></label>
    <input type="hidden" name="boro" value="Brooklyn">
    <input type="hidden" name="cd" value="K15">
    <button type="submit">Apply filters</button>
  </form>
  <nav class="near-surface-switch" data-near-surface-switch>
    <a data-near-surface="records" class="is-active">Records (2)</a>
    <a data-near-surface="map">Map</a>
  </nav>
  <section class="near-results" aria-labelledby="near-results-heading" data-results-count="2" data-near-surface-panel="records">
    <h2 id="near-results-heading">2 Staffing records for these filters</h2>
    <article data-record-id="staff-1"><h3>Staffing appointment A</h3></article>
    <article data-record-id="staff-2"><h3>Staffing appointment B</h3></article>
  </section>
  <section class="near-map-section" data-near-surface-panel="map">
    <h2 id="near-map-heading">Staffing by area</h2>
    <p data-results-count="2">2 mapped Staffing records</p>
  </section>
  <section class="near-bags" aria-labelledby="near-bags-heading">
    <h2 id="near-bags-heading">Records outside mapped districts</h2>
    <p data-bag="citywide">Staffing citywide placeholder</p>
  </section>
</main>`;
}

function meetingsPendingMarkup() {
  return `
<main id="main" data-near-you-root data-lens="meetings" data-level="community_district"
  data-near-data-state="pending" data-near-map-state="pending"
  data-near-recovery-href="${MEETINGS_ROUTE}" data-near-deferred-href="/near-you/deferred.json?lens=meetings&amp;cd=K15"
  data-near-deferred-state="pending"
  data-message-deferred-unavailable="Matching records are temporarily unavailable."
  data-message-bags-unavailable="Other place records are temporarily unavailable.">
  <section class="near-hero">
    <ul class="near-scope" aria-label="Active filters"><li data-scope-axis="topic"><span>Topic: Meetings</span></li></ul>
    <h1>Brooklyn Community District 15</h1>
  </section>
  <form class="near-form" method="get" action="/near-you/">
    <label>Topic<select name="lens"><option value="people">Staffing</option><option value="meetings" selected>Meetings</option></select></label>
    <input type="hidden" name="boro" value="Brooklyn">
    <input type="hidden" name="cd" value="K15">
    <button type="submit">Apply filters</button>
  </form>
  <nav class="near-surface-switch" data-near-surface-switch>
    <a data-near-surface="records" class="is-active">Records</a>
    <a data-near-surface="map">Map</a>
  </nav>
  <section class="near-results near-results-shell" aria-labelledby="near-results-heading" data-near-deferred="results" data-near-deferred-state="pending" data-near-surface-panel="records" aria-busy="true">
    <h2 id="near-results-heading">Matching Meetings records</h2>
    <p class="near-deferred-status" role="status">Loading matching records…</p>
  </section>
  <section class="near-map-section" data-near-surface-panel="map">
    <h2 id="near-map-heading">Meetings by area</h2>
    <p>Loading mapped Meetings records…</p>
  </section>
  <section class="near-bags near-bags-shell" aria-labelledby="near-bags-heading" data-near-deferred="bags" data-near-deferred-state="pending" aria-busy="true">
    <h2 id="near-bags-heading">Records outside mapped districts</h2>
    <p class="near-deferred-status" role="status">Loading other place records…</p>
  </section>
</main>`;
}

function meetingsDeferredPayload() {
  return {
    schema: "cityscroll.near_you_deferred.v1",
    results_html: `<section class="near-results" aria-labelledby="near-results-heading" data-results-count="36" data-near-surface-panel="records">
      <h2 id="near-results-heading">36 Meetings records for these filters</h2>
      <article data-record-id="meet-1"><h3>Community board hearing</h3></article>
    </section>`,
    bags_html: `<section class="near-bags" aria-labelledby="near-bags-heading">
      <h2 id="near-bags-heading">Records outside mapped districts</h2>
      <p data-bag="citywide">Meetings citywide placeholder</p>
    </section>`,
  };
}

function staffingDeferredPayload() {
  return {
    schema: "cityscroll.near_you_deferred.v1",
    results_html: `<section class="near-results" aria-labelledby="near-results-heading" data-results-count="2" data-near-surface-panel="records">
      <h2 id="near-results-heading">2 Staffing records for these filters</h2>
      <article data-record-id="staff-stale"><h3>Stale staffing row</h3></article>
    </section>`,
    bags_html: `<section class="near-bags" aria-labelledby="near-bags-heading">
      <h2 id="near-bags-heading">Records outside mapped districts</h2>
      <p data-bag="citywide">Stale staffing bag</p>
    </section>`,
  };
}

function mountPair() {
  const current = mountDocument(staffingResolvedMarkup(), { containerClass: "near-current" });
  const incoming = mountDocument(meetingsPendingMarkup(), { containerClass: "near-incoming" });
  const root = current.doc.querySelector("[data-near-you-root]");
  const next = incoming.doc.querySelector("[data-near-you-root]");
  assert.ok(root);
  assert.ok(next);
  return { current, incoming, root, next };
}

function parseHtml(doc, html) {
  const wrap = doc.createElement("div");
  wrap.innerHTML = html;
  return wrap.children[0] || null;
}

function visibleTopics(root) {
  return root.querySelectorAll("[data-scope-axis='topic'], #near-results-heading, #near-map-heading")
    .map((node) => node.textContent);
}

test("A4 root cause: shell-marker-only adoption leaves resolved Staffing results beside Meetings chrome", () => {
  const { root, next, current } = mountPair();
  const clone = (node) => current.doc.importNode(node, true);
  // Legacy adoptDocument replaced summary/map/form regions, then searched only for
  // deferred shells. Resolved .near-results no longer carry data-near-deferred.
  for (const selector of [
    ".near-hero",
    ".near-place-guide",
    ".near-form",
    ".near-coverage",
    ".near-surface-switch",
    ".near-map-section",
  ]) {
    const currentNode = root.querySelector(selector);
    const replacement = next.querySelector(selector);
    if (currentNode && replacement) currentNode.replaceWith(clone(replacement));
    else if (currentNode && !replacement) currentNode.remove();
    else if (!currentNode && replacement) root.append(clone(replacement));
  }
  adoptNearYouDeferredShellsOnly(root, next, { importNode: clone });

  const topics = visibleTopics(root).join(" | ");
  assert.match(topics, /Topic: Meetings/);
  assert.match(topics, /Staffing/);
  assert.equal(root.querySelectorAll(".near-results").length, 2);
  assert.equal(root.dataset.lens, "meetings");
  // Deferred URL metadata is not adopted by the shell-only path.
  assert.match(root.dataset.nearDeferredHref || "", /lens=people/);
  assert.match(root.textContent, /Staffing appointment A/);
  assert.match(root.querySelector(".near-hero")?.textContent || "", /Topic: Meetings/);
  assert.match(root.querySelectorAll(".near-results")[0]?.textContent || "", /Staffing/);
  assert.match(root.querySelectorAll(".near-results")[1]?.textContent || "", /Meetings/);
});

test("A1: atomic adoption keeps one Meetings result set and preserves K15", () => {
  const { root, next, current } = mountPair();
  const generation = adoptNearYouDocumentScope(root, next, {
    importNode: (node) => current.doc.importNode(node, true),
  });

  assert.equal(root.querySelectorAll(".near-results").length, 1);
  assert.equal(root.querySelectorAll(".near-bags").length, 1);
  assert.equal(root.dataset.lens, "meetings");
  assert.equal(root.dataset.level, "community_district");
  assert.match(root.dataset.nearDeferredHref || "", /lens=meetings/);
  assert.equal(root.dataset.nearDeferredState, "pending");
  assert.equal(root.querySelector("input[name='cd']")?.getAttribute("value"), "K15");
  assert.equal(root.querySelector("input[name='boro']")?.getAttribute("value"), "Brooklyn");
  assert.match(root.querySelector("[data-scope-axis='topic']")?.textContent || "", /Topic: Meetings/);
  assert.match(root.querySelector("#near-results-heading")?.textContent || "", /Meetings/);
  assert.equal(root.querySelector("[data-record-id='staff-1']"), null);
  assert.equal(root.querySelector("[data-record-id='staff-2']"), null);
  assert.ok(root.querySelector("[data-near-deferred='results']"));
  assert.equal(Number(generation) > 0, true);

  const applied = applyNearYouDeferredPayload(root, meetingsDeferredPayload(), {
    generation,
    parseHtml: (html) => parseHtml(current.doc, html),
  });
  assert.equal(applied.applied, true);
  assert.equal(root.dataset.nearDeferredState, "ready");
  assert.equal(root.querySelectorAll(".near-results").length, 1);
  assert.match(root.querySelector("#near-results-heading")?.textContent || "", /36 Meetings/);
  assert.equal(root.querySelector("[data-record-id='meet-1']")?.textContent.includes("Community board hearing"), true);
  assert.equal(root.querySelector(".near-results")?.textContent.includes("Staffing"), false);
  assert.match(root.querySelector("[data-scope-axis='topic']")?.textContent || "", /Meetings/);
});

test("A2: stale and reverse-order deferred payloads never relabel the current scope", () => {
  const { root, next, current } = mountPair();
  const firstGeneration = adoptNearYouDocumentScope(root, next, {
    importNode: (node) => current.doc.importNode(node, true),
  });
  const staleGeneration = firstGeneration;
  const currentGeneration = beginNearYouDeferredGeneration(root);

  assert.equal(isNearYouDeferredGenerationCurrent(root, staleGeneration), false);
  assert.equal(isNearYouDeferredGenerationCurrent(root, currentGeneration), true);

  const stale = applyNearYouDeferredPayload(root, staffingDeferredPayload(), {
    generation: staleGeneration,
    parseHtml: (html) => parseHtml(current.doc, html),
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale_generation");
  assert.match(root.querySelector("#near-results-heading")?.textContent || "", /Meetings/);
  assert.equal(root.querySelector("[data-record-id='staff-stale']"), null);

  const ready = applyNearYouDeferredPayload(root, meetingsDeferredPayload(), {
    generation: currentGeneration,
    parseHtml: (html) => parseHtml(current.doc, html),
  });
  assert.equal(ready.applied, true);
  assert.equal(root.querySelectorAll("[data-record-id='meet-1']").length, 1);
  assert.equal(root.querySelectorAll("[data-record-id='staff-stale']").length, 0);
});

test("A2 negative fixture: failed deferred load stays an error, not an empty success", () => {
  const { root, next, current } = mountPair();
  const generation = adoptNearYouDocumentScope(root, next, {
    importNode: (node) => current.doc.importNode(node, true),
  });
  assert.throws(
    () => applyNearYouDeferredPayload(root, {
      schema: "cityscroll.near_you_deferred.v1",
      results_html: null,
      bags_html: null,
    }, {
      generation,
      parseHtml: (html) => parseHtml(current.doc, html),
    }),
    /near-you-deferred-payload-invalid/,
  );
  assert.equal(root.dataset.nearDeferredState, "pending");
  assert.ok(root.querySelector("[data-near-deferred='results']"));
  assert.equal(root.querySelector("[data-results-count]"), null);
});

test("region ownership includes resolved result and bag selectors", () => {
  assert.ok(NEAR_YOU_SCOPE_REGION_SELECTORS.includes(".near-scope"));
  assert.ok(NEAR_YOU_SCOPE_REGION_SELECTORS.includes(".near-results"));
  assert.ok(NEAR_YOU_SCOPE_REGION_SELECTORS.includes(".near-bags"));
  const mapSource = readFileSync(join(ROOT, MAP_PATH), "utf8");
  const adoptionSource = readFileSync(join(ROOT, ADOPTION_PATH), "utf8");
  assert.match(mapSource, /adoptNearYouDocumentScope/);
  assert.match(mapSource, /applyNearYouDeferredPayload|isNearYouDeferredGenerationCurrent/);
  assert.doesNotMatch(mapSource, /hydrateNearYouDeferredData/);
  assert.match(adoptionSource, /adoptNearYouDocumentScope/);
});

test("A4 evidence records the K15 Staffing-to-Meetings journey with revision and viewport", () => {
  assert.equal(existsSync(EVIDENCE_PATH), true);
  const manifest = JSON.parse(readFileSync(join(ROOT, EVIDENCE_PATH), "utf8"));
  assert.equal(manifest.schema, "cityscroll.near_you_scope_adoption_acceptance.v1");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.route, ROUTE);
  assert.deepEqual(manifest.viewport, [...VIEWPORT]);
  assert.equal(manifest.fixture_vintage, FIXTURE_VINTAGE);
  assert.ok(manifest.assertions.some((row) => row.id === "shell-marker-mixed-view" && row.result === "rejected"));
  assert.ok(manifest.assertions.some((row) => row.id === "atomic-meetings-adoption" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "stale-generation-ignored" && row.result === "accepted"));
  assert.ok(manifest.journey.sequence.includes("change_topic"));
  for (const banned of ["needs_james", "card_standard", "richness_profile", "autodispatch", "realization_gate"]) {
    assert.equal(JSON.stringify(manifest).includes(banned), false, banned);
  }
  const digest = createHash("sha256").update(`${JSON.stringify(manifest.assertions)}\n`).digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});

// Separately loaded Near You sections (public alias ccfaadd338534): deferred payloads
// come from the real Worker handler over frozen rows with one injected KV fault,
// and are applied to the real server document through the adoption functions.
import { handleNearYou } from "../worker/src/near_you.mjs";
import { buildNearYou } from "../tools/build_worker_route_read_models.mjs";
import {
  applyNearYouSectionRetry,
  nearYouDeferredPayloadHasMarkup,
} from "../site/near_you_scope_adoption.mjs";
import {
  MIDWOOD,
  faultKv,
  readSectionIsolationFixture,
} from "./helpers/near_you_section_isolation_fixture.mjs";

const { provenance: _sectionProvenance, ...sectionRows } = readSectionIsolationFixture();
const sectionBuild = buildNearYou(sectionRows, {}, "section-isolation");
const sectionValues = new Map(sectionBuild.entries.map(({ key, value }) => [key, value]));
sectionValues.set("route-read-model:near-you:manifest:v1", JSON.stringify(sectionBuild.manifest));
const sectionKey = (id) => sectionBuild.manifest.slices[`${id}:meetings`];
const MIDWOOD_URL = "https://cityscroll.org/near-you/?geo=nta2020:BK1403&lens=meetings&surface=records";
const MIDWOOD_IDS = sectionRows.geography_items.by_key[MIDWOOD].meetings.map(String).sort();
const CITYWIDE_IDS = sectionRows.district_items.citywide.meetings.map(String).sort();
// At the frozen clock the citywide preview is the next two meetings, then the most recent past one.
const CITYWIDE_CLOCK = "2026-09-28T16:00:00.000Z";
const CITYWIDE_PREVIEW_IDS = ["20260826001", "meeting:nyc_legistar_events:22568", "20260817025"];

async function served(url, controls = []) {
  const env = { ALERT_STATE: faultKv(sectionValues, new Map(controls)), NEAR_YOU_READ_MODEL_TIMEOUT_MS: 20 };
  const response = await handleNearYou(new Request(url), env);
  return url.includes("/deferred.json") ? response.json() : response.text();
}

/** The served document's own deferred shells, mounted in a minimal Near You root. */
function servedShell(page, part) {
  const start = page.indexOf(`<section class="near-${part} near-${part}-shell`);
  assert.ok(start >= 0, `${part} shell is served`);
  return page.slice(start, page.indexOf("</section>", start) + "</section>".length);
}

async function mountMidwood() {
  const page = await served(MIDWOOD_URL);
  const deferredHref = page.match(/data-near-deferred-href="([^"]+)"/)[1];
  const mounted = mountDocument(`<main id="main" data-near-you-root data-lens="meetings"
    data-near-deferred-href="${deferredHref}" data-near-deferred-state="pending">
    ${servedShell(page, "results")}
    ${servedShell(page, "bags")}
  </main>`, { containerClass: "near-sections" });
  const root = mounted.doc.querySelector("[data-near-you-root]");
  assert.ok(root.querySelector("[data-near-deferred='results']"));
  return { root, doc: mounted.doc, parse: (html) => parseHtml(mounted.doc, html) };
}

function sectionIds(node) {
  return (node?.querySelectorAll("[data-record-id]") || [])
    .filter((row) => row.tagName === "li")
    .map((row) => row.getAttribute("data-record-id")).sort();
}

const deferredUrl = MIDWOOD_URL.replace("/near-you/?", "/near-you/deferred.json?");

test("A5/A7: a partial payload applies loaded sections and keeps the failed one explicit", async () => {
  const { root, parse } = await mountMidwood();
  const generation = beginNearYouDeferredGeneration(root);
  const payload = await served(deferredUrl, [[sectionKey("citywide"), "reject"]]);
  assert.equal(nearYouDeferredPayloadHasMarkup(payload), true);
  const applied = applyNearYouDeferredPayload(root, payload, { generation, parseHtml: parse });
  assert.equal(applied.applied, true);
  assert.equal(applied.partial, true);
  assert.equal(root.dataset.nearDeferredState, "partial");
  assert.deepEqual(sectionIds(root.querySelector(".near-results")), MIDWOOD_IDS);
  assert.equal(root.querySelector(".near-results").querySelectorAll("[data-near-you-record-inspection]").length, MIDWOOD_IDS.length);
  const citywide = root.querySelector("[data-bag='citywide']");
  assert.equal(citywide.getAttribute("data-near-section-state"), "unavailable");
  assert.deepEqual(sectionIds(citywide), []);

  // Control: a whole-page error envelope carries no markup and is refused.
  assert.equal(nearYouDeferredPayloadHasMarkup({ schema: "cityscroll.near_you_deferred_error.v1", reason: "x" }), false);
});

test("A2/A5: Retry replaces only the failed section, and a failed retry keeps the loaded ones", () => withPinnedClock(CITYWIDE_CLOCK, async () => {
  const { root, parse } = await mountMidwood();
  const first = beginNearYouDeferredGeneration(root);
  applyNearYouDeferredPayload(root, await served(deferredUrl, [[sectionKey("citywide"), "reject"]]), { generation: first, parseHtml: parse });
  const midwoodBefore = root.querySelector(".near-results");
  const virtualBefore = root.querySelector("[data-bag='virtual']");

  // A retry whose Midwood read now fails but whose citywide read succeeds.
  const retry = beginNearYouDeferredGeneration(root);
  const flaky = await served(deferredUrl, [[sectionKey(MIDWOOD), "reject"]]);
  const outcome = applyNearYouSectionRetry(root, flaky, { generation: retry, parseHtml: parse });
  assert.deepEqual(outcome.replaced, ["citywide"]);
  assert.equal(root.dataset.nearDeferredState, "ready");
  assert.equal(root.querySelector(".near-results"), midwoodBefore, "the loaded local section is untouched");
  assert.equal(root.querySelector("[data-bag='virtual']"), virtualBefore);
  assert.deepEqual(sectionIds(root.querySelector(".near-results")), MIDWOOD_IDS);
  // The restored section is the bounded preview over the whole bucket's total.
  const restored = root.querySelector("[data-bag='citywide']");
  assert.deepEqual(sectionIds(restored), [...CITYWIDE_PREVIEW_IDS].sort());
  assert.ok(CITYWIDE_PREVIEW_IDS.every((id) => CITYWIDE_IDS.includes(id)));
  assert.equal(restored.querySelector("strong").textContent, String(CITYWIDE_IDS.length));
  assert.equal(root.querySelector("[data-near-section-state]"), null);

  // Converse: a retry that fails again leaves the explicit failure in place.
  const again = await mountMidwood();
  const g = beginNearYouDeferredGeneration(again.root);
  applyNearYouDeferredPayload(again.root, await served(deferredUrl, [[sectionKey("virtual"), "reject"]]), { generation: g, parseHtml: again.parse });
  const failedAgain = applyNearYouSectionRetry(again.root, await served(deferredUrl, [[sectionKey("virtual"), "timeout"]]), {
    generation: beginNearYouDeferredGeneration(again.root),
    parseHtml: again.parse,
  });
  assert.equal(failedAgain.applied, false);
  assert.equal(failedAgain.reason, "still_unavailable");
  assert.equal(again.root.querySelector("[data-bag='virtual']").getAttribute("data-near-section-state"), "unavailable");
  assert.equal(again.root.dataset.nearDeferredState, "partial");
}));

test("A5: a retry overtaken by a newer place selection or a second retry never repaints", async () => {
  const { root, parse } = await mountMidwood();
  const first = beginNearYouDeferredGeneration(root);
  applyNearYouDeferredPayload(root, await served(deferredUrl, [[sectionKey("citywide"), "reject"]]), { generation: first, parseHtml: parse });
  const retry = beginNearYouDeferredGeneration(root);
  const secondRetry = beginNearYouDeferredGeneration(root);
  const response = await served(deferredUrl);
  const stale = applyNearYouSectionRetry(root, response, { generation: retry, parseHtml: parse });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale_generation");
  assert.equal(root.querySelector("[data-bag='citywide']").getAttribute("data-near-section-state"), "unavailable");

  // A newer place adoption bumps the generation past the pending retry.
  const nextPlace = mountDocument(meetingsPendingMarkup(), { containerClass: "near-next" }).doc.querySelector("[data-near-you-root]");
  adoptNearYouDocumentScope(root, nextPlace, { importNode: (node) => node.cloneNode(true) });
  const late = applyNearYouSectionRetry(root, response, { generation: secondRetry, parseHtml: parse });
  assert.equal(late.applied, false);
  assert.equal(late.reason, "stale_generation");
  assert.equal(root.querySelectorAll("[data-record-id]").length, 0, "no Midwood or citywide record repaints the newer place");
  assert.match(root.dataset.nearDeferredHref, /cd=K15/);
});

// Neighborhood suggestions (public alias c0cece577f277) are a document region:
// adopting a selected place removes them, and adopting a new filter replaces
// them with that filter's own links.
import { readPlaceSuggestionsFixture } from "./helpers/near_you_place_suggestions_fixture.mjs";

const suggestionBuild = buildNearYou(readPlaceSuggestionsFixture().activity, {}, "place-suggestions");
const suggestionValues = new Map(suggestionBuild.entries.map(({ key, value }) => [key, value]));
suggestionValues.set("route-read-model:near-you:manifest:v1", JSON.stringify(suggestionBuild.manifest));

async function servedSuggestionsPage(query) {
  const response = await handleNearYou(new Request(`https://cityscroll.org/near-you/?${query}`), {
    ALERT_STATE: faultKv(suggestionValues),
  });
  return response.text();
}

/** The served suggestion row (or nothing) inside a minimal Near You root. */
function mountSuggestionRegion(page) {
  const nav = page.match(/<nav class="near-place-suggestions"[\s\S]*?<\/nav>/)?.[0] || "";
  const mounted = mountDocument(`<main id="main" data-near-you-root data-lens="meetings" data-near-deferred-state="pending">
    <section class="near-geo-workspace"><p>map</p></section>${nav}
  </main>`, { containerClass: "near-suggestions" });
  return mounted.doc.querySelector("[data-near-you-root]");
}

const suggestionLinkIds = (root) => root.querySelectorAll("[data-near-place-suggestion]")
  .map((link) => `${link.getAttribute("data-near-place-suggestion")}:${link.getAttribute("data-count")}`);

test("adopting a selected place removes the suggestions; adopting a new filter replaces them", async () => {
  assert.ok(NEAR_YOU_SCOPE_REGION_SELECTORS.includes(".near-place-suggestions"));
  const root = mountSuggestionRegion(await servedSuggestionsPage("lens=meetings"));
  assert.deepEqual(suggestionLinkIds(root), ["MN0102:26", "MN0402:12", "MN0101:9"]);

  const filtered = mountSuggestionRegion(await servedSuggestionsPage("lens=meetings&q=landmarks"));
  adoptNearYouDocumentScope(root, filtered);
  assert.deepEqual(suggestionLinkIds(root), ["MN0102:10", "MN0202:1"]);
  assert.equal(root.querySelectorAll(".near-place-suggestions").length, 1);

  const selected = mountSuggestionRegion(await servedSuggestionsPage("geo=nta2020:MN0102&lens=meetings&surface=records"));
  assert.equal(selected.querySelector(".near-place-suggestions"), null, "a selected place serves no suggestions");
  adoptNearYouDocumentScope(root, selected);
  assert.equal(root.querySelector(".near-place-suggestions"), null);
  assert.deepEqual(suggestionLinkIds(root), []);
});

// Deploy skew: the Worker renders Near You documents and deploys ahead of the
// Pages-served client, so a document can carry a root region this client's
// selector list has never heard of. A region that names itself is adopted by
// its name, so it cannot survive a move to a scope that no longer carries it.
function namedRegionRoot(regions) {
  const mounted = mountDocument(`<main id="main" data-near-you-root data-lens="meetings" data-near-deferred-state="pending">
    ${regions}
    <section class="near-geo-workspace"><p>map</p></section>
  </main>`, { containerClass: "near-named-regions" });
  return mounted.doc.querySelector("[data-near-you-root]");
}

const newerRow = (text) => `<nav class="near-newer-row" ${NEAR_YOU_SCOPE_REGION_ATTRIBUTE}="newer-row"><p>${text}</p></nav>`;

test("a named root region no selector lists is removed, replaced or added by its name", () => {
  assert.equal(NEAR_YOU_SCOPE_REGION_ATTRIBUTE, "data-near-scope-region");
  assert.ok(!NEAR_YOU_SCOPE_REGION_SELECTORS.includes(".near-newer-row"), "the row must be unknown to the list");

  const root = namedRegionRoot(newerRow("entry row"));
  adoptNearYouDocumentScope(root, namedRegionRoot(""));
  assert.equal(root.querySelector(".near-newer-row"), null, "a selected scope without the row removes it");

  const replaced = namedRegionRoot(newerRow("first filter"));
  adoptNearYouDocumentScope(replaced, namedRegionRoot(newerRow("second filter")));
  assert.deepEqual(replaced.querySelectorAll(".near-newer-row").map((node) => node.textContent.trim()), ["second filter"]);

  const added = namedRegionRoot("");
  adoptNearYouDocumentScope(added, namedRegionRoot(newerRow("returned to the entry")));
  assert.deepEqual(added.querySelectorAll(".near-newer-row").map((node) => node.textContent.trim()), ["returned to the entry"]);
  assert.equal(added.querySelectorAll(".near-geo-workspace").length, 1);
});

test("a named region that also matches a listed selector is adopted once", () => {
  const named = `<nav class="near-place-suggestions" ${NEAR_YOU_SCOPE_REGION_ATTRIBUTE}="place-suggestions"><p>old</p></nav>`;
  const root = namedRegionRoot(named);
  adoptNearYouDocumentScope(root, namedRegionRoot(named.replace("old", "new")));
  assert.deepEqual(root.querySelectorAll(".near-place-suggestions").map((node) => node.textContent.trim()), ["new"]);
  adoptNearYouDocumentScope(root, namedRegionRoot(""));
  assert.equal(root.querySelector(".near-place-suggestions"), null);
});
