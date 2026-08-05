// Characterization matrix for drift-prone formatting, feed, and permalink variants.
// These forms are migration inputs: changing one requires an explicit fixture update.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SITE_SOURCE } from "../helpers/site_source.mjs";
import { feedItems, atomFeed, jsonFeed, icsFeed } from "../../worker/src/lib/feed.mjs";
import { vendorEntityPermalink } from "../../worker/src/lib/batch.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = JSON.parse(read("../fixtures/deterministic-drift/contracts.json"));
const i18nSource = read("../../site/i18n.js");
const workerSources = [
  read("../../worker/src/alerts.mjs"),
  read("../../worker/src/lib/feed.mjs"),
  read("../../worker/src/lib/confirm_email.mjs"),
];
const mcpSource = read("../../worker/src/mcp.mjs");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") { depth += 1; opened = true; }
    if (source[i] === "}" && opened && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

function extractDeclaration(source, name) {
  const match = source.match(new RegExp(`(?:^|\\n)const ${name}\\s*=`));
  assert.ok(match, `${name} must exist`);
  const start = match.index + match[0].indexOf("const");
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if ("{[(".includes(source[i])) depth += 1;
    else if ("}])".includes(source[i])) depth -= 1;
    else if (source[i] === ";" && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated declaration ${name}`);
}

const site = new Function(
  extractFunction(SITE_SOURCE, "cleanText")
    + extractFunction(SITE_SOURCE, "money")
    + extractDeclaration(SITE_SOURCE, "agencyHref")
    + extractDeclaration(SITE_SOURCE, "vendorHref")
    + "return { money, agencyHref, vendorHref };",
)();

const language = new Function(
  "location",
  'const SELECTABLE_LANGS=["en","es","zh-Hans","ru","bn","ht","ko","fr","pl","ar","ur"];'
    + extractFunction(i18nSource, "languageURL")
    + "return { languageURL };",
)({ href: "https://cityscroll.org/" });

const mcp = new Function(
  extractFunction(mcpSource, "fmtRecord")
    + extractFunction(mcpSource, "previewText")
    + "return { fmtRecord, previewText };",
)();

function workerUsdClosures() {
  return workerSources.flatMap((source) => [...source.matchAll(/const usd = \(n\) => ([^;\n]+);/g)]
    .map((match) => new Function("n", `return (${match[1]});`)));
}

test("all worker full-dollar closures and MCP preview agree for valid positive amounts", () => {
  const closures = workerUsdClosures();
  assert.equal(closures.length, fixture.currency.worker_usd_closure_count);
  for (const amount of fixture.currency.valid_positive_amounts) {
    for (const usd of closures) assert.equal(usd(amount.input), amount.full);
    const preview = mcp.previewText({
      label: "contract money",
      rows: [{ start_date: "2026-08-05", agency_name: "Parks", short_title: "Playground", contract_amount: amount.input }],
    });
    assert.match(preview, new RegExp(amount.full.replace(/[$,.]/g, "\\$&")));
    assert.equal(site.money(amount.input), amount.on_page, "on-page abbreviation is intentional");
  }
});

test("MCP record output consumes the same full-dollar display and notice permalink form", () => {
  const output = mcp.fmtRecord({
    request_id: fixture.feed.item.id,
    date: "2026-08-05",
    agency: "Parks & Recreation",
    title: fixture.feed.item.title,
    contract_amount_display: fixture.currency.valid_positive_amounts[2].full,
  }, 0);
  assert.match(output, /\$1,234,567\.89/);
  assert.match(output, /https:\/\/cityscroll\.org\/index\.html#notice\/20260805014/);
});

test("feed neutral-item fields and serializer shapes stay fixture-exact", () => {
  const [item] = feedItems(fixture.feed.kind, [fixture.feed.row]);
  assert.deepEqual(item, fixture.feed.item);

  const json = JSON.parse(jsonFeed({
    title: "CityScroll — awards",
    selfUrl: "https://api.cityscroll.org/feed.json?lens=money",
    siteUrl: "https://cityscroll.org/",
    items: [item],
  }));
  assert.deepEqual(Object.keys(json.items[0]), ["id", "url", "title", "date_published", "content_text"]);
  assert.equal(json.items[0].content_text, fixture.feed.item.summary);

  const atom = atomFeed({
    title: "CityScroll — awards",
    selfUrl: "https://api.cityscroll.org/feed.xml?lens=money",
    siteUrl: "https://cityscroll.org/",
    updated: "2026-08-05T12:00:00.000Z",
    items: [item],
  });
  assert.match(atom, /<summary>Parks &amp; Recreation · \$1,234,567\.89 · → Acme &amp; Sons LLC/);

  const ics = icsFeed({ title: "CityScroll — awards", items: [item] });
  assert.match(ics, /UID:20260805014@crol-list/);
  assert.match(ics, /DTSTART:20260812T103000/);
  assert.match(ics, /https:\/\/cityscroll\.org\/#notice\/20260805014/);
});

test("vendor and agency slug cleaning plus language-bearing permalink forms are stable", () => {
  for (const entry of fixture.permalinks) {
    let hash;
    if (entry.kind === "vendor") {
      hash = site.vendorHref(entry.raw_name);
      assert.equal(vendorEntityPermalink(entry.raw_name), `https://cityscroll.org/${entry.hash}`);
    } else if (entry.kind === "agency") {
      hash = site.agencyHref(entry.raw_name);
    } else {
      hash = `#notice/${encodeURIComponent(entry.id)}`;
    }
    assert.equal(hash, entry.hash);
    assert.equal(
      language.languageURL(`https://cityscroll.org/${hash}`, "es", "https://cityscroll.org/"),
      entry.spanish,
    );
  }
});

test("existing share owners apply language to copy, QR, notice, land, and search URLs", () => {
  assert.match(SITE_SOURCE, /copyText\(txt, btn\)[\s\S]{0,180}txt=currentLanguageURL\(txt\)/);
  assert.match(SITE_SOURCE, /QRShare\.bind\(button, currentLanguageURL\(url\), qrLabels\)/);
  assert.match(SITE_SOURCE, /const noticeLink = id => currentLanguageURL\(/);
  assert.match(SITE_SOURCE, /const landLink = id => currentLanguageURL\(/);
  assert.match(SITE_SOURCE, /currentLanguageURL\(canonicalSearchURL\(location, hash\)\)/);
});
