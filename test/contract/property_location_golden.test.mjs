import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { propertyLocationFromRow } from "../../property_location.mjs";
import { affectedAreaFromRow } from "../../worker/src/lib/hearings.mjs";

const corpus = JSON.parse(await readFile(
  new URL("./fixtures/property_location_golden.json", import.meta.url),
  "utf8",
));

const ratio = (numerator, denominator) => denominator ? numerator / denominator : 1;
const percent = (value) => Number((value * 100).toFixed(1));

function score(extractor) {
  const counts = {
    true_positive: 0,
    false_positive: 0,
    false_negative: 0,
    true_negative: 0,
    borough_true_positive: 0,
    borough_false_positive: 0,
    borough_false_negative: 0,
    exact_borough_sets: 0,
    address_expected: 0,
    address_found: 0,
    tax_lot_expected: 0,
    tax_lot_found: 0,
    bbl_expected: 0,
    bbl_found: 0,
  };
  for (const notice of corpus.notices) {
    const actual = extractor(notice.row);
    const expectedPositive = notice.expected.scope === "local";
    const actualPositive = actual.scope === "local";
    if (expectedPositive && actualPositive) counts.true_positive++;
    else if (!expectedPositive && actualPositive) counts.false_positive++;
    else if (expectedPositive) counts.false_negative++;
    else counts.true_negative++;

    if (expectedPositive) {
      const expected = new Set(notice.expected.boroughs);
      const extracted = new Set(actual.boroughs || []);
      for (const borough of extracted) {
        if (expected.has(borough)) counts.borough_true_positive++;
        else counts.borough_false_positive++;
      }
      for (const borough of expected) {
        if (!extracted.has(borough)) counts.borough_false_negative++;
      }
      if (expected.size === extracted.size && [...expected].every((borough) => extracted.has(borough))) {
        counts.exact_borough_sets++;
      }
    }

    for (const [expectedKey, actualKey, expectedCount, foundCount] of [
      ["has_address", "addresses", "address_expected", "address_found"],
      ["has_tax_lot", "tax_lots", "tax_lot_expected", "tax_lot_found"],
      ["has_bbl", "bbls", "bbl_expected", "bbl_found"],
    ]) {
      if (!notice.expected[expectedKey]) continue;
      counts[expectedCount]++;
      if ((actual[actualKey] || []).length) counts[foundCount]++;
    }
  }
  const localNotices = corpus.notices.filter((notice) => notice.expected.scope === "local").length;
  return {
    notices: corpus.notices.length,
    ...counts,
    precision_pct: percent(ratio(counts.true_positive, counts.true_positive + counts.false_positive)),
    recall_pct: percent(ratio(counts.true_positive, counts.true_positive + counts.false_negative)),
    borough_precision_pct: percent(ratio(
      counts.borough_true_positive,
      counts.borough_true_positive + counts.borough_false_positive,
    )),
    borough_recall_pct: percent(ratio(
      counts.borough_true_positive,
      counts.borough_true_positive + counts.borough_false_negative,
    )),
    exact_borough_sets_pct: percent(ratio(counts.exact_borough_sets, localNotices)),
    address_coverage_pct: percent(ratio(counts.address_found, counts.address_expected)),
    tax_lot_coverage_pct: percent(ratio(counts.tax_lot_found, counts.tax_lot_expected)),
    bbl_coverage_pct: percent(ratio(counts.bbl_found, counts.bbl_expected)),
  };
}

test("Property corpus is real, hand-labelled, diverse, and large enough to measure", () => {
  assert.equal(corpus.source.dataset, "dg92-zbpx");
  assert.equal(corpus.source.section, "Property Disposition");
  assert.equal(corpus.labeling.status, "hand-labelled");
  assert.ok(corpus.notices.length >= 60);
  assert.equal(new Set(corpus.notices.map((notice) => notice.row.request_id)).size, corpus.notices.length);
  assert.ok(new Set(corpus.notices.map((notice) => notice.cohort)).size >= 5);
  assert.ok(corpus.notices.filter((notice) => notice.expected.scope === "unlocated").length >= 10);
  for (const borough of ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]) {
    assert.ok(corpus.notices.some((notice) => notice.expected.boroughs.includes(borough)));
  }
  for (const notice of corpus.notices) {
    assert.match(notice.row.request_id, /^\d{11}$/);
    assert.equal(notice.row.section_name, "Property Disposition");
    assert.ok(notice.labeling_note);
  }
});

test("Property location extraction clears the measured quality floor", (context) => {
  const baseline = score(affectedAreaFromRow);
  const metrics = score(propertyLocationFromRow);
  context.diagnostic(`Property location baseline ${JSON.stringify(baseline)}`);
  context.diagnostic(`Property location metrics ${JSON.stringify(metrics)}`);
  assert.ok(metrics.precision_pct >= 90, `precision ${metrics.precision_pct}% < 90%`);
  assert.ok(metrics.recall_pct >= 90, `recall ${metrics.recall_pct}% < 90%`);
  assert.ok(metrics.borough_precision_pct >= 90, `borough precision ${metrics.borough_precision_pct}% < 90%`);
  assert.ok(metrics.borough_recall_pct >= 90, `borough recall ${metrics.borough_recall_pct}% < 90%`);
  assert.ok(metrics.exact_borough_sets_pct >= 90, `exact borough sets ${metrics.exact_borough_sets_pct}% < 90%`);
  assert.ok(metrics.address_coverage_pct >= 90, `address coverage ${metrics.address_coverage_pct}% < 90%`);
  assert.ok(metrics.tax_lot_coverage_pct >= 85, `tax-lot coverage ${metrics.tax_lot_coverage_pct}% < 85%`);
  assert.ok(metrics.bbl_coverage_pct >= 85, `BBL coverage ${metrics.bbl_coverage_pct}% < 85%`);
});
