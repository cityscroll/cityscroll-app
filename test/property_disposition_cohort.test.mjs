import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildPropertyDispositionCohort,
  PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE,
  propertyDispositionCohortReceipt,
} from "../tools/lib/property_disposition_cohort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const observations = JSON.parse(
  readFileSync(join(ROOT, "site/data/property_domain_observations.json"), "utf8"),
);
const crossDomain = JSON.parse(
  readFileSync(join(ROOT, "site/data/property_cross_domain_lookup.json"), "utf8"),
);
const committed = JSON.parse(
  readFileSync(join(ROOT, "site/data/property_disposition_cohort.json"), "utf8"),
);
const committedReceipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/property_sources/verification_receipts/property_disposition_cohort_latest.json",
    ),
    "utf8",
  ),
);

test("committed cohort and receipt match the current exact-BBL observations", () => {
  const rebuilt = buildPropertyDispositionCohort(observations, crossDomain);
  assert.deepEqual(rebuilt, committed);
  assert.deepEqual(propertyDispositionCohortReceipt(rebuilt), committedReceipt);
  const { n, pairs } = rebuilt.cohort;
  assert.equal(n, pairs.length);
  assert.equal(new Set(pairs.map((pair) => pair.pair_id)).size, n);
  assert.equal(rebuilt.cohort.join_method, "exact_normalized_bbl");
  assert.equal(rebuilt.cohort.text_match_used, false);
  assert.equal(rebuilt.eligibility.observed_pairs, n);
  assert.equal(rebuilt.eligibility.minimum_sample, PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE);
  const eligible = n >= PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE;
  assert.equal(rebuilt.eligibility.status, eligible ? "eligible" : "insufficient_sample");
  assert.equal(rebuilt.eligibility.duration_summary_eligible, eligible);
  assert.equal(rebuilt.eligibility.forecast_eligible, eligible);
  if (!eligible) {
    assert.match(rebuilt.eligibility.label, new RegExp(`^n=${n} .*insufficient for a duration model$`));
    assert.equal(rebuilt.duration_summary, null);
    assert.equal(rebuilt.forecast, null);
  }
});

// Retain the original published pair as a fixed specimen for interval and
// provenance checks, regardless of which notices the current snapshot holds.
const seedBbl = "1019540055";
const seedRows = [
  {
    request_id: "20161004104",
    start_date: "2016-10-12",
    disposition_stage: "hearing",
    property_location: { bbls: [seedBbl] },
  },
  {
    request_id: "20170512101",
    start_date: "2017-05-19",
    disposition_stage: "auction_or_rfp",
    property_location: { bbls: [seedBbl] },
  },
];
const seedCohort = buildPropertyDispositionCohort({ property_rows: seedRows }, {
  by_bbl: {
    [seedBbl]: {
      bbl: seedBbl,
      property_notices: seedRows.map(({ request_id }) => ({ request_id })),
    },
  },
});

test("the original exact-BBL cohort seed spans 219 days", () => {
  assert.equal(seedCohort.cohort.n, 1);
  assert.deepEqual(seedCohort.cohort.pairs[0], {
    pair_id: "property-disposition:1019540055:20161004104:20170512101",
    bbl: "1019540055",
    hearing: {
      request_id: "20161004104",
      date: "2016-10-12",
      date_basis: "start_date",
    },
    auction_or_rfp: {
      request_id: "20170512101",
      date: "2017-05-19",
      date_basis: "start_date",
    },
    interval_days: 219,
    provenance: {
      join_method: "exact_normalized_bbl",
      join_key: "bbl:1019540055",
      source_system: "city_record",
      source_record_ids: ["city_record:20161004104", "city_record:20170512101"],
      source_fields: ["property_location.bbls", "disposition_stage", "start_date"],
      corroborating_artifact: "site/data/property_cross_domain_lookup.json#by_bbl",
      text_match_used: false,
    },
  });
});

test("n=1 is explicitly ineligible for summaries and forecasts", () => {
  assert.equal(seedCohort.eligibility.minimum_sample, PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE);
  assert.equal(seedCohort.eligibility.observed_pairs, 1);
  assert.equal(seedCohort.eligibility.status, "insufficient_sample");
  assert.match(seedCohort.eligibility.label, /^n=1 .*insufficient for a duration model$/);
  assert.equal(seedCohort.eligibility.duration_summary_eligible, false);
  assert.equal(seedCohort.eligibility.forecast_eligible, false);
  assert.equal(seedCohort.duration_summary, null);
  assert.equal(seedCohort.forecast, null);
});

test("same address or title cannot create a pair without one corroborated exact BBL", () => {
  const rows = [
    {
      request_id: "hearing",
      start_date: "2025-01-01",
      short_title: "Identical parcel title",
      street_address_1: "1 Same Street",
      disposition_stage: "hearing",
      property_location: { bbls: ["1-00001-0001"] },
    },
    {
      request_id: "auction-wrong-bbl",
      start_date: "2025-02-01",
      short_title: "Identical parcel title",
      street_address_1: "1 Same Street",
      disposition_stage: "auction_or_rfp",
      property_location: { bbls: ["1000010002"] },
    },
    {
      request_id: "auction-title-only",
      start_date: "2025-03-01",
      short_title: "Public auction for Identical parcel title",
      street_address_1: "1 Same Street",
      property_location: { bbls: ["1000010001"] },
    },
  ];
  const exactIndex = {
    by_bbl: {
      "1000010001": {
        bbl: "1000010001",
        property_notices: [
          { request_id: "hearing" },
          { request_id: "auction-title-only" },
        ],
      },
      "1000010002": {
        bbl: "1000010002",
        property_notices: [{ request_id: "auction-wrong-bbl" }],
      },
    },
  };
  const result = buildPropertyDispositionCohort({ property_rows: rows }, exactIndex);
  assert.equal(result.cohort.n, 0);
  assert.equal(result.cohort.text_match_used, false);
});

test("formatted BBLs normalize to the same exact parcel", () => {
  const rows = [
    {
      request_id: "h",
      start_date: "2025-01-01",
      disposition_stage: "hearing",
      property_location: { bbls: ["1-00001-0001"] },
    },
    {
      request_id: "a",
      start_date: "2025-01-31",
      disposition_stage: "auction_or_rfp",
      property_location: { bbls: ["1000010001"] },
    },
  ];
  const exactIndex = {
    by_bbl: {
      "1000010001": {
        bbl: "1000010001",
        property_notices: [{ request_id: "h" }, { request_id: "a" }],
      },
    },
  };
  const result = buildPropertyDispositionCohort({ property_rows: rows }, exactIndex);
  assert.equal(result.cohort.n, 1);
  assert.equal(result.cohort.pairs[0].bbl, "1000010001");
  assert.equal(result.cohort.pairs[0].interval_days, 30);
});
