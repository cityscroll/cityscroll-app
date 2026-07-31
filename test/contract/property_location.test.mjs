import assert from "node:assert/strict";
import { test } from "node:test";

import { propertyLocationFromRow, propertyScopeText } from "../../site/property_location.mjs";

const LEASE_SURRENDER_ROW = {
  request_id: "20241112003",
  section_name: "Property Disposition",
  short_title: "NOTICE OF VOLUNTARY PUBLIC HEARING",
  additional_description_1: "PUBLIC NOTICE IS HEREBY GIVEN THAT a voluntary public hearing will be held on Tuesday November 26, 2024, commencing at 10:00 am via Conference Call No. 1-646-992-2010, Access Code 233-931-64438 relating to the early surrender of the lease by the tenant of The City of New York (the “City”) on Block 644, Lot 1 (the “Property”) in the Borough of Manhattan. The Property is currently occupied by Gansevoort Market, Inc., pursuant to the lease from the City, acting by and through its Commissioner of the Department of Small Business Services. In order to access the Public Hearing and testify, please call 1-646-992-2010.",
};

test("lease-surrender notice is located via the fallback body scan", () => {
  const location = propertyLocationFromRow(LEASE_SURRENDER_ROW);
  assert.equal(location.scope, "local");
  assert.deepEqual(location.boroughs, ["Manhattan"]);
  assert.deepEqual(location.tax_lots, [{
    label: "Block 644, Lot 1",
    block: "644",
    lots: ["1"],
    source: "Block 644, Lot 1",
  }]);
  assert.ok(location.bbls.includes("1006440001"));
});

test("a hearing dial-in is never treated as the property site", () => {
  const location = propertyLocationFromRow(LEASE_SURRENDER_ROW);
  assert.equal(location.addresses.length, 0);
  assert.equal(location.geometry, null);
});

test("the fallback does not locate a non-NYC parcel with no borough", () => {
  const location = propertyLocationFromRow({
    section_name: "Property Disposition",
    short_title: "Heavy Nettle Forest Management Project 5100",
    additional_description_1: "Bid solicitation for the Sale of Timber and Firewood in the Town of Tompkins, NY. Stand 7055/ 917 estimated at 418 MBF.",
  });
  assert.equal(location.scope, "unlocated");
});

test("the fallback rejects a body listing several boroughs (admin boilerplate)", () => {
  const location = propertyLocationFromRow({
    section_name: "Property Disposition",
    short_title: "Property clerk notice",
    additional_description_1: "Manhattan - 1 Police Plaza. Bronx Property Clerk - 215 East 161 Street. Brooklyn - 700 Columbia Street. Queens - 174-20 North Boundary Road. Staten Island - 1 Edgewater Street.",
  });
  assert.equal(location.scope, "unlocated");
});

test("a marker that anchors after the property details still locates the site", () => {
  const location = propertyLocationFromRow({
    section_name: "Property Disposition",
    short_title: "PUBLIC HEARING ON AMENDMENT OF LEASE",
    additional_description_1: "on Block 73, p/o Lot 8, and Lot 11; Block 74, p/o Lot 1; located within the Special Lower Manhattan District (collectively, the “Disposition Area”). The lease term is extended.",
  });
  assert.equal(location.scope, "local");
  assert.deepEqual(location.boroughs, ["Manhattan"]);
  assert.ok(location.tax_lots.some((lot) => lot.block === "73"));
});

test("propertyScopeText does not collapse to the title alone when scope clauses exist", () => {
  const text = propertyScopeText(LEASE_SURRENDER_ROW);
  assert.match(text, /Block 644/);
  assert.match(text, /Borough of Manhattan/);
});
