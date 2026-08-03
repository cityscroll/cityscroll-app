/**
 * Human-derivation location extractors — golden cases from real City Record notices.
 * Methods must carry evidence + confidence; unlocated rows record a reason.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import {
  placeFromDerivations,
  deriveLocationCandidates,
  boroughOfPhrases,
  venueHeldAtSpans,
  isVirtualOnlyText,
} from "../site/location_derivation.mjs";
import {
  meetingPlaceFromRow,
  affectedAreaFromRow,
} from "../worker/src/lib/hearings.mjs";
import {
  meetingPlacementsFromRow,
  moneyPlacementsFromRow,
  buildDistrictActivity,
} from "../tools/lib/district_activity.mjs";

const boundaries = JSON.parse(
  readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"),
);

test("borough-of phrases catch disposition geography, not held-in venue rooms", () => {
  const matter = boroughOfPhrases(
    "HPD has proposed the sale of City-owned property in the Borough of The Bronx: 511 West 171st Street",
  );
  assert.ok(matter.some((p) => p.borough === "Bronx"));

  const venueOnly = boroughOfPhrases(
    "NOTICE of a joint public hearing to be held on 8/10/2026, at 255 Greenwich Street, 8th Floor, in Manhattan",
  );
  // Bare "in Manhattan" after held-at is venue language — must not invent a matter pin.
  assert.equal(venueOnly.filter((p) => p.borough === "Manhattan").length, 0);
});

test("venue held-at spans extract street addresses with evidence", () => {
  const spans = venueHeldAtSpans(
    "The public hearing will be held at 255 Greenwich Street, 8th Floor, New York.",
  );
  assert.ok(spans.length >= 1);
  assert.match(spans[0].address, /255 Greenwich/i);
  assert.ok(spans[0].evidence.length > 0);
});

test("virtual-only detection for conference-call hearings", () => {
  assert.equal(
    isVirtualOnlyText("The public hearing will be held via conference call. Call in #1-555-0100"),
    true,
  );
  assert.equal(
    isVirtualOnlyText("Hybrid hearing at 209 Joralemon Street and virtually via Webex", "209 Joralemon Street"),
    false,
  );
});

test("golden: 511 West 171 disposition is Bronx matter (not unlocated)", () => {
  // Field case 20260723022 — title alone is incomplete; body has Borough of The Bronx.
  const row = {
    request_id: "20260723022",
    agency_name: "Housing Preservation and Development",
    short_title: "511 West 171",
    additional_description_1:
      "PLEASE TAKE NOTICE that a public hearing will be held via conference call. "
      + "HPD has proposed the sale of the following City-owned property in the Borough of The Bronx: "
      + "511 West 171 st Street 2128/55",
  };
  const place = meetingPlaceFromRow(row);
  assert.equal(place.scope, "local");
  assert.ok(place.boroughs.includes("Bronx"));
  assert.ok(place.derivation?.methods?.length);
  assert.ok(place.derivation.evidence.some((e) => /Bronx/i.test(e)));
  const slots = meetingPlacementsFromRow(row, boundaries);
  assert.ok(slots.some((s) => s.borough === "Bronx"));
  assert.ok(slots[0].confidence >= 0.8);
});

test("golden: WNYC Transmitter Park title is Brooklyn matter", () => {
  const row = {
    request_id: "20260716022",
    agency_name: "Parks and Recreation",
    short_title:
      "Notice of Joint Public Hearing: for Outdoor Café in WNYC Transmitter Park, Brooklyn (Solicitation # B385-SB-2025)",
    street_address_1: "255 Greenwich Street",
    city: "New York",
    state: "NY",
    zip_code: "10007",
    additional_description_1:
      "JOINT PUBLIC HEARING of FCRC and Parks to be held at 255 Greenwich Street in Manhattan "
      + "relative to a concession in WNYC Transmitter Park located at 10 Kent Street, Brooklyn, NY 11222",
  };
  const place = meetingPlaceFromRow(row);
  assert.equal(place.scope, "local");
  assert.ok(place.boroughs.includes("Brooklyn"));
  // Matter wins over venue — Brooklyn park, not only the Manhattan hearing room.
  assert.ok(
    place.derivation?.role === "matter" || place.source === "matter",
    `expected matter source, got ${place.source} / ${place.derivation?.role}`,
  );
});

test("golden: Staten Island tax block acquisition", () => {
  const row = {
    request_id: "20260709020",
    agency_name: "Citywide Administrative Services",
    short_title: "FOR ACQUISTION - Block 5308 Lot 50",
    additional_description_1:
      "IN THE MATTER of the acquisition of the Staten Island Tax Block 5308, Lot 50 "
      + "to facilitate expansion of Crescent Beach Park, in Staten Island, Community District 3. "
      + "Hearing via Conference Call No. 1-555-0199.",
  };
  const place = meetingPlaceFromRow(row);
  assert.equal(place.scope, "local");
  assert.ok(place.boroughs.includes("Staten Island"));
});

test("golden: Queens lease title address + body CB 8", () => {
  const row = {
    request_id: "20260601045",
    agency_name: "Citywide Administrative Services",
    short_title: "FOR LEASES - 197-15 Hillside Avenue",
    additional_description_1:
      "IN THE MATTER of a renewal of the lease at 197-15 Hillside Avenue in the Borough of Queens "
      + "for Community Board 8 to use as a walk-in service center.",
  };
  const area = affectedAreaFromRow(row);
  assert.equal(area.scope, "local");
  assert.ok(area.boroughs.includes("Queens"));
  const slots = meetingPlacementsFromRow(row, boundaries);
  assert.ok(
    slots.some((s) => s.community === "Q08" || s.borough === "Queens"),
    JSON.stringify(slots),
  );
});

test("golden: CPC venue column places Manhattan when no matter pin", () => {
  const row = {
    request_id: "20260721023",
    agency_name: "City Planning Commission",
    short_title: "City Planning Commission Public Hearing",
    street_address_1: "120 Broadway",
    city: "New York",
    state: "NY",
    zip_code: "10271",
  };
  const place = meetingPlaceFromRow(row);
  assert.equal(place.scope, "local");
  assert.ok(place.boroughs.includes("Manhattan"));
  assert.ok(
    place.derivation?.methods?.includes("venue_column")
      || place.derivation?.methods?.includes("agency_hq")
      || place.source === "venue",
  );
  assert.ok((place.derivation?.confidence ?? 0) < 0.85, "venue/agency weaker than matter");
});

test("golden: money vendor_address Valentine Avenue → Bronx (derived tier)", () => {
  const row = {
    request_id: "20260723031",
    agency_name: "Health and Mental Hygiene",
    short_title: "Catering Services",
    vendor_name: "Make it Zesty LLC",
    vendor_address: "1880 Valentine Avenue",
    additional_description_1: "Food Catering Services for the Division of Disease Control, BHHS.",
  };
  const place = placeFromDerivations(row, { forLens: "money" });
  assert.equal(place.scope, "local");
  assert.ok(place.boroughs.includes("Bronx"));
  assert.equal(place.confidence_tier, "derived");
  const slots = moneyPlacementsFromRow(row, boundaries);
  assert.ok(slots.some((s) => s.borough === "Bronx"));
});

test("golden: SYEP throughout New York City → citywide", () => {
  const row = {
    request_id: "20260724015",
    agency_name: "Youth and Community Development",
    short_title: "Summer Youth Employment Program NAQ: Career Ready",
    vendor_name: "Child Development Center - Mosholu Montefiore Community Center",
    additional_description_1:
      "SYEP providers serve youth ages 14-24 throughout New York City by providing employment experience.",
  };
  const place = placeFromDerivations(row, { forLens: "money" });
  assert.equal(place.scope, "citywide");
  const slots = moneyPlacementsFromRow(row, boundaries);
  assert.ok(slots.some((s) => s.borough === "Citywide"));
});

test("golden: money title CITYWIDE and borough abbreviations", () => {
  const citywide = placeFromDerivations({
    short_title: "FIRE EXTINGUISHER MAINTENANCE, INSTALLATION AND REPAIRS, CITYWIDE",
    agency_name: "Citywide Administrative Services",
  }, { forLens: "money" });
  assert.equal(citywide.scope, "citywide");

  const bx = placeFromDerivations({
    short_title: "Immediate Emergency Demolition - 2592 3rd Ave, BX",
    agency_name: "Housing Preservation and Development",
  }, { forLens: "money" });
  assert.equal(bx.scope, "local");
  assert.ok(bx.boroughs.includes("Bronx"), `expected Bronx, got ${bx.boroughs}`);

  const hood = placeFromDerivations({
    short_title: "South Hollis Library Renovation RFQ",
    agency_name: "Queens Public Library",
  }, { forLens: "money" });
  assert.equal(hood.scope, "local");
  assert.ok(hood.boroughs.includes("Queens"), `expected Queens from neighborhood, got ${hood.boroughs}`);
});

test("golden: money agency service area and MN04 community-district token", () => {
  const bp = placeFromDerivations({
    short_title: "Neighborhood planning study",
    agency_name: "Bronx Borough President",
  }, { forLens: "money" });
  assert.equal(bp.scope, "local");
  assert.ok(bp.boroughs.includes("Bronx"));
  assert.ok(bp.derivation?.methods?.includes("agency_service_area"));

  const cd = placeFromDerivations({
    short_title: "Floor tile in apartments located in Manhattan Neighborhood (MN04)",
    agency_name: "Housing Authority",
  }, { forLens: "money" });
  assert.equal(cd.scope, "local");
  assert.ok(cd.boroughs.includes("Manhattan"));
  assert.ok(
    (cd.community_districts || []).includes("M04")
      || (cd.derivation?.methods || []).includes("community_board")
      || (cd.derivation?.methods || []).includes("matter_title_place"),
  );
});

test("money does not pin from vendor_name alone (org HQ ≠ service geography)", () => {
  const place = placeFromDerivations({
    short_title: "Citywide pest management services",
    agency_name: "Citywide Administrative Services",
    vendor_name: "Queens Community House Inc",
  }, { forLens: "money" });
  // Citywide in title wins; must not prefer Queens from vendor org name.
  assert.equal(place.scope, "citywide");
  assert.ok(!place.boroughs?.includes("Queens") || place.scope === "citywide");
});

test("unlocated virtual-only meeting records reason", () => {
  const row = {
    request_id: "virtual-1",
    agency_name: "Housing Authority",
    short_title: "NYCHA Board Meeting",
    additional_description_1: "This meeting will be held via Zoom only. Join at https://zoom.us/j/example",
  };
  const place = meetingPlaceFromRow(row);
  // May still get agency HQ weak pin for Housing Authority (not in HQ table) → unlocated
  if (place.scope === "unlocated") {
    assert.ok(
      place.unlocated_reason === "virtual_only" || place.unlocated_reason === "no_place_signal",
    );
  }
  const { unlocated_reason } = deriveLocationCandidates(row);
  assert.ok(unlocated_reason === "virtual_only" || unlocated_reason === "no_place_signal");
});

test("committed district_activity advances located rates and records methods", () => {
  const path = new URL("../site/data/district_activity.json", import.meta.url);
  assert.ok(existsSync(path), "run: node tools/build_district_activity.mjs");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(doc.built_at);
  assert.ok((doc.sources?.meetings?.located || 0) >= 50,
    `meetings located should reflect human derivation, got ${doc.sources?.meetings?.located}`);
  assert.ok((doc.sources?.rules?.located || 0) >= 1);
  assert.ok((doc.sources?.money?.located || 0) >= 1,
    `money located should use vendor_address / citywide phrase, got ${doc.sources?.money?.located}`);
  assert.ok(doc.unlocated_reasons?.meetings);
  assert.ok(doc.sources.meetings.by_method);
});

test("buildDistrictActivity emits unlocated_reasons and by_method", () => {
  const activity = buildDistrictActivity({
    boundaries,
    meetingsRows: [
      {
        request_id: "m1",
        agency_name: "City Planning Commission",
        short_title: "CPC Public Hearing",
        street_address_1: "120 Broadway",
        city: "New York",
      },
      {
        request_id: "m2",
        agency_name: "Mystery Board",
        short_title: "Untitled meeting",
      },
    ],
    moneyRows: [
      {
        request_id: "20260723031",
        agency_name: "Health",
        short_title: "Catering",
        vendor_address: "1880 Valentine Avenue",
      },
    ],
  });
  assert.ok(activity.sources.meetings.located >= 1);
  assert.ok(activity.unlocated.meetings >= 1);
  assert.ok(Object.keys(activity.unlocated_reasons.meetings).length >= 1);
  assert.ok(activity.sources.money.located >= 1);
  assert.ok(Object.keys(activity.sources.meetings.by_method).length >= 1);
});
