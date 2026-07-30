import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { affectedAreaFromRow } from "../../worker/src/lib/hearings.mjs";

const require = createRequire(import.meta.url);
const { hearingAffectedArea } = require("../../site/hearing_location.js");
const corpus = JSON.parse(await readFile(
  new URL("./fixtures/affected_area_golden.json", import.meta.url),
  "utf8",
));
const noticeById = new Map(corpus.notices.map((notice) => [notice.row.request_id, notice]));

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 1;
}

function round(value) {
  return Number((value * 100).toFixed(1));
}

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
    local_notices: 0,
  };

  for (const notice of corpus.notices) {
    const actual = extractor(notice.row);
    const expectedPositive = notice.expected.scope !== "unlocated";
    const actualPositive = actual.scope !== "unlocated";
    if (expectedPositive && actualPositive) counts.true_positive++;
    else if (!expectedPositive && actualPositive) counts.false_positive++;
    else if (expectedPositive) counts.false_negative++;
    else counts.true_negative++;

    if (notice.expected.scope === "local") {
      counts.local_notices++;
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
  }

  return {
    notices: corpus.notices.length,
    ...counts,
    precision_pct: round(ratio(
      counts.true_positive,
      counts.true_positive + counts.false_positive,
    )),
    recall_pct: round(ratio(
      counts.true_positive,
      counts.true_positive + counts.false_negative,
    )),
    false_not_stated_pct: round(ratio(
      counts.false_negative,
      counts.true_positive + counts.false_negative,
    )),
    borough_precision_pct: round(ratio(
      counts.borough_true_positive,
      counts.borough_true_positive + counts.borough_false_positive,
    )),
    borough_recall_pct: round(ratio(
      counts.borough_true_positive,
      counts.borough_true_positive + counts.borough_false_negative,
    )),
    exact_borough_sets_pct: round(ratio(counts.exact_borough_sets, counts.local_notices)),
  };
}

test("golden corpus is real, labelled, diverse, and large enough to measure", () => {
  assert.equal(corpus.source.dataset, "dg92-zbpx");
  assert.equal(corpus.labeling.status, "hand-labelled");
  assert.ok(corpus.notices.length >= 100);
  assert.equal(new Set(corpus.notices.map((notice) => notice.row.request_id)).size, corpus.notices.length);
  assert.ok(new Set(corpus.notices.map((notice) => notice.cohort)).size >= 6);
  assert.ok(corpus.notices.filter((notice) => notice.cohort === "venue-confusion").length >= 15);
  for (const borough of ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]) {
    assert.ok(
      corpus.notices.some((notice) => notice.expected.boroughs.includes(borough)),
      `${borough} must be represented`,
    );
  }
  for (const notice of corpus.notices) {
    assert.match(notice.row.request_id, /^\d{11}$/);
    assert.ok(notice.labeling_note);
    assert.ok(["local", "citywide", "unlocated"].includes(notice.expected.scope));
  }
});

test("Worker and browser fallback agree on every golden notice", () => {
  for (const notice of corpus.notices) {
    assert.deepEqual(
      hearingAffectedArea(notice.row),
      affectedAreaFromRow(notice.row),
      `${notice.row.request_id}: browser and Worker extraction drifted`,
    );
  }
});

test("real notice forms remain first-class affected-area evidence", () => {
  const kent = affectedAreaFromRow(noticeById.get("20260428004").row);
  assert.ok(kent.community_boards.includes("Community Board 1, Brooklyn"));
  assert.ok(kent.addresses.some((address) => address.label === "289 Kent Avenue"));
  assert.ok(kent.street_ranges.some((range) => range.label.startsWith("bounded by South 1st Street")));
  assert.ok(kent.application_numbers.includes("C260087ZMK"));
  assert.ok(kent.application_numbers.includes("26DCP046K"));

  const bsa = affectedAreaFromRow(noticeById.get("20260723030").row);
  assert.ok(bsa.tax_lots.some((lot) => lot.label === "Block 16124, Lot(s) 23, 76"));
  assert.ok(bsa.addresses.some((address) => address.label === "90-01 Beach Channel Drive"));
  assert.ok(!bsa.addresses.some((address) => address.label === "22 Reade Street"));

  const monitorPoint = affectedAreaFromRow(noticeById.get("20260224010").row);
  assert.ok(monitorPoint.project_names.includes("Monitor Point"));
  assert.deepEqual(monitorPoint.boroughs, ["Brooklyn"]);

  const newtownCreek = affectedAreaFromRow(noticeById.get("20251216019").row);
  assert.ok(newtownCreek.project_names.includes("Newtown Creek"));
  assert.deepEqual(newtownCreek.boroughs, ["Brooklyn", "Queens"]);
});

test("affected-area extraction clears the measured corpus quality floor", (context) => {
  const metrics = score(affectedAreaFromRow);
  context.diagnostic(`affected-area metrics ${JSON.stringify(metrics)}`);
  assert.ok(metrics.precision_pct >= 90, `precision ${metrics.precision_pct}% < 90%`);
  assert.ok(metrics.recall_pct >= 85, `recall ${metrics.recall_pct}% < 85%`);
  assert.ok(
    metrics.false_not_stated_pct <= 15,
    `false “not stated” rate ${metrics.false_not_stated_pct}% > 15%`,
  );
  assert.ok(metrics.borough_precision_pct >= 90, `borough precision ${metrics.borough_precision_pct}% < 90%`);
  assert.ok(metrics.borough_recall_pct >= 75, `borough recall ${metrics.borough_recall_pct}% < 75%`);
});
