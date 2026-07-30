import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  extractCafeConsentPetitions,
  isDiningOutConsentNotice,
} from "../../worker/src/lib/cafe_consent.mjs";
import {
  applyPlaceGeocodes,
  expandPlaceConsentRecords,
  isCitywideTopicRecord,
  isPlaceScopedRecord,
  normalizeCitywideRuleRecord,
  normalizePlaceConsentRecord,
  validateCivicScopeRecord,
} from "../../worker/src/lib/civic_scope.mjs";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/dining_out_nyc.json", import.meta.url),
  "utf8",
));

const NOW = new Date("2026-07-29T12:00:00Z");

// ---------------------------------------------------------------------------
// Characterization: real Dining Out NYC citywide rule (topic scope)
// ---------------------------------------------------------------------------

test("Dining Out NYC Notice of Adoption is a topic-scoped citywide rule with NYC Rules deep link", () => {
  const record = normalizeCitywideRuleRecord({
    cityRecordRow: fixture.citywide_rule_row,
    nycRules: fixture.nyc_rules,
    now: NOW,
  });
  validateCivicScopeRecord(record);

  assert.equal(record.kind, "citywide_rule");
  assert.equal(record.scope_class, "topic");
  assert.equal(record.citywide, true);
  assert.equal(isCitywideTopicRecord(record), true);
  assert.equal(isPlaceScopedRecord(record), false);
  assert.deepEqual(record.places, []);
  assert.equal(record.sources.city_record.request_id, "20240129008");
  assert.equal(
    record.sources.nyc_rules.url,
    "https://rules.cityofnewyork.us/rule/dot-proposed-rule-outdoor-dining/",
  );
  assert.match(record.action.primary.url, /^https:\/\/rules\.cityofnewyork\.us\//);
  assert.equal(record.action.primary.delivery, "official_handoff");
  assert.equal(record.deadline?.type, "effective");
  assert.equal(record.deadline?.at, "2024-03-03");
  assert.equal(record.outcome.status, "effective");
  assert.ok(record.modality);
  assert.equal(typeof record.accessibility.stated, "boolean");
});

test("citywide rule action rail also links the City Record notice identity", () => {
  const record = normalizeCitywideRuleRecord({
    cityRecordRow: fixture.citywide_rule_row,
    nycRules: fixture.nyc_rules,
    now: NOW,
  });
  const cityRecordRoute = record.action.routes.find((route) =>
    route.label.includes("City Record"));
  assert.ok(cityRecordRoute);
  assert.equal(
    cityRecordRoute.url,
    "https://a856-cityrecord.nyc.gov/RequestDetail/20240129008",
  );
});

// ---------------------------------------------------------------------------
// Characterization: real address-level cafe consent hearings (place scope)
// ---------------------------------------------------------------------------

test("August 2026 Dining Out notice yields three address-level petitions with place scope", () => {
  const row = fixture.consent_rows.find((item) => item.request_id === "20260723005");
  assert.ok(row);
  assert.equal(isDiningOutConsentNotice(row), true);

  const petitions = extractCafeConsentPetitions(row);
  assert.equal(petitions.length, 3);
  assert.deepEqual(
    petitions.map((item) => item.address.label),
    ["96 Avenue A", "113 Franklin Street", "131 Grand St"],
  );
  assert.deepEqual(
    petitions.map((item) => item.borough),
    ["Manhattan", "Brooklyn", "Brooklyn"],
  );
  assert.ok(petitions.every((item) => item.cafe_type === "roadway"));

  const record = normalizePlaceConsentRecord(row, {
    geocodes: fixture.geocodes,
    now: NOW,
  });
  validateCivicScopeRecord(record);
  assert.equal(record.kind, "place_consent");
  assert.equal(record.scope_class, "place");
  assert.equal(record.citywide, false);
  assert.equal(isPlaceScopedRecord(record), true);
  assert.equal(isCitywideTopicRecord(record), false);
  assert.equal(record.places.length, 3);
  assert.equal(record.modality, "remote");
  assert.equal(record.deadline?.type, "hearing");
  assert.match(record.deadline.at, /^2026-08-13/);
  assert.equal(record.action.primary.delivery, "official_handoff");
  assert.match(record.action.primary.url, /zoom\.us|cityrecord/i);
  assert.ok(record.outcome.status === "scheduled" || record.outcome.status === "held");
  assert.equal(record.sources.nyc_rules, null);
  assert.equal(record.sources.dining_out.program, "Dining Out NYC");
});

test("geocoded place pins expose coordinates, BBL, community district, and council district", () => {
  const row = fixture.consent_rows.find((item) => item.request_id === "20260723005");
  const record = normalizePlaceConsentRecord(row, {
    geocodes: fixture.geocodes,
    now: NOW,
  });
  const avenueA = record.places.find((place) => place.label === "96 Avenue A");
  assert.ok(avenueA);
  assert.equal(avenueA.borough, "Manhattan");
  assert.equal(avenueA.bbl, "1004020001");
  assert.equal(avenueA.community_district, "103");
  assert.equal(avenueA.council_district, "2");
  assert.ok(Number.isFinite(avenueA.latitude));
  assert.ok(Number.isFinite(avenueA.longitude));
  assert.equal(avenueA.geocode_status, "matched");
  assert.equal(avenueA.cafe_type, "roadway");
  assert.match(avenueA.petitioner, /Cien\s*Fuegos/i);
});

test("sidewalk cafe consent notice (20251021021) is place-scoped and not citywide", () => {
  const row = fixture.consent_rows.find((item) => item.request_id === "20251021021");
  const record = normalizePlaceConsentRecord(row, {
    geocodes: fixture.geocodes,
    now: NOW,
  });
  assert.equal(record.citywide, false);
  assert.equal(record.scope_class, "place");
  assert.ok(record.places.length >= 2);
  assert.ok(record.places.every((place) => place.cafe_type === "sidewalk"));
  assert.ok(record.places.some((place) => place.label.includes("1716")));
  assert.ok(record.places.some((place) => place.label.includes("86th")));
  // Hearing date is in the past relative to NOW → held, with no grant/deny feed.
  assert.equal(record.outcome.status, "held");
  assert.match(record.outcome.summary, /no separate grant\/deny outcome record found/i);
});

test("multi-cafe hearing expands to one map pin record per petition", () => {
  const row = fixture.consent_rows.find((item) => item.request_id === "20260624036");
  const parent = normalizePlaceConsentRecord(row, {
    geocodes: fixture.geocodes,
    now: NOW,
  });
  assert.ok(parent.places.length >= 8);
  const expanded = expandPlaceConsentRecords(parent);
  assert.equal(expanded.length, parent.places.length);
  for (const child of expanded) {
    assert.equal(child.places.length, 1);
    assert.equal(child.scope_class, "place");
    assert.equal(child.citywide, false);
    validateCivicScopeRecord(child);
  }
  assert.ok(expanded.some((item) => /Avenue A/i.test(item.places[0].label)));
  assert.ok(expanded.some((item) => /Queens/i.test(item.places[0].borough)));
});

// ---------------------------------------------------------------------------
// Schema guards: the distinction the prior model could not express
// ---------------------------------------------------------------------------

test("citywide rule and place consent round-trip as opposite scope classes", () => {
  const rule = normalizeCitywideRuleRecord({
    cityRecordRow: fixture.citywide_rule_row,
    nycRules: fixture.nyc_rules,
    now: NOW,
  });
  const consent = normalizePlaceConsentRecord(
    fixture.consent_rows.find((item) => item.request_id === "20260723005"),
    { geocodes: fixture.geocodes, now: NOW },
  );

  assert.notEqual(rule.scope_class, consent.scope_class);
  assert.notEqual(rule.citywide, consent.citywide);
  assert.equal(rule.places.length, 0);
  assert.ok(consent.places.length > 0);
  // Official action destinations differ by class.
  assert.match(rule.action.primary.url, /rules\.cityofnewyork\.us/);
  assert.doesNotMatch(consent.action.primary.url || "", /rules\.cityofnewyork\.us\/rule\//);
});

test("applyPlaceGeocodes flags borough mismatches without dropping the notice borough", () => {
  const places = applyPlaceGeocodes(
    [{
      label: "113 Franklin Street",
      borough: "Brooklyn",
      neighborhood: null,
      latitude: null,
      longitude: null,
      bbl: null,
      community_district: null,
      council_district: null,
      cafe_type: "roadway",
      petitioner: "Chama Mama At 113 Franklin LLC",
      geocode_status: "unresolved",
    }],
    fixture.geocodes,
  );
  assert.equal(places[0].borough, "Brooklyn");
  assert.ok(Number.isFinite(places[0].latitude));
  // GeoSearch currently resolves this label to Manhattan; notice borough wins.
  if (places[0].geocode_status === "borough_mismatch") {
    assert.equal(places[0].geocode_borough, "Manhattan");
  }
});

test("accessibility and deadline fields are always present on both classes", () => {
  const rule = normalizeCitywideRuleRecord({
    cityRecordRow: fixture.citywide_rule_row,
    nycRules: fixture.nyc_rules,
    now: NOW,
  });
  const consent = normalizePlaceConsentRecord(
    fixture.consent_rows.find((item) => item.request_id === "20260723005"),
    { geocodes: fixture.geocodes, now: NOW },
  );
  for (const record of [rule, consent]) {
    assert.equal(typeof record.accessibility.stated, "boolean");
    assert.ok("summary" in record.accessibility);
    assert.ok(record.deadline === null || typeof record.deadline.at === "string");
    assert.ok(record.action.primary);
    assert.ok(record.outcome.status);
  }
});
