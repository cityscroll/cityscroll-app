import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import moneyResidentSnapshot from "../site/data/money_resident_snapshot.json" with { type: "json" };
import {
  certifyMoneySuggestionDestination,
  moneySuggestionRoute,
} from "../site/suggestion_destination.mjs";

const require = createRequire(import.meta.url);
const { parseNL } = require("../site/nl_parse.js");
const { buildMoneyDeepLink } = require("../site/nl_deeplink.js");

const CONSTRUCTION_FILTER = parseNL("construction contracts over $500k");

test("construction/$500k certification uses the exact resident route and observes the zero-row regression corpus", () => {
  const destination = certifyMoneySuggestionDestination({
    filter: CONSTRUCTION_FILTER,
    snapshot: moneyResidentSnapshot,
    searchPayload: { schema: "cityscroll.keyword_search_response.v1", results: [] },
    today: "2026-08-17",
  });
  assert.equal(
    destination.route,
    "/browse/contracts/?mode=award&q=construction&min=500000&category=Construction%2FConstruction+Services",
  );
  assert.equal(destination.finalCount, 0);
  assert.equal(destination.corpus.residentSnapshot.generatedAt, moneyResidentSnapshot.generated_at);
  assert.equal(destination.corpus.residentSnapshot.rowCount, moneyResidentSnapshot.count);
});

test("destination route stays byte-for-byte aligned with the chip's browser deep link", () => {
  const hash = buildMoneyDeepLink(CONSTRUCTION_FILTER);
  assert.equal(moneySuggestionRoute(CONSTRUCTION_FILTER), `/browse/contracts/?${hash.split("?", 2)[1]}`);
});

test("receipt count is the final amount/category-filtered count and carries both corpus clocks", () => {
  const matchingRow = (request_id) => ({
    request_id,
    type_of_notice_description: "Award",
    short_title: "Construction contract",
    category_description: "Construction/Construction Services",
    contract_amount: "750000",
    start_date: "2026-08-01",
  });
  const destination = certifyMoneySuggestionDestination({
    filter: CONSTRUCTION_FILTER,
    snapshot: {
      schema_version: 1,
      generated_at: "2026-08-15T19:35:39.293Z",
      count: 4,
      rows: [matchingRow("1"), matchingRow("2"), matchingRow("3"), {
        ...matchingRow("4"),
        contract_amount: "499999",
      }],
    },
    searchPayload: {
      schema: "cityscroll.keyword_search_response.v1",
      lanes: [{ id: "contracts", as_of: "2026-08-17T13:00:37.598Z" }],
      results: [],
    },
    today: "2026-08-17",
  });
  assert.equal(destination.finalCount, 3);
  assert.equal(destination.corpus.residentSnapshot.generatedAt, "2026-08-15T19:35:39.293Z");
  assert.equal(destination.corpus.keywordSearch.asOf, "2026-08-17T13:00:37.598Z");
});
