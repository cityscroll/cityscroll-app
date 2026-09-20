import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");

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
