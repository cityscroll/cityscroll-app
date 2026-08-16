import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACTION_LOCATION_BASES,
  actionAddressCandidates,
  buildContractActionLocationRow,
  fillContractActionLocationSelects,
  pickGeoSearchMatch,
  rowMatchesContractActionFilter,
} from "../site/contract_action_location.mjs";

const boundaries = JSON.parse(readFileSync(
  new URL("../site/data/district_boundaries.json", import.meta.url),
  "utf8",
));

test("inventory keeps submission, pre-bid, and document-pickup addresses as distinct bases", () => {
  const rows = [
    {
      request_id: "submission",
      address_to_request: "65 Court Street, 12th Floor, Brooklyn, NY 11201",
    },
    {
      request_id: "prebid",
      additional_description_1:
        "A mandatory pre-bid meeting will be held. LOCATION: NYC Health + Hospitals / Harlem, 506 Lenox Avenue, New York, NY 10037.",
    },
    {
      request_id: "pickup",
      additional_description_1:
        "Bid documents may be picked up at 90 Church Street, 5th Floor, New York, NY 10007 during business hours.",
    },
  ];

  assert.deepEqual(
    rows.map((row) => actionAddressCandidates(row).map((item) => item.basis)),
    [
      [ACTION_LOCATION_BASES.SUBMISSION],
      [ACTION_LOCATION_BASES.PRE_BID],
      [ACTION_LOCATION_BASES.DOCUMENT_PICKUP],
    ],
  );
});

test("venue extraction excludes dates and bid-opening labels before the street", () => {
  const rows = actionAddressCandidates({
    additional_description_1: "A pre-bid conference will be held August 8, 2026 at 10 A.M. at 1680 Lexington Avenue, New York, NY 10029. Bid opening Location - 1 Centre Street, New York, NY 10007.",
  });
  assert.ok(rows.some((row) => row.address === "1680 Lexington Avenue, New York, NY 10029"));
  assert.ok(rows.some((row) => row.address === "1 Centre Street, New York, NY 10007"));
  assert.ok(rows.every((row) => !/^2026\b|^8 Bid\b/i.test(row.address)));
});

test("placeholders and non-NYC action addresses never become NYC pins", () => {
  for (const value of [".", "PASSPort", "https://example.org/rfp"]) {
    assert.deepEqual(actionAddressCandidates({ address_to_request: value }), []);
  }
  const [outside] = actionAddressCandidates({
    additional_description_1:
      "Bid packages can be collected at 71 Smith Avenue, Kingston, NY 12401.",
  });
  assert.equal(outside.basis, ACTION_LOCATION_BASES.DOCUMENT_PICKUP);
  assert.equal(outside.jurisdiction, "outside_nyc");
  assert.equal(pickGeoSearchMatch(outside, []), null);
});

test("GeoSearch selection requires a matching NYC result rather than accepting the first fuzzy hit", () => {
  const [candidate] = actionAddressCandidates({
    address_to_request: "65 Court Street, 12th Floor, Brooklyn, NY 11201",
  });
  const match = pickGeoSearchMatch(candidate, [
    {
      properties: { label: "90 COURT STREET, Brooklyn, NY, USA", borough: "Brooklyn" },
      geometry: { coordinates: [-73.991861, 40.69118] },
    },
    {
      properties: {
        label: "65 COURT STREET, Brooklyn, NY, USA",
        borough: "Brooklyn",
        addendum: { pad: { bbl: "3002660020" } },
      },
      geometry: { coordinates: [-73.990983, 40.691765] },
    },
  ]);
  assert.equal(match.label, "65 COURT STREET, Brooklyn, NY, USA");
  assert.equal(match.bbl, "3002660020");
  assert.equal(match.method, "nyc_geosearch_strict_address");
});

test("resolved action geography carries an explicit basis through both district joins", () => {
  const raw = {
    request_id: "20260226026",
    short_title: "Job Order Contract for Electric Work",
    address_to_request: "65 Court Street, 12th Floor, Brooklyn, NY 11201",
  };
  const [candidate] = actionAddressCandidates(raw);
  const geocodes = new Map([[candidate.normalized, {
    label: "65 COURT STREET, Brooklyn, NY, USA",
    borough: "Brooklyn",
    lat: 40.691765,
    lon: -73.990983,
    bbl: "3002660020",
    method: "nyc_geosearch_strict_address",
  }]]);
  const out = buildContractActionLocationRow(raw, geocodes, boundaries);
  assert.equal(out.locations.length, 1);
  assert.equal(out.locations[0].basis, ACTION_LOCATION_BASES.SUBMISSION);
  assert.equal(out.locations[0].basis_label, "Located by submission address");
  assert.equal(out.locations[0].borough, "Brooklyn");
  assert.match(out.locations[0].community_district, /^K\d{2}$/);
  assert.match(out.locations[0].council_district, /^\d{1,2}$/);
  assert.equal(out.locations[0].is_place_of_performance, false);
});

test("district filtering uses the same locations that are counted", () => {
  const row = {
    request_id: "one",
    locations: [{
      basis: ACTION_LOCATION_BASES.SUBMISSION,
      borough: "Brooklyn",
      community_district: "K02",
      council_district: "33",
    }],
  };
  assert.equal(rowMatchesContractActionFilter(row, {
    basis: ACTION_LOCATION_BASES.SUBMISSION,
    borough: "Brooklyn",
    community_district: "K02",
    council_district: "33",
  }), true);
  assert.equal(rowMatchesContractActionFilter(row, {
    basis: ACTION_LOCATION_BASES.PRE_BID,
  }), false);
  assert.equal(rowMatchesContractActionFilter(row, { borough: "Queens" }), false);
});

test("a committed multi-basis record does not infer an unrelated response basis", () => {
  const row = JSON.parse(readFileSync(
    new URL("../site/data/contract_action_address_locations.json", import.meta.url),
    "utf8",
  )).rows.find((candidate) => candidate.request_id === "20260723025");
  assert.ok(row);
  assert.equal(rowMatchesContractActionFilter(row, { basis: ACTION_LOCATION_BASES.SUBMISSION }), true);
  assert.equal(rowMatchesContractActionFilter(row, { basis: ACTION_LOCATION_BASES.PRE_BID }), true);
  assert.equal(rowMatchesContractActionFilter(row, { basis: ACTION_LOCATION_BASES.DOCUMENT_PICKUP }), false);
});

test("district facet rails paint only registry-resolvable keys from resolved locations", () => {
  const selects = {
    "#moneyboro": { value: "" },
    "#moneylocationbasis": { value: "" },
    "#moneycd": {
      value: "",
      options: [],
      get innerHTML() { return this._html || ""; },
      set innerHTML(html) {
        this._html = html;
        this.options = [...String(html).matchAll(/value="([^"]*)"/g)].map((match) => ({
          value: match[1],
          textContent: match[1],
        }));
      },
    },
    "#moneycouncil": {
      value: "",
      options: [],
      get innerHTML() { return this._html || ""; },
      set innerHTML(html) {
        this._html = html;
        this.options = [...String(html).matchAll(/value="([^"]*)"/g)].map((match) => ({
          value: match[1],
          textContent: match[1],
        }));
      },
    },
  };
  const rails = {
    "#money-borough-rail": { innerHTML: "" },
    "#moneycd-facets": { innerHTML: "" },
    "#moneycouncil-facets": { innerHTML: "" },
  };
  const documentRef = {
    querySelector: (selector) => selects[selector] || rails[selector] || null,
  };
  fillContractActionLocationSelects({ rows: [{ locations: [
    { basis: "submission_address", basis_label: "Located by submission address", is_place_of_performance: false, borough: "Manhattan", community_district: "M01", council_district: "1" },
    { basis: "submission_address", basis_label: "Located by submission address", is_place_of_performance: false, borough: "Manhattan", community_district: "M01", council_district: "1" },
    { basis: "submission_address", basis_label: "Located by submission address", is_place_of_performance: false, borough: "Brooklyn", community_district: "K02", council_district: "33" },
    // Fail closed: label without borough, and non-registry council id, never become chips.
    { basis: "submission_address", basis_label: "Located by submission address", is_place_of_performance: false, borough: "Brooklyn", community_district: "Community District 4", council_district: "99" },
  ] }] }, { documentRef, councilLabel: (value) => `Council ${value}` });
  assert.deepEqual(
    selects["#moneycd"].options.map((option) => option.value).filter(Boolean),
    ["K02", "M01"],
  );
  assert.deepEqual(
    selects["#moneycouncil"].options.map((option) => option.value).filter(Boolean),
    ["1", "33"],
  );
  assert.match(rails["#moneycd-facets"].innerHTML, /data-district-id="K02"/);
  assert.match(rails["#moneycd-facets"].innerHTML, /data-district-id="M01"/);
  assert.doesNotMatch(rails["#moneycd-facets"].innerHTML, /Community District 4/);
  assert.match(rails["#moneycouncil-facets"].innerHTML, /data-district-id="33"/);
  assert.doesNotMatch(rails["#moneycouncil-facets"].innerHTML, /data-district-id="99"/);
  assert.match(rails["#moneycd-facets"].innerHTML, /#money\?basis=contract_action_address&amp;cd=K02/);
  assert.match(rails["#moneycouncil-facets"].innerHTML, /district-map-pivot/);
  assert.match(rails["#money-borough-rail"].innerHTML, /data-borough-scope-link="Manhattan"/);
  assert.match(rails["#money-borough-rail"].innerHTML, /data-borough-scope-link="Brooklyn"/);
  assert.doesNotMatch(rails["#money-borough-rail"].innerHTML, /data-borough-scope-link="Queens"/);
});
