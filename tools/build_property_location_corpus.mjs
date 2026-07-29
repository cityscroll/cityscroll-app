#!/usr/bin/env node
/**
 * Rebuild the pinned, hand-labelled Property location corpus.
 *
 * The labels below are the stable evaluation input. This script only re-fetches the
 * corresponding source rows; it never infers or changes a label from the fetched text.
 * Do not run it in CI because a live evaluation set would make measurements incomparable.
 */

import { writeFile } from "node:fs/promises";

const SOURCE = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const OUTPUT = new URL("../test/contract/fixtures/property_location_golden.json", import.meta.url);
const CAPTURED_AT = "2026-07-29";
const FIELDS = [
  "request_id", "start_date", "agency_name", "type_of_notice_description", "section_name",
  "short_title", "event_date", "building_name", "street_address_1", "street_address_2",
  "city", "state", "zip_code", "additional_description_1", "additional_description_2",
  "additional_description_3", "other_info_1", "other_info_2", "other_info_3", "printout_1",
  "printout_2", "printout_3",
];

const HPD_BY_BOROUGH = {
  Manhattan: [
    "20180416104", "20180413111", "20180416101", "20180326111", "20180222102",
    "20171208114", "20171207117", "20171109103", "20170512109", "20170512101",
    "20170515104", "20170208105", "20170130106", "20170126108", "20170126112",
    "20161107103",
  ],
  Bronx: [
    "20190109102", "20180411103", "20180326101", "20170801105", "20170424107",
    "20161117102", "20161101107", "20161101105",
  ],
  Brooklyn: [
    "20180518115", "20180518113", "20180404109", "20171122105", "20171109102",
    "20171031109", "20171006101", "20170801103", "20170707110", "20170512106",
    "20170516111", "20170512102", "20170412105", "20170324106", "20161205109",
    "20161115105", "20161115104",
  ],
  Queens: [
    "20171005106", "20170901116", "20170901115", "20170807103", "20170807104",
    "20170731101", "20161102112",
  ],
};

const SPECIAL_LOCAL = {
  "20251209013": {
    borough: "Bronx",
    cohort: "lease-sites",
    signals: { address: true, tax_lot: false, bbl: false },
    note: "The lease RFP names three Bronx solar sites; One Liberty Plaza is only the proposal-opening venue.",
  },
  "20220518001": {
    borough: "Staten Island",
    cohort: "direct-address-sale",
    signals: { address: true, tax_lot: true, bbl: true },
    note: "The residential sale identifies 35 Beebe Street and Block 684, Lot 261.",
  },
  "20220504006": {
    borough: "Staten Island",
    cohort: "block-lot-site",
    signals: { address: false, tax_lot: true, bbl: true },
    note: "The Industry Road development site is identified as Staten Island Block 1801, Lot 170 without a numbered street address.",
  },
  "20211018009": {
    borough: "Brooklyn",
    cohort: "title-address-sale",
    signals: { address: true, tax_lot: false, bbl: false },
    note: "The corrected sale notice identifies 1 Hanson Place, Apartment 22D in its title; the body fields are empty.",
  },
};

const UNLOCATED = {
  "20260604044": "The forest-management project is outside New York City and supplies no supported NYC site.",
  "20260526003": "The destruction notice concerns seized products and does not identify a property site.",
  "20251230008": "The destruction notice concerns seized products and does not identify a property site.",
  "20250814030": "The watershed forest-management notice supplies no supported NYC site.",
  "20250730022": "The lease-auction announcement does not name the properties in the notice.",
  "20250107025": "The lease-auction announcement does not name the properties in the notice.",
  "20240108007": "The notice redirects readers to another section and contains no property site.",
  "20230131011": "The timber sale is in Ulster County and supplies no supported NYC site.",
  "20220722001": "The online vehicle auction does not identify a property site.",
  "20201230002": "The generic surplus-assets notice does not identify a property site.",
  "20200128107": "The property-clerk notice concerns unclaimed items and does not identify a property site.",
  "20181227101": "The generic surplus-assets notice does not identify a property site.",
  "20161228101": "The property-clerk notice concerns unclaimed items and does not identify a property site.",
};

const LABELS = new Map();
for (const [borough, ids] of Object.entries(HPD_BY_BOROUGH)) {
  for (const id of ids) {
    const hasAddress = !["20170731101", "20161101105"].includes(id);
    LABELS.set(id, {
      cohort: "hpd-disposition-table",
      expected: {
        scope: "local",
        boroughs: [borough],
        has_address: hasAddress,
        has_tax_lot: true,
        has_bbl: true,
      },
      labeling_note: `The disposition table and scope paragraph identify a ${borough} site; the hearing venue is not a subject property.`,
    });
  }
}
for (const [id, label] of Object.entries(SPECIAL_LOCAL)) {
  LABELS.set(id, {
    cohort: label.cohort,
    expected: {
      scope: "local",
      boroughs: [label.borough],
      has_address: label.signals.address,
      has_tax_lot: label.signals.tax_lot,
      has_bbl: label.signals.bbl,
    },
    labeling_note: label.note,
  });
}
for (const [id, note] of Object.entries(UNLOCATED)) {
  LABELS.set(id, {
    cohort: "honest-abstention",
    expected: {
      scope: "unlocated",
      boroughs: [],
      has_address: false,
      has_tax_lot: false,
      has_bbl: false,
    },
    labeling_note: note,
  });
}

async function fetchRows() {
  const ids = [...LABELS.keys()];
  const params = new URLSearchParams({
    "$select": FIELDS.join(","),
    "$where": `request_id in(${ids.map((id) => `'${id}'`).join(",")})`,
    "$limit": String(ids.length),
  });
  const response = await fetch(`${SOURCE}?${params}`);
  if (!response.ok) throw new Error(`City Record query failed: ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("City Record query returned a non-array response");
  const byId = new Map(rows.map((row) => [row.request_id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Missing labelled rows: ${missing.join(", ")}`);
  return ids.map((id) => byId.get(id));
}

const rows = await fetchRows();
const notices = rows.map((row) => ({
  cohort: LABELS.get(row.request_id).cohort,
  row,
  expected: LABELS.get(row.request_id).expected,
  labeling_note: LABELS.get(row.request_id).labeling_note,
}));
const payload = {
  schema_version: 1,
  source: {
    name: "City Record Online",
    dataset: "dg92-zbpx",
    url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
    captured_at: CAPTURED_AT,
    section: "Property Disposition",
  },
  labeling: {
    status: "hand-labelled",
    method: "Each complete notice was reviewed for the subject property's NYC borough and for the presence of site-address, tax-lot, and BBL-resolvable evidence. Hearing venues, contact offices, generic auctions, and non-NYC assets were excluded.",
  },
  notices,
};

await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${notices.length} labelled Property notices to ${OUTPUT.pathname}`);
