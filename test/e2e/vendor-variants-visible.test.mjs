import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0;
  let seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") {
      depth++;
      seen = true;
    } else if (src[j] === "}" && --depth === 0 && seen) {
      return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);
const { cleanText, money, renderVendorVariants } = new Function(
  "t",
  "window",
  extractFn("cleanText")
  + extractFn("money")
  + extractFn("renderVendorVariants")
  + "\nreturn { cleanText, money, renderVendorVariants };"
)(t, windowStub);

function fixtureAmount(n) {
  return money(n) || "—";
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertRowText(html, variant, count) {
  const normName = cleanText(variant.vendor_name).replace(/&/g, "&amp;");
  assert.match(html, new RegExp(`<span class="vendor-variant-name"[^>]*>${escapeRegExp(normName)}</span>`));
  assert.match(html, new RegExp(`${count.toLocaleString("en-US", { maximumFractionDigits: 0 })} · ${escapeRegExp(fixtureAmount(variant.t))}`));
}

const CambaVariants = [
  { vendor_name: "Camba, Inc.", n: 24, t: 1244000000 },
  { vendor_name: "Camba,Inc.", n: 1, t: 3000000 },
  { vendor_name: "Camba Inc", n: 3, t: 2000000 },
  { vendor_name: "Camba.Inc", n: 8, t: 430000 },
  { vendor_name: "Camba, Incorporated", n: 5, t: 1800000 },
  { vendor_name: "Camba - Inc", n: 2, t: 100000 },
  { vendor_name: "Camba,  Inc", n: 7, t: 900000 },
  { vendor_name: "Camba / Inc", n: 9, t: 250000 },
  { vendor_name: "Camba LLC", n: 4, t: 140000 }
];

const ProjectRenewalVariants = [
  { vendor_name: "Project  Renewal, Inc.", n: 12, t: 400000 },
  { vendor_name: "Project Renewal, Inc.", n: 6, t: 500000 },
  { vendor_name: "Project Renewal", n: 2, t: 800000 },
  { vendor_name: "Project Renewal Inc", n: 4, t: 150000 },
  { vendor_name: "Project   Renewal, Inc.", n: 1, t: 90000 }
];

const MackTrucksVariants = [
  { vendor_name: "Mack Trucks,", n: 1, t: 21000000 },
  { vendor_name: "Mack Trucks", n: 3, t: 1800000 },
  { vendor_name: "MACK TRUCKS", n: 5, t: 760000 },
  { vendor_name: "MACK TRUCKS,", n: 2, t: 440000 },
  { vendor_name: "Mack Trucks,", n: 8, t: 120000 }
];

const ScoFamilyVariants = [
  { vendor_name: "SCO  Family of Services", n: 2, t: 90000 },
  { vendor_name: "SCO Family of Services,", n: 4, t: 120000 }
];

const CastleSingle = [
  { vendor_name: "CASTLE OIL CORPORATION", n: 3, t: 700000 }
];

// 1) CAMBA: field fixture with punctuation-only variations (must pin the class and row shape).
test("CAMBA resolved variants render as visible chips with count and amount", () => {
  const html = renderVendorVariants(CambaVariants);
  assert.match(html, /class="vendor-variant-list"/);
  assert.match(html, /class="vendor-variant-item"/g);
  assert.equal((html.match(/vendor-variant-item/g) || []).length, CambaVariants.length);
  assert.match(html, /<details[^>]*open/);
  for (const v of CambaVariants) {
    assertRowText(html, v, Number(v.n));
  }
});

test("Project Renewal variants with internal double-space still render normalized", () => {
  const html = renderVendorVariants(ProjectRenewalVariants);
  assert.match(html, /class="vendor-variant-list"/);
  assert.match(html, new RegExp(escapeRegExp(cleanText("Project  Renewal, Inc.").replace(/&/g, "&amp;"))));
  for (const v of ProjectRenewalVariants) {
    assertRowText(html, v, Number(v.n));
  }
});

test("Mack Trucks trailing-comma forms render as separate variant rows", () => {
  const html = renderVendorVariants(MackTrucksVariants);
  assert.match(html, /class="vendor-variant-list"/);
  assert.equal((html.match(/vendor-variant-item/g) || []).length, MackTrucksVariants.length);
  for (const v of MackTrucksVariants) {
    assertRowText(html, v, Number(v.n));
  }
});

test("SCO Family of Services internal spacing preserves resolvable variants", () => {
  const html = renderVendorVariants(ScoFamilyVariants);
  assert.match(html, /class="vendor-variant-list"/);
  assert.match(html, /SCO Family of Services/);
  for (const v of ScoFamilyVariants) {
    assertRowText(html, v, Number(v.n));
  }
});

test("single-variant vendors do not render a variant list", () => {
  const html = renderVendorVariants(CastleSingle);
  assert.equal(html, "");
});
