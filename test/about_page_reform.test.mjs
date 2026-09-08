import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
const stats = readFileSync(new URL("../site/stats.html", import.meta.url), "utf8");
const i18nRoot = new URL("../site/i18n/", import.meta.url);
const localeSources = readdirSync(new URL("lang/", i18nRoot))
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(new URL(`lang/${name}`, i18nRoot), "utf8"));
const shippedCopy = [about, stats, readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8"), ...localeSources].join("\n");

test("About introduces the independent product and team with one guide entry", () => {
  const section = about.split('<h2 data-i18n="about_h_feedback">')[0];
  assert.match(section, /official New York City publications/);
  assert.match(section, /CityScroll is independent/);
  assert.match(section, /Using CityScroll/);
  assert.equal((section.match(/href="\/guide\/"/g) || []).length, 1);
  assert.match(section, /id="maintainers"/);
  assert.match(section, /Anna Bao, James Carroll, Dev Doshi, and Michael Sheehan/);
  assert.match(section, /href="mailto:team@cityscroll\.org"/);
  assert.match(section, /href="https:\/\/github\.com\/cityscroll\/cityscroll-app"/);
});

test("removed data and privacy policy copy is absent and unlinked in every shipped locale", () => {
  assert.doesNotMatch(shippedCopy, /about_h_(?:source|honest|privacy)|about_li_(?:honest|privacy)|about\.html#(?:data|privacy)|href=\\?"#(?:data|privacy)\\?"/);
  assert.doesNotMatch(about, /<h2[^>]*>Where the data comes from<\/h2>|id="data"|id="privacy"/i);
});

test("removed manual translations cannot restore the About grids", () => {
  assert.doesNotMatch(shippedCopy, /about_(?:li_flags_html|p_flags_intro_html|p_flags_footer_html|staffing_formula_html|p_tax_lien_formula_html)\s*:/);
  assert.doesNotMatch(about, /class="(?:pattern-card|pattern-grid|explore-grid)"/);
  assert.match(about, /\.legacy-target\{display:none\}/);
  assert.match(about, /\.legacy-target:target\{display:block/);
});

test("AI disclosure follows NYC's disclose-review-separate structure", () => {
  const section = about.match(/<h2 id="content-policy" data-i18n="about_h_content">[\s\S]*?(?=<\/main>)/)?.[0] || "";
  assert.match(section, /generative artificial intelligence \(AI\)/i);
  assert.match(section, /A human reviews and edits this content before it goes live/);
  assert.match(section, /AI does not create or change the official records/);
});
