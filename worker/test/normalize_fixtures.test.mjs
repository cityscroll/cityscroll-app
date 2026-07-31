// Fixture-driven equal/distinct matrix for vendor stems + agency aliases (er-03).
//
//   node --test test/normalize_fixtures.test.mjs   (from crol-list/worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  vendorStem,
  sameVendorStem,
  sameAgency,
  agencyCanonicalId,
  normalizeEntity,
  canonicalAgency,
} from "../src/lib/normalize.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(ROOT, "fixtures/normalize_pairs.json"), "utf8"),
);

const equalPairs = fixtures.must_equal || [];
const distinctPairs = fixtures.must_distinct || [];

function assertEqualPair(pair) {
  if (pair.kind === "agency") {
    assert.ok(
      sameAgency(pair.a, pair.b),
      `agency must alias: ${JSON.stringify(pair.a)} ↔ ${JSON.stringify(pair.b)} (${pair.note}); ids=${agencyCanonicalId(pair.a)}/${agencyCanonicalId(pair.b)}`,
    );
    return;
  }
  assert.equal(
    pair.kind,
    "vendor",
    `unknown kind ${pair.kind}`,
  );
  assert.ok(
    sameVendorStem(pair.a, pair.b),
    `vendor must stem-equal: ${JSON.stringify(pair.a)} ↔ ${JSON.stringify(pair.b)} (${pair.note}); stems=${vendorStem(pair.a)}/${vendorStem(pair.b)}`,
  );
}

function assertDistinctPair(pair) {
  if (pair.kind === "agency") {
    assert.equal(
      sameAgency(pair.a, pair.b),
      false,
      `agency must stay distinct: ${JSON.stringify(pair.a)} ↔ ${JSON.stringify(pair.b)} (${pair.note}); id=${agencyCanonicalId(pair.a)}`,
    );
    return;
  }
  assert.equal(pair.kind, "vendor", `unknown kind ${pair.kind}`);
  assert.equal(
    sameVendorStem(pair.a, pair.b),
    false,
    `vendor must stay distinct: ${JSON.stringify(pair.a)} ↔ ${JSON.stringify(pair.b)} (${pair.note}); stem=${vendorStem(pair.a)}`,
  );
}

test("fixture set is non-empty and balanced", () => {
  assert.ok(equalPairs.length >= 10, `need ≥10 must_equal rows, got ${equalPairs.length}`);
  assert.ok(distinctPairs.length >= 8, `need ≥8 must_distinct rows, got ${distinctPairs.length}`);
  const kindsEqual = new Set(equalPairs.map((p) => p.kind));
  const kindsDistinct = new Set(distinctPairs.map((p) => p.kind));
  assert.ok(kindsEqual.has("vendor") && kindsEqual.has("agency"));
  assert.ok(kindsDistinct.has("vendor") && kindsDistinct.has("agency"));
});

for (const pair of equalPairs) {
  test(`must_equal [${pair.kind}] ${pair.note}`, () => {
    assertEqualPair(pair);
  });
}

for (const pair of distinctPairs) {
  test(`must_distinct [${pair.kind}] ${pair.note}`, () => {
    assertDistinctPair(pair);
  });
}

test("normalizeEntity routes vendor and agency families", () => {
  const v = normalizeEntity("Sinergia Inc", "vendor");
  assert.equal(v.family, "vendor");
  assert.equal(v.key, "SINERGIA");

  const a = normalizeEntity("POLICE DEPARTMENT", "agency");
  assert.equal(a.family, "agency");
  assert.equal(a.key, canonicalAgency("Police Department").canonical_id);
  assert.equal(a.display, "Police Department");

  const empty = normalizeEntity("", "agency");
  assert.equal(empty.key, "");
});

test("measured fixture counts (PR evidence)", () => {
  const vendorEqual = equalPairs.filter((p) => p.kind === "vendor").length;
  const agencyEqual = equalPairs.filter((p) => p.kind === "agency").length;
  const vendorDistinct = distinctPairs.filter((p) => p.kind === "vendor").length;
  const agencyDistinct = distinctPairs.filter((p) => p.kind === "agency").length;

  // These counts are the before/after contract for er-03: the table is the product.
  assert.equal(equalPairs.length, vendorEqual + agencyEqual);
  assert.equal(distinctPairs.length, vendorDistinct + agencyDistinct);

  // Smoke: every equal pair still holds when re-checked in aggregate (no skipped rows).
  for (const pair of equalPairs) assertEqualPair(pair);
  for (const pair of distinctPairs) assertDistinctPair(pair);

  // Documented for operators reading test output / PR body.
  console.log(
    JSON.stringify({
      must_equal_total: equalPairs.length,
      must_equal_vendor: vendorEqual,
      must_equal_agency: agencyEqual,
      must_distinct_total: distinctPairs.length,
      must_distinct_vendor: vendorDistinct,
      must_distinct_agency: agencyDistinct,
      production_stem_change_rate: "0% (extract-only; see vendor_stem.test.mjs legacy pin)",
    }),
  );
});
