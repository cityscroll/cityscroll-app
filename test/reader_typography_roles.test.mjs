import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

function cssCustomProperty(source, name) {
  const match = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(match, `expected ${name} in stylesheet`);
  return match[1].trim();
}

test("brand tokens keep reading UI on Noto and brand display on Space Grotesk", () => {
  const brand = read("site/brand.css");
  assert.equal(cssCustomProperty(brand, "--font-reading"), '"Noto Sans", "Helvetica Neue", Arial, system-ui, sans-serif');
  assert.equal(cssCustomProperty(brand, "--font-body"), "var(--font-reading)");
  assert.equal(cssCustomProperty(brand, "--font-label"), "var(--font-reading)");
  assert.equal(cssCustomProperty(brand, "--font-interface"), "var(--font-reading)");
  assert.equal(cssCustomProperty(brand, "--font-sc"), "var(--font-label)");
  assert.match(cssCustomProperty(brand, "--font-brand"), /Space Grotesk/);
  assert.equal(cssCustomProperty(brand, "--font-display"), "var(--font-brand)");
  assert.equal(cssCustomProperty(brand, "--font-nameplate"), "var(--font-brand)");
  assert.match(brand, /a\.route-back-link\{[^}]*var\(--font-interface\)/);
});

test("design language makes family roles normative and sizes a reference", () => {
  const design = read("docs/design-language.md");
  assert.match(design, /Family roles are normative/);
  assert.match(design, /existing components keep their tuned sizes/);
  assert.match(design, /Control \(input \/ button\)/);
  assert.match(design, /Text \/ UI — Noto Sans/);
  assert.match(design, /Display \/ headings — Space Grotesk/);
  assert.match(design, /script-aware/);
});

test("typography browser case asserts zoom and long-title usability", () => {
  const harness = read("test/functional/typography_case.py");
  assert.match(harness, /def assert_zoom_usability\(/);
  assert.match(harness, /def assert_long_title_usability\(/);
  assert.match(harness, /typography-zoom/);
  assert.match(harness, /typography-long-title/);
  assert.match(harness, /max\(320, int\(current\["width"\]\) \/\/ 2\)/);
  assert.match(harness, /data-typography-long-title/);
});

test("homepage control roles drop Georgia and share reading tokens", () => {
  const home = read("site/index.html");
  assert.match(home, /<link rel="stylesheet" href="brand\.css">/);
  assert.ok(
    home.indexOf('<link rel="stylesheet" href="brand.css">')
      < home.indexOf("<style>"),
    "brand.css must load before page-local rules that consume type tokens",
  );
  assert.match(
    home,
    /--lang-font-stack:\s*var\(--font-reading/,
  );
  assert.doesNotMatch(home, /--lang-font-stack:\s*inherit/);
  assert.match(
    home,
    /body\{[^}]*font:17px\/1\.55 var\(--font-body,"Noto Sans","Helvetica Neue",Arial,system-ui,sans-serif\)/,
  );
  assert.match(
    home,
    /\.home-topic-form label\{[^}]*font:700 13px\/1\.3 var\(--font-label\)/,
  );
  assert.match(
    home,
    /\.home-topic-form input\{[^}]*font:16px\/1\.3 var\(--font-body\)/,
  );
  assert.match(
    home,
    /\.home-topic-form button\{[^}]*font:700 14px\/1\.2 var\(--font-interface\)/,
  );
  assert.match(
    home,
    /\.field label\{[^}]*font:600 11px\/1 var\(--font-label\)/,
  );
  assert.match(
    home,
    /select,input\[type=text\],input\[type=email\]\{[^}]*font:15px\/1\.3 var\(--font-body\)/,
  );
  assert.match(
    home,
    /(?<!mini)button\{[^}]*font:600 14px\/1 var\(--font-interface\)/,
  );
  assert.doesNotMatch(
    home,
    /select,input\[type=text\],input\[type=email\]\{[^}]*Georgia/,
  );
});

test("search document mirrors the same control-role assignments", () => {
  const search = read("site/search/index.html");
  assert.match(search, /select,input\[type=text\],input\[type=email\]\{[^}]*font:15px\/1\.3 var\(--font-body\)/);
  assert.match(search, /\.home-topic-form button\{[^}]*var\(--font-interface\)/);
  assert.doesNotMatch(search, /select,input\[type=text\],input\[type=email\]\{[^}]*Georgia/);
});

test("civic documents inherit control fonts from the reading body role", () => {
  const docs = read("site/civic-documents.css");
  assert.match(
    docs,
    /body\s*\{[^}]*font:\s*400 1\.0625rem\/1\.6 var\(--font-body,\s*"Noto Sans"/s,
  );
  assert.match(docs, /button,\s*input,\s*select\s*\{\s*font:\s*inherit;/);
  assert.match(docs, /\.document-brand\s*\{[^}]*var\(--font-brand\)/s);
  assert.match(docs, /\.document-nav\s*\{[^}]*var\(--font-label\)/s);
});

test("client route-back links use the shared interface role instead of inline system fonts", () => {
  const routing = read("site/app/routing.mjs");
  assert.match(routing, /route-back-link/);
  assert.doesNotMatch(routing, /ui-sans-serif,system-ui,sans-serif/);
  assert.doesNotMatch(routing, /style="font:600 13px\/1/);
});

test("i18n never writes inherit into the language font stack", () => {
  const i18n = read("site/i18n.js");
  assert.match(i18n, /removeProperty\("--lang-font-stack"\)/);
  assert.doesNotMatch(i18n, /setProperty\("--lang-font-stack",\s*\(meta && meta\.fontStack\) \|\| "inherit"\)/);
});
