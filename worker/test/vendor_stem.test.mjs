// Pins vendorStem behavior after extraction into lib/normalize.mjs (er-03).
// compile.mjs re-exports the same function so existing imports stay green.
//
//   node --test test/vendor_stem.test.mjs   (from crol-list/worker/)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  VENDOR_SUFFIX,
  vendorStem,
  sameVendorStem,
} from "../src/lib/normalize.mjs";
import { vendorStem as compileVendorStem } from "../src/lib/compile.mjs";

// Frozen reference of the pre-extract body — used only to prove zero behavior churn.
function legacyVendorStem(name) {
  let s = String(name || "")
    .replace(/<[^>]*>/g, " ")
    .toUpperCase()
    .replace(/[.,'’&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let prev;
  do {
    prev = s;
    s = s.replace(VENDOR_SUFFIX, "").trim();
  } while (s !== prev && s.length > 3);
  return s;
}

const PIN_CASES = [
  "Sinergia Inc",
  "Sinergia Incorporated",
  "SINERGIA, INC.",
  "Acme Construction, LLC.",
  "O'Brien & Sons Co",
  "Turner   Construction   Company",
  "Skyline Contracting of New York",
  "Metro Builders LP",
  "Metro Builders, L.L.C",
  "<b>Bold Vendor</b> Corp",
  "",
  null,
  "USA Logistics USA",
  "Acme Co Inc",
  "AB",
  "LEON D. DEMATTEIS CONSTRUCTION CORP",
  "CAMBA, Inc.",
  "HNTB New York Engineering and Architecture, P.C.",
];

test("vendorStem: suffix/case/punctuation variants share a stem", () => {
  const stem = vendorStem("Sinergia Inc");
  assert.equal(stem, "SINERGIA");
  assert.equal(vendorStem("Sinergia Incorporated"), stem);
  assert.equal(vendorStem("SINERGIA, INC."), stem);
  assert.equal(vendorStem("sinergia"), stem);
  assert.notEqual(vendorStem("Sinergia Partners LLC"), stem);
});

test("vendorStem: strips chained suffixes, keeps short names intact", () => {
  assert.equal(vendorStem("Acme Co Inc"), "ACME");
  assert.equal(vendorStem("Consolidated Scaffolding, Inc."), "CONSOLIDATED SCAFFOLDING");
  assert.equal(vendorStem("AB"), "AB");
});

test("vendorStem: empty and null inputs are empty stems", () => {
  assert.equal(vendorStem(""), "");
  assert.equal(vendorStem(null), "");
  assert.equal(vendorStem(undefined), "");
});

test("compile.mjs re-exports the same vendorStem reference behavior", () => {
  for (const input of PIN_CASES) {
    assert.equal(
      compileVendorStem(input),
      vendorStem(input),
      `compile re-export diverged for ${JSON.stringify(input)}`,
    );
  }
});

test("extracted vendorStem matches frozen legacy body on pin cases (0% churn)", () => {
  let changed = 0;
  for (const input of PIN_CASES) {
    if (vendorStem(input) !== legacyVendorStem(input)) changed += 1;
  }
  assert.equal(changed, 0, `production stem change rate: ${changed}/${PIN_CASES.length}`);
});

test("sameVendorStem helper agrees with direct stem equality", () => {
  assert.equal(sameVendorStem("Sinergia Inc", "Sinergia Incorporated"), true);
  assert.equal(sameVendorStem("Sinergia Inc", "Sinergia Partners LLC"), false);
  assert.equal(sameVendorStem("", "Sinergia Inc"), false);
});

test("method metadata is stable for link receipts", () => {
  assert.equal(VENDOR_STEM_METHOD, "vendor_stem_v1");
  assert.equal(VENDOR_STEM_VERSION, "1");
  assert.ok(VENDOR_SUFFIX instanceof RegExp);
});
