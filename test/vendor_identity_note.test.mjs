import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(join(ROOT, "..", "site", "i18n.js"), "utf8");
const entitiesSrc = readFileSync(join(ROOT, "..", "site", "app", "entities.mjs"), "utf8");
const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const en = new Function("window", i18nSrc + "\nreturn window.STRINGS.en;")(windowStub);

function loadLang(lang) {
  const path = join(ROOT, "..", "site", "i18n", "lang", `${lang}.js`);
  const langSrc = readFileSync(path, "utf8");
  const langWindow = { STRINGS: {} };
  return new Function(
    "window",
    "global",
    langSrc + `\nreturn window.STRINGS[${JSON.stringify(lang)}];`,
  )(langWindow, { window: langWindow });
}

const shippingLangs = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"];
const SLOP = [
  /Awards are as published in the City Record/i,
  /Registered contracts and payments live/i,
  /timeline lead carries/i,
  /Identity is resolved by name normalization/i,
  /variants listed above/i,
  /Las adjudicaciones son las del City Record/i,
  /el encabezado de la cronología/i,
];

test("vendor identity note is a one-line name-stem caveat, not a provenance wall", () => {
  const note = en.vendor_identity_note_html;
  assert.equal(typeof note, "string");
  assert.ok(note.length <= 90, `note is still a paragraph (${note.length} chars)`);
  assert.match(note, /published under this name/i);
  assert.match(note, /not a legal entity/i);
  for (const pattern of SLOP) {
    assert.doesNotMatch(note, pattern);
  }
});

test("shipping languages keep the key and drop provenance-redundant sentences", () => {
  for (const lang of shippingLangs) {
    const note = loadLang(lang).vendor_identity_note_html;
    assert.ok(typeof note === "string" && note.length > 0, `${lang} missing vendor_identity_note_html`);
    assert.ok(note.length <= 140, `${lang} note is still a paragraph (${note.length} chars)`);
    for (const pattern of SLOP) {
      assert.doesNotMatch(note, pattern, `${lang} still has provenance slop`);
    }
  }
});

test("the caveat sits by the totals; Checkbook provenance stays on the per-link marker", () => {
  assert.match(entitiesSrc, /function vendorProfileHeaderHTML/);
  const headerStart = entitiesSrc.indexOf("function vendorProfileHeaderHTML");
  const headerEnd = entitiesSrc.indexOf("\nfunction ", headerStart + 1);
  const header = entitiesSrc.slice(headerStart, headerEnd);
  assert.match(header, /vendor_identity_note_html/);
  assert.match(header, /agencybar/);

  assert.doesNotMatch(
    entitiesSrc,
    /class="note">\$\{t\("vendor_identity_note_html"/,
  );
  assert.doesNotMatch(
    entitiesSrc,
    /vendor_identity_note_html",\{source:/,
  );

  assert.match(en.vendor_phase_action_checkbook_once, /Registered contracts and payments: \{link\}\./);
  assert.match(entitiesSrc, /vendor_phase_action_checkbook_once/);
});
