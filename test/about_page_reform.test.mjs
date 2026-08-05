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

test("About describes the time-and-action product in one short section", () => {
  const section = about.match(/<h2 data-i18n="about_h_what">[\s\S]*?(?=<h2 id="context")/)?.[0] || "";
  assert.match(section, /<b>Now<\/b>[\s\S]*<b>Near you<\/b>[\s\S]*<b>Following<\/b>[\s\S]*<b>Browse<\/b>/);
  assert.match(section, /contracts and plans[\s\S]*land use[\s\S]*meetings and votes[\s\S]*job exams[\s\S]*city property sales[\s\S]*rules/i);
  assert.match(section, /official city publications/);
  assert.doesNotMatch(section, /Where the data comes from|Data notes|1\.09 million|87\.5%/i);
});

test("removed data and privacy policy copy is absent and unlinked in every shipped locale", () => {
  assert.doesNotMatch(shippedCopy, /about_h_(?:source|honest|privacy)|about_li_(?:honest|privacy)|about\.html#(?:data|privacy)|href=\\?"#(?:data|privacy)\\?"/);
  assert.doesNotMatch(about, /<h2[^>]*>Where the data comes from<\/h2>|id="data"|id="privacy"/i);
});

test("each pattern is a compact card with collapsed detail", () => {
  const ids = [
    "staffing-list-establishment-formula",
    "property-disposition-timing-formula",
    "tax-lien-sale-predictions",
    "zoning-base-rates",
    "applicant-conditioned-ulurp",
  ];
  for (const id of ids) {
    const card = about.match(new RegExp(`<article class="pattern-card" id="${id}">([\\s\\S]*?)<\\/article>`))?.[1] || "";
    assert.match(card, /<h3/);
    assert.match(card, /<p class="src"/);
    assert.match(card, /<details><summary>How this works<\/summary>/);
    assert.ok((card.match(/<li/g) || []).length === 0, `${id} should not restore a long method list`);
  }
});

test("AI disclosure follows NYC's disclose-review-separate structure", () => {
  const section = about.match(/<h2 data-i18n="about_h_content">[\s\S]*?(?=<\/main>)/)?.[0] || "";
  assert.match(section, /generative artificial intelligence \(AI\)/i);
  assert.match(section, /A human reviews and edits this content before it goes live/);
  assert.match(section, /AI does not create or change the official records/);
});
