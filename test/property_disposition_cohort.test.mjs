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

test("committed observations yield the exact-BBL 219-day cohort seed", () => {
  const rebuilt = buildPropertyDispositionCohort(observations, crossDomain);
  assert.deepEqual(rebuilt, committed);
  assert.equal(rebuilt.cohort.n, 1);
  assert.deepEqual(rebuilt.cohort.pairs[0], {
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
  assert.equal(committed.eligibility.minimum_sample, PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE);
  assert.equal(committed.eligibility.observed_pairs, 1);
  assert.equal(committed.eligibility.status, "insufficient_sample");
  assert.match(committed.eligibility.label, /^n=1 .*insufficient for a duration model$/);
  assert.equal(committed.eligibility.duration_summary_eligible, false);
  assert.equal(committed.eligibility.forecast_eligible, false);
  assert.equal(committed.duration_summary, null);
  assert.equal(committed.forecast, null);
  assert.deepEqual(propertyDispositionCohortReceipt(committed), committedReceipt);
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
