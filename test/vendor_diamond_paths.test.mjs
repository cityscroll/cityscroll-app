import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entityChipHTML, entityRouteRef } from "../site/entity_pivot.mjs";

const feed = readFileSync(new URL("../site/app/feed-actions.mjs", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("../site/app/procurement-lifecycle.mjs", import.meta.url), "utf8");
const money = readFileSync(new URL("../site/app/money-history.mjs", import.meta.url), "utf8");

test("previously plain vendor paths use the shared typed pivot renderer", () => {
  assert.match(feed, /globalThis\.pivotA\?\..*globalThis\.vendorHref/);
  assert.match(lifecycle, /globalThis\.pivotA\?\..*globalThis\.vendorHref/);
  assert.match(money, /globalThis\.pivotA\?\..*globalThis\.vendorHref/);
  assert.doesNotMatch(feed, /<b>\$\{escUiHtml\(guide\.vendor\)\}<\/b>/);
  assert.doesNotMatch(lifecycle, /<b lang="en" dir="ltr">\$\{escUiHtml\(d\.vendor\)\}<\/b>/);
  assert.doesNotMatch(money, /<b lang="en" dir="ltr">\$\{escUiHtml\(c\.vendor\)\}<\/b>/);
});

test("vendor pivot confidence gate keeps review-only refs plain", () => {
  const ref = entityRouteRef("vendor", "General Dynamics Information Technology Inc");
  const accepted = entityChipHTML({ ref, label: "General Dynamics Information Technology Inc", link_confidence: "strong" });
  const review = entityChipHTML({ ref, label: "General Dynamics Information Technology Inc", link_confidence: "review" });
  assert.match(accepted, /href="\/vendors\/GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY\/"/);
  assert.match(accepted, /aria-hidden="true">◆<\/span>/);
  assert.doesNotMatch(review, /href="\/vendors\//);
  assert.match(review, /General Dynamics Information Technology Inc/);
});
