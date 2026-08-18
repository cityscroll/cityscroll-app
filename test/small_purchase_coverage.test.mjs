import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMethodFamily,
  exactOverlapRows,
  fiscalYear,
  valueBand,
} from "../tools/measure_small_purchase_coverage.mjs";

test("small-purchase publisher labels remain in separate policy families", () => {
  assert.equal(classifyMethodFamily("Small Purchase - Written"), "ordinary_small_purchase");
  assert.equal(classifyMethodFamily("SM PURCH GOODS SERVICES 100K"), "ordinary_small_purchase");
  assert.equal(classifyMethodFamily("SMALL PURCH -SUBSCRIPTION ETC"), "ordinary_small_purchase");
  assert.equal(classifyMethodFamily("SM. PURCHASE - GOV'T TO GOV'T"), "ordinary_small_purchase");
  assert.equal(classifyMethodFamily("Micropurchase"), "micropurchase");
  assert.equal(classifyMethodFamily("SMALL PURCHASE - UNDER $5,000"), "micropurchase");
  assert.equal(classifyMethodFamily("M/WBE Non Competitive Small Purchase"), "mwbe_small_purchase");
  assert.equal(classifyMethodFamily("REQUEST FOR PROPOSAL"), null);
});

test("exact overlap accepts only governed identifiers and never names", () => {
  const target = [{ ids: { request_id: "20260001", pin_epin: "ABC-123", contract_id: "CT-9" } }];
  const rows = [
    { ids: { request_id: "20260001" } },
    { ids: { pin_epin: "abc 123" } },
    { ids: { contract_id: "CT-9" } },
    { ids: { contract_id: "CT-90" }, vendor: "same name" },
    { ids: {}, vendor: "same name" },
  ];
  assert.deepEqual(exactOverlapRows(rows, target), {
    from_rows: 5,
    matched_rows: 3,
    rate: 0.6,
    matched_by_exact_key: { request_id: 1, pin_epin: 1, contract_id: 1 },
  });
});

test("fiscal-year and value bands preserve the census boundaries", () => {
  assert.equal(fiscalYear("06/30/2026"), 2026);
  assert.equal(fiscalYear("2026-07-01"), 2027);
  assert.equal(valueBand(5_000), "$0.01-$5k");
  assert.equal(valueBand(100_000), ">$35k-$100k");
  assert.equal(valueBand(null), "missing");
  assert.equal(valueBand(Number.NaN), "missing");
});
