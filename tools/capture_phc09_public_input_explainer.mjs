#!/usr/bin/env node
/**
 * PHC-09 evidence helper: render the one public-input explainer component in
 * each of the language states its section-level fallback can produce — English,
 * a fully translated locale, a partially translated locale, and a locale with
 * no dictionary at all.
 *
 * Writes each rendered fragment under site/.phc09-capture-tmp/ so the .py
 * companion can serve it locally (real /index.html CSS rules), open and close
 * it at both review widths, and run axe-core against it. Prints the case
 * manifest as JSON to stdout. Writes no image.
 *
 *   node tools/capture_phc09_public_input_explainer.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  EXPLAINER_COPY_KEYS,
  publicInputExplainerHTML,
  resolveExplainerCopy,
} from "../site/public_input_explainer.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "site/.phc09-capture-tmp");

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require(path.join(ROOT, "site/i18n.js"));
const STRINGS = globalThis.window.STRINGS;

// One key withheld from an otherwise complete locale. Its whole section must
// fall back to English rather than leaving a translated heading over an
// English list — the failure this case exists to rule out.
const WITHHELD_KEY = "public_input_explainer_example_rule_surface";
const PARTIAL_LOCALE = {
  en: STRINGS.en,
  es: Object.fromEntries(
    EXPLAINER_COPY_KEYS.filter((key) => key !== WITHHELD_KEY).map((key) => [key, STRINGS.es[key]]),
  ),
};

const CASES = [
  {
    id: "english",
    lang: "en",
    strings: STRINGS,
    assertion: "A7: the English rendering is one component whose markup is identical at both review widths, so the inline and sheet presentations cannot carry different copy.",
  },
  {
    id: "translated_locale",
    lang: "es",
    strings: STRINGS,
    assertion: "A6: a fully translated locale renders every section in that locale, with no English fragment left inside a translated block.",
  },
  {
    id: "partially_translated_locale",
    lang: "es",
    strings: PARTIAL_LOCALE,
    assertion: `A6: a locale missing ${WITHHELD_KEY} renders that whole section in English while its other sections stay translated, so no block mixes languages.`,
  },
  {
    id: "untranslated_locale",
    lang: "zz-absent",
    strings: { en: STRINGS.en },
    assertion: "A6: a locale with no dictionary at all renders wholly in English rather than showing raw keys or partial copy.",
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const manifestCases = [];

for (const { id, lang, strings, assertion } of CASES) {
  const html = publicInputExplainerHTML({ lang, strings });
  if (!html) throw new Error(`case ${id} rendered nothing; absence is never valid proof here`);
  writeFileSync(path.join(OUT_DIR, `${id}.html`), html, "utf8");
  const copy = resolveExplainerCopy({ lang, strings });
  manifestCases.push({
    id,
    lang,
    assertion,
    path: `/.phc09-capture-tmp/${id}.html`,
    section_languages: Object.fromEntries(
      Object.entries(copy.sections).map(([sectionId, section]) => [sectionId, section.language]),
    ),
  });
}

process.stdout.write(JSON.stringify(manifestCases, null, 2));
