import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { renderCivicDocumentMast } from "../site/civic_document_chrome.mjs";

const SITE = new URL("../site/", import.meta.url);
const readSite = (rel) => readFileSync(new URL(rel, SITE), "utf8");

// Generated gitignored shells (site/browse/, site/now/, _site/) are absent in a
// focused checkout; skip them defensively if present.
const SKIP_DIRS = new Set(["browse", "now", "_site", "node_modules"]);

function* walkHtml(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkHtml(join(dir, entry.name));
    } else if (entry.name.endsWith(".html")) {
      yield join(dir, entry.name);
    }
  }
}

const BRAND_LOCKUP_OPEN = /<([a-z0-9]+)\b[^>]*\bclass="[^"]*\bbrand-lockup\b[^"]*"[^>]*>/g;
const HOME_HREFS = new Set(["/", "/index.html", "index.html"]);

function brandLockupAnchors(html) {
  // Anchor lockups: match the full <a ...>...</a> span (brand lockups never nest anchors).
  const anchors = [];
  const anchorRe = /<a\b[^>]*\bclass="([^"]*\bbrand-lockup\b[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const tag = match[0];
    const href = /href="([^"]*)"/.exec(tag)?.[1] ?? null;
    anchors.push({ tag, classes: match[1], inner: match[2], href, index: match.index });
  }
  return anchors;
}

test("masthead brand inventory: every public brand lockup is a home link", () => {
  const siteDir = new URL("../site/", import.meta.url).pathname;
  let scanned = 0;
  let lockups = 0;
  for (const file of walkHtml(siteDir)) {
    scanned += 1;
    const html = readFileSync(file, "utf8");
    // A brand lockup rendered as a non-anchor element can never navigate home.
    for (const match of html.matchAll(BRAND_LOCKUP_OPEN)) {
      assert.equal(
        match[1],
        "a",
        `${file}: brand lockup must be an anchor, found <${match[1]}> (${match[0].slice(0, 120)})`,
      );
    }
    for (const anchor of brandLockupAnchors(html)) {
      lockups += 1;
      assert.ok(
        anchor.href && HOME_HREFS.has(anchor.href),
        `${file}: brand lockup must link home, found href=${JSON.stringify(anchor.href)}`,
      );
      assert.ok(
        !/<(a|button|input|select|textarea|summary)\b/.test(anchor.inner),
        `${file}: brand home link must not nest interactive elements`,
      );
      const mark = /<svg\b[^>]*\bclass="brand-mark"[^>]*>/.exec(anchor.inner);
      if (mark) {
        assert.ok(
          /aria-hidden="true"/.test(mark[0]),
          `${file}: decorative brand mark must stay hidden from assistive technology`,
        );
      }
      assert.match(anchor.inner, /CityScroll/, `${file}: brand home link keeps the visible wordmark`);
    }
  }
  assert.ok(scanned > 500, `inventory should cover the tracked site, scanned ${scanned}`);
  assert.ok(lockups > 500, `inventory should find the brand lockups, found ${lockups}`);
});

for (const rel of ["index.html", "search/index.html"]) {
  test(`${rel}: masthead brand lockup is a single home link wrapping mark and nameplate heading`, () => {
    const html = readSite(rel);
    const masthead = /<header class="masthead">[\s\S]*?<\/header>/.exec(html)?.[0];
    assert.ok(masthead, `${rel}: main-shell masthead missing`);
    const anchors = brandLockupAnchors(masthead).filter((a) =>
      a.classes.split(/\s+/).includes("brand-lockup--masthead"),
    );
    assert.equal(anchors.length, 1, `${rel}: exactly one masthead brand link, one tab stop`);
    const [brand] = anchors;
    assert.equal(brand.href, "/", `${rel}: brand link destination must be the relative root`);
    assert.match(brand.tag, /aria-label="CityScroll home"/, `${rel}: accessible name`);
    assert.match(brand.tag, /data-i18n-aria="brand_home_aria"/, `${rel}: translated accessible name`);
    assert.match(brand.inner, /<h1 class="cr-title">CityScroll<\/h1>/, `${rel}: nameplate heading preserved inside the link`);
    assert.match(brand.inner, /<svg class="brand-mark"[^>]*aria-hidden="true"/, `${rel}: decorative mark hidden`);
    // The tagline, topic search, and hero/CTA modules stay outside the link.
    const afterBrand = masthead.slice(masthead.indexOf(brand.tag) + brand.tag.length);
    assert.match(afterBrand, /<p class="cr-tagline"/, `${rel}: tagline follows the brand link`);
    assert.ok(!brand.inner.includes("cr-tagline"), `${rel}: tagline is not part of the link`);
    assert.ok(!brand.inner.includes("home-topic-entry"), `${rel}: search module is not part of the link`);
  });
}

for (const rel of ["following/index.html", "near-you/index.html"]) {
  test(`${rel}: shared document-brand lockup links home with the CityScroll home name`, () => {
    const html = readSite(rel);
    const anchors = brandLockupAnchors(html).filter((a) =>
      a.classes.split(/\s+/).includes("document-brand"),
    );
    assert.equal(anchors.length, 1, `${rel}: one document-brand lockup`);
    assert.equal(anchors[0].href, "/", `${rel}: document-brand destination`);
    assert.match(anchors[0].tag, /aria-label="CityScroll home"/, `${rel}: accessible name`);
    assert.match(anchors[0].inner, /<svg class="brand-mark"[^>]*aria-hidden="true"/);
    assert.match(anchors[0].inner, /<span>CityScroll<\/span>/);
  });
}

test("renderCivicDocumentMast: shared builder emits the CityScroll home lockup", () => {
  for (const [options, home] of [
    [{ current: "browse" }, "/"],
    [{ current: "following", siteBase: "/preview" }, "/preview"],
  ]) {
    const html = renderCivicDocumentMast(options);
    const anchors = brandLockupAnchors(html).filter((a) =>
      a.classes.split(/\s+/).includes("document-brand"),
    );
    assert.equal(anchors.length, 1, "one document-brand lockup");
    assert.equal(anchors[0].href, home, `destination for siteBase=${JSON.stringify(options.siteBase)}`);
    assert.match(anchors[0].tag, /aria-label="CityScroll home"/);
    assert.match(anchors[0].inner, /<svg class="brand-mark"[^>]*aria-hidden="true"/);
    assert.match(anchors[0].inner, /<span>CityScroll<\/span>/);
    assert.ok(!anchors[0].href.includes("cityscroll.org"), "never a hard-coded production hostname");
  }
});

test("brand.css: brand lockup links render without underline and with a visible focus ring", () => {
  const css = readSite("brand.css");
  assert.match(css, /a\.brand-lockup\s*\{[^}]*text-decoration:\s*none/);
  assert.match(css, /a\.brand-lockup:focus-visible\s*\{[^}]*outline:\s*2px solid/);
});

test("i18n: brand_home_aria ships the CityScroll home accessible name", () => {
  const i18n = readSite("i18n.js");
  assert.match(i18n, /brand_home_aria: "CityScroll home"/);
});
