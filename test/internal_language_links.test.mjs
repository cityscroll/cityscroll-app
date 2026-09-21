import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { matterPermalink } from "../site/matter_permalink.mjs";

const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const browserEvidence = JSON.parse(readFileSync(new URL("../docs/evidence/internal-language-links/manifest.json", import.meta.url), "utf8"));

function languageLinksFor(lang) {
  const links = [
    { href: "/browse/", attrs: {} },
    { href: "/about.html?from=home", attrs: {} },
    { href: "#investigation", attrs: { "data-i18n": "footer_investigation" } },
    { href: "#investigation/shared/example", attrs: {} },
    { href: "https://example.org/", attrs: {} },
  ].map((entry) => ({
    href: entry.href,
    getAttribute(key) { return key === "href" ? this.href : entry.attrs[key] || null; },
    setAttribute(key, value) { if (key === "href") this.href = value; },
  }));
  const document = {
    baseURI: "https://cityscroll.org/",
    querySelectorAll(selector) {
      if (selector === "a[href]") return links;
      return [];
    },
    getElementById() { return null; },
    documentElement: { dataset: {}, lang: "en", dir: "ltr", style: { setProperty() {}, removeProperty() {} } },
  };
  const context = {
    window: { LANG: lang },
    document,
    URL,
    location: {
      href: `https://cityscroll.org/?lang=${encodeURIComponent(lang)}`,
      origin: "https://cityscroll.org",
    },
  };
  runInNewContext(i18n, context);
  context.window.LANG = lang;
  context.window.applyStrings();
  return links;
}

test("same-origin links carry a selected language while the English footer stays literal", () => {
  const links = languageLinksFor("es");
  assert.equal(links[0].href, "/browse/?lang=es");
  assert.equal(links[1].href, "/about.html?from=home&lang=es");
  assert.match(links[2].href, /#investigation$/);
  assert.equal(links[3].href, "#investigation/shared/example");
  assert.equal(links[4].href, "https://example.org/");

  const english = languageLinksFor("en");
  assert.equal(english[0].href, "/browse/");
  assert.equal(english[2].href, "#investigation");
  assert.equal(english[3].href, "#investigation/shared/example");
});

test("matter copy links retain only the selected language from the current search", () => {
  const languageURL = (value) => value.replace("?lang=en", "");
  const location = {
    origin: "https://cityscroll.org",
    pathname: "/",
    search: "?lang=es&token=private",
  };
  const link = matterPermalink("84124P0003001", location, languageURL);
  assert.equal(link, "https://cityscroll.org/?lang=es#matter/84124P0003001");
  assert.doesNotMatch(link, /token=/, "copied matter links must not leak unrelated query state");
  assert.equal(
    matterPermalink("84124P0003001", { ...location, search: "?lang=en" }, languageURL),
    "https://cityscroll.org/#matter/84124P0003001",
  );
});

test("A1 every inventoried destination keeps the browser's selected language", () => {
  assert.equal(browserEvidence.records.length, 9, "the inherited inventory has nine individually observed entries");
  for (const record of browserEvidence.records) {
    assert.equal(record.browser_observation.followed, true, `${record.case} must be followed in a browser`);
    const destination = new URL(record.browser_observation.destination);
    const queryLanguage = destination.searchParams.get("lang");
    const pathLanguage = destination.pathname.includes(`/${record.browser_observation.locale}/`);
    assert.ok(queryLanguage === record.browser_observation.locale || pathLanguage, `${record.case} destination keeps its locale`);
  }
});

test("A2 the nine inventory entries each have their own browser evidence artifact", () => {
  const cases = browserEvidence.records.map((record) => record.case);
  assert.deepEqual(cases, [
    "site-index",
    "civic-document-chrome",
    "boot-matter-copy",
    "workspace-matter-copy",
    "agency-directory-runtime",
    "agency-connections",
    "vendor-footprint",
    "following-view",
    "routing",
  ]);
  for (const record of browserEvidence.records) {
    assert.match(record.artifact, /^\.artifacts\/internal-language-links\//);
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(record.browser_observation.route, "static observation only");
  }
});

test("A4 the browser evidence preserves the default fragment exception separately", () => {
  const english = languageLinksFor("en");
  assert.equal(english[2].href, "#investigation");
  assert.equal(browserEvidence.image_binaries_committed, false);
  assert.ok(browserEvidence.records.every((record) => record.assertion && record.browser_observation.destination));
});
