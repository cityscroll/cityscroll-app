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
  NEAR_YOU_SCOPE_REGION_SELECTORS,
} from "../site/near_you_scope_adoption.mjs";
import { mountDocument } from "./helpers/preview_dom.mjs";

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
