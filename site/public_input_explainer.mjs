/**
 * PHC-09 — one compact, shared explainer of how public input works, reachable
 * in a single action from the Meetings context and from the consequence
 * disclosure on a meeting detail page.
 *
 * Why this module exists at all: an explainer speaks generally, and it is read
 * by the people with the least context to correct it, so it is where an
 * overpromise costs the most. Publishing it after the workstream's specific
 * surfaces settled is what lets every claim here point back at a surface that
 * already makes the same claim from evidence.
 *
 * Three properties are load-bearing:
 *
 * One content component. `publicInputExplainerHTML()` returns a single
 * disclosure element. The wide inline presentation and the narrow full-width
 * sheet are that same markup under different CSS, so the two presentations
 * carry identical copy and a keyboard reader meets one control at either
 * width. Opening and closing is the browser's own disclosure behaviour, which
 * is also what returns reading position to the control that opened it.
 *
 * Whole sections translate together. Copy is authored as i18n dictionary keys
 * grouped into sections, and a section renders in the active language only when
 * that language carries every key in it. A section missing one key renders
 * wholly in English, so a reader meets complete sentences in one language
 * instead of a paragraph that changes language mid-thought.
 *
 * Each example carries two links. A general claim is anchored by the product
 * surface where live records of that kind are listed, and by the official
 * source that governs it, named in the explainer's own method disclosure. Both
 * URLs come from PHC-00's shared official-source table rather than being
 * restated here.
 *
 * This is an i18n surface: it holds no copy of its own and reads every string
 * from the shared dictionary. A caller with no dictionary available renders
 * nothing at all rather than a page of raw key names, so a surface that does
 * not load i18n.js cannot accidentally ship this component untranslated.
 */

import { OFFICIAL_SOURCES } from "./consequence_projection.mjs";

export const PUBLIC_INPUT_EXPLAINER_SCHEMA = "cityscroll.public_input_explainer.v1";

/** The disclosure's stable element id — one instance per page, one focus target. */
export const EXPLAINER_PANEL_ID = "public-input-explainer";

/** Marks a container the one explainer renders into. */
export const EXPLAINER_HOST_ATTR = "data-public-input-explainer-host";

/**
 * Copy sections, each a translation fallback unit. A language carrying every
 * key in a section renders that section; a language missing any one of them
 * renders the whole section in English.
 */
export const EXPLAINER_SECTIONS = Object.freeze([
  Object.freeze({
    id: "chrome",
    keys: Object.freeze(["public_input_explainer_open"]),
  }),
  Object.freeze({
    id: "what",
    keys: Object.freeze(["public_input_explainer_what_html"]),
  }),
  Object.freeze({
    id: "destinations",
    keys: Object.freeze([
      "public_input_explainer_destinations_heading",
      "public_input_explainer_destinations_html",
    ]),
  }),
  Object.freeze({
    id: "limits",
    keys: Object.freeze([
      "public_input_explainer_limits_heading",
      "public_input_explainer_limits_html",
    ]),
  }),
  Object.freeze({
    id: "examples",
    keys: Object.freeze([
      "public_input_explainer_examples_heading",
      "public_input_explainer_example_hearing",
      "public_input_explainer_example_hearing_surface",
      "public_input_explainer_example_rule",
      "public_input_explainer_example_rule_surface",
      "public_input_explainer_example_contract",
      "public_input_explainer_example_contract_surface",
      "public_input_explainer_official_source",
    ]),
  }),
  Object.freeze({
    id: "method",
    keys: Object.freeze([
      "public_input_explainer_method_summary",
      "public_input_explainer_method_html",
    ]),
  }),
]);

/** Every key this explainer reads, sorted, for the parity and reference gates. */
export const EXPLAINER_COPY_KEYS = Object.freeze(
  EXPLAINER_SECTIONS.flatMap((section) => section.keys).slice().sort(),
);

/**
 * The three worked examples. Each names the product surface where live records
 * of that kind are listed and the official source that governs it. The URLs are
 * PHC-00's, so a source correction lands in one place.
 */
export const EXPLAINER_EXAMPLES = Object.freeze([
  Object.freeze({
    id: "hearing",
    title_key: "public_input_explainer_example_hearing",
    surface_label_key: "public_input_explainer_example_hearing_surface",
    surface_href: "#meetings",
    official_source_url: OFFICIAL_SOURCES.councilTestimony,
    official_source_name: "NYC Council testimony",
  }),
  Object.freeze({
    id: "rule",
    title_key: "public_input_explainer_example_rule",
    surface_label_key: "public_input_explainer_example_rule_surface",
    surface_href: "#rules",
    official_source_url: OFFICIAL_SOURCES.capa,
    official_source_name: "NYC Rules",
  }),
  Object.freeze({
    id: "contract",
    title_key: "public_input_explainer_example_contract",
    surface_label_key: "public_input_explainer_example_contract_surface",
    surface_href: "#money",
    official_source_url: OFFICIAL_SOURCES.mocsPublicComment,
    official_source_name: "Mayor's Office of Contract Services",
  }),
]);

function dictionaries(strings) {
  const table = strings || globalThis.STRINGS || {};
  return { table, en: table.en || {} };
}

/**
 * Which language a section renders in: the active one when it carries every key
 * in the section, English otherwise. Resolving per section rather than per key
 * is what keeps a partially-translated dictionary from producing a paragraph
 * that changes language mid-thought.
 */
export function explainerSectionLanguage(sectionId, { lang = null, strings = null } = {}) {
  const section = EXPLAINER_SECTIONS.find((entry) => entry.id === sectionId);
  if (!section) return "en";
  const active = lang || globalThis.LANG || "en";
  if (active === "en") return "en";
  const { table } = dictionaries(strings);
  const dict = table[active];
  if (!dict) return "en";
  return section.keys.every((key) => typeof dict[key] === "string" && dict[key]) ? active : "en";
}

/**
 * Per-section resolved copy: the language each section renders in and the
 * strings it renders. This is the whole of the fallback contract, exposed so a
 * test and a capture can assert it without a browser.
 */
export function resolveExplainerCopy({ lang = null, strings = null } = {}) {
  const active = lang || globalThis.LANG || "en";
  const { table, en } = dictionaries(strings);
  const sections = {};
  for (const section of EXPLAINER_SECTIONS) {
    const language = explainerSectionLanguage(section.id, { lang: active, strings: table });
    const dict = language === "en" ? en : (table[language] || en);
    const resolved = {};
    for (const key of section.keys) {
      const value = dict[key];
      resolved[key] = typeof value === "string" && value ? value : (en[key] || key);
    }
    sections[section.id] = Object.freeze({ language, strings: Object.freeze(resolved) });
  }
  return Object.freeze({
    schema: PUBLIC_INPUT_EXPLAINER_SCHEMA,
    requested_language: active,
    sections: Object.freeze(sections),
  });
}

/** Whether the English dictionary this component reads every string from is loaded. */
export function explainerCopyAvailable(strings = null) {
  const { en } = dictionaries(strings);
  return EXPLAINER_COPY_KEYS.every((key) => typeof en[key] === "string" && en[key]);
}

function defaultEsc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function exampleHTML(example, read, esc) {
  // The source's own name carries into the link label so the three official
  // links have three distinct accessible names. Publisher names stay in
  // English, marked as such, like every other proper-noun island on this site.
  const sourceLabel = read("public_input_explainer_official_source")
    .replace(/\{source\}/g, example.official_source_name);
  return `<li class="public-input-explainer-example" data-explainer-example="${esc(example.id)}">
        <p class="public-input-explainer-example-title">${esc(read(example.title_key))}</p>
        <p class="public-input-explainer-example-links"><a class="public-input-explainer-surface" href="${esc(example.surface_href)}" data-explainer-surface="${esc(example.id)}">${esc(read(example.surface_label_key))}</a><a class="public-input-explainer-source" href="${esc(example.official_source_url)}" target="_blank" rel="noopener noreferrer" data-explainer-source="${esc(example.id)}"><span lang="en" dir="ltr">${esc(sourceLabel)}</span><span aria-hidden="true"> ↗</span></a></p>
      </li>`;
}

/**
 * The explainer, as one component.
 *
 * The root is a disclosure, so a single action opens it, the same action closes
 * it, and reading position stays on the control that did both. Presentation is
 * chosen by CSS from the viewport width alone: the markup, the copy and the
 * focus targets are the same inline and as a sheet.
 *
 * `headingLevel` lets the host page place the panel's subheadings correctly in
 * its own outline without changing anything a reader sees.
 */
export function publicInputExplainerHTML(opts = {}) {
  const esc = typeof opts.escape === "function" ? opts.escape : defaultEsc;
  const level = opts.headingLevel === 4 ? "h4" : "h3";
  // Without the English dictionary every string would resolve to its own key
  // name. Rendering nothing is the honest outcome for a caller that has no
  // dictionary; a raw key on a reader's screen is not.
  if (!explainerCopyAvailable(opts.strings || null)) return "";
  const copy = resolveExplainerCopy({ lang: opts.lang || null, strings: opts.strings || null });
  const read = (key) => {
    const section = EXPLAINER_SECTIONS.find((entry) => entry.keys.includes(key));
    return copy.sections[section ? section.id : "chrome"].strings[key] || key;
  };
  const langAttr = (sectionId) => ` lang="${esc(copy.sections[sectionId].language)}"`;
  const subhead = (sectionId, key) =>
    `<${level} class="public-input-explainer-subhead"${langAttr(sectionId)}>${esc(read(key))}</${level}>`;
  const examples = EXPLAINER_EXAMPLES.map((example) => exampleHTML(example, read, esc)).join("");

  return `<details class="public-input-explainer" id="${esc(EXPLAINER_PANEL_ID)}" data-public-input-explainer="1">
    <summary class="public-input-explainer-summary"${langAttr("chrome")}>${esc(read("public_input_explainer_open"))}</summary>
    <div class="public-input-explainer-body">
      <div class="public-input-explainer-what"${langAttr("what")}>${read("public_input_explainer_what_html")}</div>
      ${subhead("destinations", "public_input_explainer_destinations_heading")}
      <div class="public-input-explainer-destinations" data-explainer-destinations="1"${langAttr("destinations")}>${read("public_input_explainer_destinations_html")}</div>
      ${subhead("limits", "public_input_explainer_limits_heading")}
      <div class="public-input-explainer-limits" data-explainer-limits="1"${langAttr("limits")}>${read("public_input_explainer_limits_html")}</div>
      ${subhead("examples", "public_input_explainer_examples_heading")}
      <ul class="public-input-explainer-examples"${langAttr("examples")}>${examples}</ul>
      <details class="public-input-explainer-method">
        <summary${langAttr("method")}>${esc(read("public_input_explainer_method_summary"))}</summary>
        <div class="public-input-explainer-method-body"${langAttr("method")}>${read("public_input_explainer_method_html")}</div>
      </details>
    </div>
  </details>`;
}

/**
 * Renders the one explainer into its host on an application page. Called again
 * after a language change, it replaces that host's contents rather than adding
 * a second copy, so a page never carries two renderings of this copy.
 */
export function mountPublicInputExplainer(doc, opts = {}) {
  const ownerDocument = doc || globalThis.document || null;
  if (!ownerDocument) return null;
  const hosts = ownerDocument.querySelectorAll(`[${EXPLAINER_HOST_ATTR}]`);
  const host = hosts && hosts.length ? hosts[0] : null;
  if (!host) return null;
  host.innerHTML = publicInputExplainerHTML(opts);
  return ownerDocument.getElementById(EXPLAINER_PANEL_ID);
}
