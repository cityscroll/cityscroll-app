// Honest-data rules across the worker (issue #1: EDA-grounded labeling).
//   - money filters exclude the corrupt amount tail but keep legit multi-billion awards
//   - rolling (year >= 2090) deadlines render as a note, never as a date
//   - D1 notice search enforces both rules in SQL

import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSub } from "../src/lib/compile.mjs";
import { dueLabel } from "../src/alerts.mjs";
import { buildNoticesQuery, toRecord } from "../src/lib/notices.mjs";

test("compileSub money/minAmount: cap is $10B (EDA: max legit award ≈ $6.68B, old $5B cap was wrong)", () => {
  const q = compileSub({ lens: "money", filter: { minAmount: 1000000 } }, "2026-06-30");
  assert.match(q.params["$where"], /contract_amount < 10000000000/);
  assert.doesNotMatch(q.params["$where"], /5000000000/);
});

test("dueLabel: real dates render, rolling placeholders get the honest note", () => {
  assert.equal(dueLabel("2026-08-01T00:00:00"), "due 2026-08-01");
  assert.equal(dueLabel("2090-01-01 00:00:00"), "no fixed deadline (rolling)");
  assert.equal(dueLabel("2099-12-31"), "no fixed deadline (rolling)");
  assert.equal(dueLabel(null), "");
});

test("buildNoticesQuery: amount filters imply contract_amount_valid = 1", () => {
  const { sql, params } = buildNoticesQuery({ minAmount: 500000 });
  assert.match(sql, /contract_amount_valid = 1/);
  assert.match(sql, /contract_amount >= \?/);
  assert.ok(params.includes(500000));
});

test("buildNoticesQuery: AND-of-ORs term groups + rolling/open filters", () => {
  const { sql, params } = buildNoticesQuery({
    termGroups: [["housing", "shelter"], ["brooklyn"]],
    excludeRollingDeadlines: true,
    openOnly: true,
    today: "2026-07-10",
    limit: 10,
  });
  assert.match(sql, /\(haystack LIKE \? OR haystack LIKE \?\)/); // OR within a group
  assert.match(sql, /AND \(haystack LIKE \?\)/);                 // AND between groups
  assert.match(sql, /due_year IS NOT NULL AND due_year < \?/);
  assert.match(sql, /due_date >= \?/);
  assert.match(sql, /LIMIT 10/);
  assert.ok(params.includes("%housing%") && params.includes("%brooklyn%"));
  assert.ok(params.includes(2090) && params.includes("2026-07-10"));
});

test("toRecord: invalid amount nulled, rolling due date becomes deadline_note", () => {
  const rec = toRecord({
    request_id: "x1",
    contract_amount: 96100000000000,
    contract_amount_valid: 0,
    due_date: "2090-01-01 00:00:00",
    due_year: 2090,
    document_urls: '["https://a.example/f"]',
  });
  assert.equal(rec.contract_amount, null);           // corrupt amount never displayed
  assert.equal(rec.contract_amount_display, null);
  assert.equal(rec.due_date, null);                  // no fake 2090 date
  assert.equal(rec.deadline_note, "rolling / no fixed deadline (e.g. pre-qualified list)");
  assert.deepEqual(rec.documents, ["https://a.example/f"]);
});

test("compileSub money vocab merge: maxAmount bounds and category filters (both branches)", () => {
  const award = compileSub({ lens: "money", filter: { minAmount: 100000, maxAmount: 900000, category: "Construction/Construction Services" } }, "2026-06-30");
  assert.equal(award.kind, "award");
  assert.match(award.params["$where"], /contract_amount <= 900000/);
  assert.match(award.params["$where"], /category_description='Construction\/Construction Services'/);
  const maxOnly = compileSub({ lens: "money", filter: { maxAmount: 500000 } }, "2026-06-30");
  assert.equal(maxOnly.kind, "award"); // any amount bound implies the Award query (open bids carry no amounts)
  const rfp = compileSub({ lens: "money", filter: { keywords: ["hvac"], category: "Goods" } }, "2026-06-30");
  assert.equal(rfp.kind, "rfp");
  assert.match(rfp.params["$where"], /category_description='Goods'/);
});
