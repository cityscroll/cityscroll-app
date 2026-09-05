import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import { OFFICIAL_SOURCES } from "../site/consequence_projection.mjs";
import {
  EXPLAINER_COPY_KEYS,
  explainerCopyAvailable,
  EXPLAINER_EXAMPLES,
  EXPLAINER_HOST_ATTR,
  EXPLAINER_PANEL_ID,
  EXPLAINER_SECTIONS,
  explainerSectionLanguage,
  publicInputExplainerHTML,
  resolveExplainerCopy,
} from "../site/public_input_explainer.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const STRINGS = globalThis.window.STRINGS;
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const INDEX_HTML = readFileSync("site/index.html", "utf8");
const MEETING_DOCUMENT = readFileSync("site/meeting_document.mjs", "utf8");
const EXPLAINER_SOURCE = readFileSync("site/public_input_explainer.mjs", "utf8");

const render = (opts = {}) => publicInputExplainerHTML({ strings: STRINGS, lang: "en", ...opts });
const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** The slice of index.html between two markers, for placement assertions. */
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker ${endMarker}`);
  return source.slice(start, end);
}

test("A1: the explainer is one action away from the Meetings context and keeps focus on the control that opened it", () => {
  // The host sits inside the Meetings intro, immediately under the heading and
  // its method disclosure, so reaching the explainer is one action from the
  // context rather than a route change.
  const intro = between(INDEX_HTML, 'class="meetings-domain-intro lens-intro"', '<div class="lens-toolbar" id="meetings-toolbar">');
  assert.match(intro, new RegExp(`${EXPLAINER_HOST_ATTR}="meetings-heading"`));

  // A native disclosure is the whole open/close mechanism. The summary is the
  // invoking control and the browser never moves focus off it, so closing
  // returns reading position to the control that opened it without any script
  // having to restore focus.
  const html = render();
  assert.match(html, /^<details class="public-input-explainer"/);
  assert.match(html, /<summary class="public-input-explainer-summary"/);
  assert.doesNotMatch(EXPLAINER_SOURCE, /\.focus\(/, "focus is never moved off the invoking control");
  assert.doesNotMatch(EXPLAINER_SOURCE, /addEventListener/, "opening is the browser's own disclosure behaviour");
});

test("A1 negative rule: no global navigation item is added", () => {
  for (const nav of INDEX_HTML.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/g) || []) {
    assert.doesNotMatch(nav, /public-input-explainer/);
  }
  for (const tab of INDEX_HTML.match(/class="[^"]*tabbtn[^"]*"[^>]*>[^<]*/g) || []) {
    assert.doesNotMatch(tab, /public input/i);
  }
});

test("A2: the explainer sits outside the results list and carries none of a card's own fields", () => {
  const introToFeed = between(INDEX_HTML, 'class="meetings-domain-intro lens-intro"', 'id="meetingsfeed"');
  assert.match(introToFeed, new RegExp(EXPLAINER_HOST_ATTR), "the host renders before the results feed");
  const feedOnward = INDEX_HTML.slice(INDEX_HTML.indexOf('id="meetingsfeed"'));
  assert.doesNotMatch(feedOnward, new RegExp(EXPLAINER_HOST_ATTR), "no host inside or after the results feed");

  // Date, status, purpose and participation actions are the result card's own
  // fields. The explainer renders none of them, so it can neither replace nor
  // reorder what a card exists to show.
  const html = render();
  for (const cardField of [
    "fcard", "hcard", "hfact", "ftype", "ftitle", "meetings-process-line",
    "meeting-purpose", "meetings-action-lead", "ui-object-card-action-rail",
  ]) {
    assert.doesNotMatch(html, new RegExp(cardField), `explainer must not render ${cardField}`);
  }
});

test("A3: five destinations stay distinct and a report is not the universal one", () => {
  const destinations = STRINGS.en.public_input_explainer_destinations_html;
  const items = (destinations.match(/<li>[\s\S]*?<\/li>/g) || []).map(textOf);
  assert.equal(items.length, 5, "one list item per destination");
  assert.equal(new Set(items).size, 5, "no destination is stated twice");

  const named = items.join(" ").toLowerCase();
  for (const destination of ["comment record", "testimony", "transcript", "minutes", "decision"]) {
    assert.ok(named.includes(destination), `destination ${destination} is named separately`);
  }
  // A report is one destination among these, and it appears outside the list
  // with the qualifier that says so, never as what happens to every comment.
  assert.doesNotMatch(named, /\breport\b/, "no list item makes a report a destination in itself");
  const tail = textOf(destinations.slice(destinations.lastIndexOf("</ul>")));
  assert.match(tail, /report/i);
  assert.match(tail, /one of these destinations/i);
});

test("A4: the copy promises no answer from officials and treats no comment volume as a vote", () => {
  const body = textOf(render());
  assert.match(body, /no official is required to answer you/i);
  assert.match(body, /promises no such answer/i);
  assert.match(body, /treats no comment volume as a vote/i);

  const forbidden = [
    /\bwill (?:respond|reply|answer|get back)\b/i,
    /\bguarantee[sd]?\b/i,
    /\byou(?:r)? (?:comment|testimony) (?:counts as|is) a vote\b/i,
    /\bthe more comments\b/i,
    /\bmajority of comments\b/i,
    /\bofficials must (?:reply|respond|answer)\b/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(body, pattern, `overpromising shape ${pattern} must not appear`);
  }
});

test("A5: each example links to a product surface and to an official source", () => {
  const html = render();
  const officialUrls = new Set(Object.values(OFFICIAL_SOURCES));
  assert.equal(EXPLAINER_EXAMPLES.length, 3);

  for (const example of EXPLAINER_EXAMPLES) {
    assert.match(example.surface_href, /^#(meetings|rules|money)$/, "the surface link is a product route");
    assert.ok(officialUrls.has(example.official_source_url), "the official source is one PHC-00 already names");
    assert.match(html, new RegExp(`href="${example.surface_href}" data-explainer-surface="${example.id}"`));
    assert.match(html, new RegExp(`href="${example.official_source_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    // Distinct accessible names: each official link is labelled with its own
    // publisher, so three links never read as one repeated "official source".
    assert.match(html, new RegExp(example.official_source_name.replace(/'/g, "&#39;")));
  }
  const sourceNames = EXPLAINER_EXAMPLES.map((example) => example.official_source_name);
  assert.equal(new Set(sourceNames).size, 3);
  assert.match(html, /<details class="public-input-explainer-method">/, "the method disclosure names where this comes from");
});

test("A6: every explainer key exists in English and in every shipping language", () => {
  for (const key of EXPLAINER_COPY_KEYS) {
    assert.equal(typeof STRINGS.en[key], "string", `en is missing ${key}`);
    assert.ok(STRINGS.en[key].length, `en ${key} is empty`);
    for (const lang of SHIPPING_LANGS) {
      assert.equal(typeof STRINGS[lang][key], "string", `${lang} is missing ${key}`);
      assert.ok(STRINGS[lang][key].length, `${lang} ${key} is empty`);
    }
  }
  assert.equal(new Set(EXPLAINER_COPY_KEYS).size, EXPLAINER_COPY_KEYS.length, "no key is claimed twice");
});

test("A6: a partially-translated language falls back a whole section at a time", () => {
  const partial = {
    en: STRINGS.en,
    xx: Object.fromEntries(
      EXPLAINER_COPY_KEYS
        .filter((key) => key !== "public_input_explainer_example_rule_surface")
        .map((key) => [key, `xx ${key}`]),
    ),
  };

  assert.equal(explainerSectionLanguage("examples", { lang: "xx", strings: partial }), "en");
  assert.equal(explainerSectionLanguage("limits", { lang: "xx", strings: partial }), "xx");

  const copy = resolveExplainerCopy({ lang: "xx", strings: partial });
  // The one missing key takes its whole section back to English rather than
  // leaving a translated heading over an English list.
  for (const key of EXPLAINER_SECTIONS.find((section) => section.id === "examples").keys) {
    assert.equal(copy.sections.examples.strings[key], STRINGS.en[key], `${key} falls back with its section`);
  }
  assert.equal(copy.sections.limits.strings.public_input_explainer_limits_heading, "xx public_input_explainer_limits_heading");

  // Nothing renders a fragment in one language inside a block marked as another.
  const html = publicInputExplainerHTML({ lang: "xx", strings: partial });
  assert.match(html, /class="public-input-explainer-examples" lang="en"/);
  assert.match(html, /class="public-input-explainer-limits" data-explainer-limits="1" lang="xx"/);
  assert.doesNotMatch(html, /xx public_input_explainer_example_/, "no half-translated example survives");
});

test("A6: a language with no dictionary at all renders wholly in English", () => {
  const copy = resolveExplainerCopy({ lang: "zh-Hant", strings: { en: STRINGS.en } });
  for (const section of EXPLAINER_SECTIONS) {
    assert.equal(copy.sections[section.id].language, "en", `${section.id} falls back cleanly`);
  }
  assert.equal(textOf(publicInputExplainerHTML({ lang: "zh-Hant", strings: { en: STRINGS.en } })), textOf(render()));
});

test("A7: one component renders both presentations, with one set of focus targets", () => {
  const html = render();
  assert.equal((html.match(new RegExp(`id="${EXPLAINER_PANEL_ID}"`, "g")) || []).length, 1);
  assert.equal((html.match(/class="public-input-explainer-summary"/g) || []).length, 1);
  assert.equal((html.match(/public-input-explainer-body/g) || []).length, 1);
  assert.equal((html.match(/data-explainer-surface=/g) || []).length, EXPLAINER_EXAMPLES.length);

  // No width-conditional rendering: presentation is CSS's decision alone, which
  // is what keeps the inline and sheet renderings from drifting in copy.
  assert.doesNotMatch(EXPLAINER_SOURCE, /matchMedia|innerWidth|clientWidth|getBoundingClientRect/);

  // Both presentations exist in one stylesheet rule set over the same element.
  assert.match(INDEX_HTML, /\.public-input-explainer\{margin:12px 0 0;/, "the wide inline presentation");
  assert.match(
    INDEX_HTML,
    /@media\(max-width:680px\)\{\s*\.public-input-explainer\{[^}]*margin-inline:calc\(50% - 50vw\)/,
    "the narrow full-width sheet",
  );
});

test("A6: a surface with no dictionary renders nothing rather than raw key names", () => {
  // The generated meeting detail document is an English-literal surface that
  // loads no dictionary. Rendering this component there would have put its own
  // key names on the page, so it renders on the application surface only, and
  // the component refuses to render itself without the strings it reads.
  assert.equal(explainerCopyAvailable({}), false);
  assert.equal(publicInputExplainerHTML({ lang: "en", strings: {} }), "");
  assert.doesNotMatch(MEETING_DOCUMENT, /public_input_explainer/);

  const html = render();
  for (const key of EXPLAINER_COPY_KEYS) {
    assert.doesNotMatch(html, new RegExp(`>${key}<`), `${key} must never render as its own name`);
  }
});

test("the explainer stays mounted from one place in the application shell", () => {
  const boot = readFileSync("site/app/boot.mjs", "utf8");
  assert.match(boot, /import\("\.\.\/public_input_explainer\.mjs"\)/);
  assert.match(boot, /mountPublicInputExplainerPanel\(\);/);
  assert.equal((INDEX_HTML.match(new RegExp(EXPLAINER_HOST_ATTR, "g")) || []).length, 1, "one host, one rendering");
});
