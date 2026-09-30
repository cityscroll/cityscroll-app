/**
 * Exact address-resolution cache: reuse one PAD parcel outcome per normalized
 * key, retain published wording beside alternate parcel labels, and leave
 * ambiguous / empty inputs without a guessed BBL.
 *
 * Named positive BBLs and the MapPLUTO alternate label are publisher values
 * (PAD address-index + MapPLUTO FeatureServer Address attribute), never
 * verdict or fabricated geography.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LOCATION_ROLES,
  buildLocationAssertion,
} from "../site/meeting_location_assertions.mjs";
import {
  parseAddressQuery,
  resolveAddressFromShard,
} from "../site/precomputed_address_geocoder.mjs";
import {
  lookupParcelMemberships,
} from "../site/parcel_geography.mjs";
import {
  RECORD_ADDRESS_RESOLUTION_CACHE_SCHEMA,
  RECORD_ADDRESS_RESOLUTION_ENTRY_SCHEMA,
  addressTextFromAssertion,
  createRecordAddressResolutionCache,
  linkAssertionToResolution,
  materializeRecordAddressResolutionCache,
  normalizedAddressCacheKey,
  padContentIdentity,
} from "../site/record_address_resolution_cache.mjs";

const fixture = (name) => readFileSync(
  new URL(`./fixtures/record_address_resolution_cache/${name}`, import.meta.url),
  "utf8",
);
const fixtureJson = (name) => JSON.parse(fixture(name));

/** Official MapPLUTO Address attribute for BBL 3050700035 (FeatureServer query). */
const MAPPLUTO_LABEL_3050700035 = "901 CHURCH AVENUE";

/**
 * Four Brooklyn addresses from the workstream anchors, with the exact PAD BBLs
 * published in the committed address-index under PAD 26b.
 */
const BROOKLYN_NAMED = [
  {
    address: "810 East 16th Street, Brooklyn, NY 11230",
    street_address: "810 East 16th Street",
    postal_code: "11230",
    bbl: "3066990010",
    role: LOCATION_ROLES.VENUE,
    meeting_id: "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/",
  },
  {
    address: "1625 Ocean Avenue, Brooklyn, NY 11230",
    street_address: "1625 Ocean Avenue",
    postal_code: "11230",
    bbl: "3076200025",
    role: LOCATION_ROLES.VENUE,
    meeting_id: "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/",
  },
  {
    address: "461 Coney Island Avenue, Brooklyn, NY 11218",
    street_address: "461 Coney Island Avenue",
    postal_code: "11218",
    bbl: "3050700035",
    role: LOCATION_ROLES.SUBJECT_PROPERTY,
    meeting_id: "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/",
  },
  {
    address: "3218 Emmons Avenue, Brooklyn, NY 11235",
    street_address: "3218 Emmons Avenue",
    postal_code: "11235",
    bbl: "3088150590",
    role: LOCATION_ROLES.VENUE,
    meeting_id: "meeting:example:emmons-reuse",
  },
];

function loadPadFixture() {
  const manifest = fixtureJson("pad-manifest.json");
  const shard = fixtureJson("pad-street-subsets.json");
  const loadShard = () => shard;
  return { manifest, shard, loadShard };
}

function assertionFor(row) {
  return buildLocationAssertion({
    meeting_id: row.meeting_id,
    role: row.role,
    original_address: row.address,
    components: {
      street_address: row.street_address,
      address_locality: "Brooklyn",
      address_region: "NY",
      postal_code: row.postal_code,
    },
    source_field: row.role === LOCATION_ROLES.SUBJECT_PROPERTY
      ? "description.cannabis_application"
      : "location.address",
    mode: "in-person",
  });
}

test("pad content identity and cache key include borough, ZIP, and PAD digest", () => {
  const { manifest } = loadPadFixture();
  const identity = padContentIdentity(manifest);
  assert.equal(identity, `26b|${manifest.source.sha256}`);
  const query = parseAddressQuery("810 East 16th Street, Brooklyn, NY 11230");
  const key = normalizedAddressCacheKey(query, identity);
  assert.equal(key, ["810", "E 16 ST", "3", "11230", identity].join("\u001f"));
  assert.equal(normalizedAddressCacheKey({ status: "not_full_address" }, identity), null);
});

test("A1 four Brooklyn addresses resolve to their PAD BBLs and share one resolution per key", () => {
  const { manifest, loadShard } = loadPadFixture();
  let resolveCalls = 0;
  const resolveFn = (query, shard, indexManifest) => {
    resolveCalls += 1;
    return resolveAddressFromShard(query, shard, indexManifest);
  };

  const cache = createRecordAddressResolutionCache({ manifest, loadShard, resolveFn });
  const firstPassInputs = BROOKLYN_NAMED.map((row) => ({
    assertion: assertionFor(row),
    address: row.address,
  }));
  // Second occurrence of 810 East 16th under a distinct meeting identity.
  firstPassInputs.push({
    assertion: buildLocationAssertion({
      meeting_id: "meeting:community_board:repeat-810-east-16",
      role: LOCATION_ROLES.VENUE,
      original_address: "810 East 16th Street, Brooklyn, NY 11230",
      components: {
        street_address: "810 East 16th Street",
        address_locality: "Brooklyn",
        address_region: "NY",
        postal_code: "11230",
      },
      source_field: "location.address",
      mode: "in-person",
    }),
    address: "810 East 16th Street, Brooklyn, NY 11230",
  });

  const document = cache.materialize(firstPassInputs);
  assert.equal(document.schema, RECORD_ADDRESS_RESOLUTION_CACHE_SCHEMA);
  assert.equal(document.entry_count, 4);
  assert.equal(resolveCalls, 4);

  const bbls = document.results.slice(0, 4).map((entry) => entry.bbl);
  assert.deepEqual(bbls, [
    "3066990010",
    "3076200025",
    "3050700035",
    "3088150590",
  ]);
  for (const entry of document.results.slice(0, 4)) {
    assert.equal(entry.schema, RECORD_ADDRESS_RESOLUTION_ENTRY_SCHEMA);
    assert.equal(entry.status, "matched");
    assert.equal(entry.candidate_count, 1);
    assert.equal(entry.source_version, "26b");
  }

  // Repeated 810 East 16th reused the same cache entry (no fifth resolve).
  assert.equal(document.results[4].bbl, "3066990010");
  assert.equal(document.results[4].cache_key, document.results[0].cache_key);
  assert.equal(resolveCalls, 4);

  const links = cache.assertionLinks();
  assert.equal(links.length, 5);
  const eightTenLinks = links.filter((link) => link.bbl === "3066990010");
  assert.equal(eightTenLinks.length, 2);
  assert.equal(
    eightTenLinks[0].meeting_id,
    BROOKLYN_NAMED[0].meeting_id,
  );
  assert.equal(eightTenLinks[1].meeting_id, "meeting:community_board:repeat-810-east-16");
  assert.equal(eightTenLinks[0].published_address, BROOKLYN_NAMED[0].address);
  assert.equal(eightTenLinks[1].published_address, "810 East 16th Street, Brooklyn, NY 11230");
  assert.notEqual(eightTenLinks[0].assertion_id, eightTenLinks[1].assertion_id);
});

test("named-building venue wording resolves through one extracted span; subjects never do", () => {
  const { manifest, loadShard } = loadPadFixture();
  let resolveCalls = 0;
  const resolveFn = (query, shard, indexManifest) => {
    resolveCalls += 1;
    return resolveAddressFromShard(query, shard, indexManifest);
  };
  const cache = createRecordAddressResolutionCache({ manifest, loadShard, resolveFn });

  // Frozen CB15 September 29 venue wording: building-name prefix and trailing
  // room kept the full line from parsing as a leading-house-number address.
  const kingsboroughAddress =
    "Kingsborough Community College, 2001 Oriental Boulevard, Room U112 Faculty Dining Room, Brooklyn, NY 11235";
  const venueAssertion = buildLocationAssertion({
    meeting_id: "meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person",
    role: LOCATION_ROLES.VENUE,
    original_address: kingsboroughAddress,
    source_field: "venue.address",
    mode: "in-person",
  });

  // Positive control: the raw full line alone is not a full address, so
  // removing the extraction path breaks the positive resolution below.
  const direct = cache.resolveAddress(kingsboroughAddress);
  assert.equal(direct.status, "unknown");
  assert.equal(direct.reason, "not_full_address");
  assert.equal(direct.bbl, null);

  const entry = cache.resolveAddress(null, { assertion: venueAssertion });
  assert.equal(entry.status, "matched");
  assert.equal(entry.bbl, "3087600060");
  assert.equal(entry.extracted_span, "2001 Oriental Boulevard");
  assert.deepEqual(entry.normalized, {
    house: "2001",
    street: "ORIENTAL BLVD",
    borough_code: "3",
    zip: "11235",
    locality: null,
  });
  assert.equal(resolveCalls, 1);

  // The June 30 replay with identical wording shares the exact normalized
  // cache entry but keeps its own assertion provenance.
  const juneAssertion = buildLocationAssertion({
    meeting_id: "meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-06-30:general-board-meeting-in-person",
    role: LOCATION_ROLES.VENUE,
    original_address: kingsboroughAddress,
    source_field: "venue.address",
    mode: "in-person",
  });
  const juneEntry = cache.resolveAddress(null, { assertion: juneAssertion });
  assert.equal(juneEntry.bbl, "3087600060");
  assert.equal(juneEntry.cache_key, entry.cache_key);
  assert.equal(resolveCalls, 1);

  const links = cache.assertionLinks().filter((link) => link.bbl === "3087600060");
  assert.equal(links.length, 2);
  assert.notEqual(links[0].assertion_id, links[1].assertion_id);
  assert.notEqual(links[0].meeting_id, links[1].meeting_id);
  for (const link of links) {
    assert.equal(link.published_address, kingsboroughAddress);
    assert.equal(link.role, LOCATION_ROLES.VENUE);
    assert.equal(link.extracted_span, "2001 Oriental Boulevard");
  }

  // A subject-property assertion with the same wording never takes the venue
  // span path: a subject edge is never rewritten as a venue.
  const subjectAssertion = buildLocationAssertion({
    meeting_id: "meeting:community_board:example:kingsborough-as-subject",
    role: LOCATION_ROLES.SUBJECT_PROPERTY,
    original_address: kingsboroughAddress,
    source_field: "description.cannabis_application",
  });
  const subjectEntry = cache.resolveAddress(null, { assertion: subjectAssertion });
  assert.equal(subjectEntry.status, "unknown");
  assert.equal(subjectEntry.reason, "not_full_address");
  assert.equal(subjectEntry.bbl, null);
  assert.equal(subjectEntry.extracted_span, null);

  // An extracted span PAD does not cover stays a typed unresolved result —
  // never a fuzzy alias onto another street name.
  const legistarAssertion = buildLocationAssertion({
    meeting_id: "meeting:nyc_legistar_events:22627",
    role: LOCATION_ROLES.VENUE,
    original_address:
      "The New York Public Library at 515 Malcolm X Boulevard, New York, NY 10037 (135th Street and Malcolm X Boulevard)",
    source_field: "venue.address",
    mode: "in-person",
  });
  const legistarEntry = cache.resolveAddress(null, { assertion: legistarAssertion });
  assert.equal(legistarEntry.status, "unknown");
  assert.equal(legistarEntry.reason, "not_covered");
  assert.equal(legistarEntry.bbl, null);
  assert.equal(legistarEntry.extracted_span, "515 Malcolm X Boulevard");

  // Intersection-only, dropdown-placeholder, and competing-span venues never
  // invent a span or a BBL.
  for (const wording of [
    "135th Street and Malcolm X Boulevard",
    "Address Not Listed In The Dropdown",
    "VFW Hall, 461 and 463 Coney Island Avenue, Brooklyn, NY 11218",
    "461 Coney Island Avenue and 1625 Ocean Avenue, Brooklyn, NY 11218",
  ]) {
    const assertion = buildLocationAssertion({
      meeting_id: `meeting:example:negative:${wording.length}`,
      role: LOCATION_ROLES.VENUE,
      original_address: wording,
      source_field: "venue.address",
      mode: "in-person",
    });
    const negative = cache.resolveAddress(null, { assertion });
    assert.equal(negative.bbl, null, `expected no BBL for ${JSON.stringify(wording)}`);
    assert.equal(negative.status, "unknown");
    assert.equal(negative.extracted_span, null);
  }
});

test("A2 published 461 Coney Island Avenue is retained beside the MapPLUTO 901 Church Avenue label", () => {
  const { manifest, loadShard } = loadPadFixture();
  const row = BROOKLYN_NAMED[2];
  const assertion = assertionFor(row);
  assert.equal(assertion.components.street_address, "461 Coney Island Avenue");
  assert.equal(assertion.role, LOCATION_ROLES.SUBJECT_PROPERTY);
  assert.equal(assertion.original_address, row.address);

  const { cache, document } = materializeRecordAddressResolutionCache({
    manifest,
    loadShard,
    inputs: [{
      assertion,
      address: row.address,
      parcel_source_label: MAPPLUTO_LABEL_3050700035,
    }],
  });

  assert.equal(document.results[0].bbl, "3050700035");
  assert.equal(document.results[0].status, "matched");

  const link = cache.assertionLinks()[0];
  assert.equal(link.published_address, row.address);
  assert.equal(link.parcel_source_label, MAPPLUTO_LABEL_3050700035);
  assert.equal(link.published_address_preserved, true);
  assert.notEqual(link.published_address.toUpperCase(), MAPPLUTO_LABEL_3050700035);
  // Re-link helper alone also preserves wording.
  const relinked = linkAssertionToResolution(assertion, document.results[0], {
    parcel_source_label: MAPPLUTO_LABEL_3050700035,
  });
  assert.equal(relinked.published_address, row.address);
  assert.match(addressTextFromAssertion(assertion), /461 Coney Island Avenue/);
});

test("A3 bare 250 Broadway stays ambiguous; contradictory locality and empty inputs create no BBL", () => {
  const { manifest, shard, loadShard } = loadPadFixture();
  const cache = createRecordAddressResolutionCache({ manifest, loadShard });

  const ambiguous = cache.resolveAddress("250 Broadway");
  assert.equal(ambiguous.status, "unknown");
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.candidate_count, 2);
  assert.equal(ambiguous.bbl, null);

  // Direct PAD replay of the same fixture streets confirms two candidates.
  const query = parseAddressQuery("250 Broadway");
  const raw = resolveAddressFromShard(query, shard, manifest);
  assert.equal(raw.reason, "ambiguous");
  assert.equal(raw.candidate_count, 2);

  // Contradictory explicit locality (Brooklyn borough + Manhattan ZIP) must
  // not silently choose either candidate, and must not erase the known
  // ambiguity into an ordinary miss.
  const contradictory = cache.resolveAddress("250 Broadway, Brooklyn, NY 10007");
  assert.equal(contradictory.status, "unknown");
  assert.equal(contradictory.bbl, null);
  assert.equal(contradictory.reason, "contradictory_locality");
  assert.equal(contradictory.candidate_count, 2);

  for (const bad of [null, "", "   ", "October 20, 2026", "via Video Conference", "affordable housing"]) {
    const entry = cache.resolveAddress(bad);
    assert.equal(entry.bbl, null, `expected no BBL for ${JSON.stringify(bad)}`);
    assert.equal(entry.status, "unknown");
    assert.ok(
      entry.reason === "not_full_address" || entry.reason === "empty_or_malformed" || entry.reason === "not_covered",
      `unexpected reason ${entry.reason} for ${JSON.stringify(bad)}`,
    );
  }
});

test("A4 materializer reuses resolutions under one PAD identity and invalidates when identity changes", () => {
  const { manifest, loadShard } = loadPadFixture();
  let resolveCalls = 0;
  const resolveFn = (query, shard, indexManifest) => {
    resolveCalls += 1;
    return resolveAddressFromShard(query, shard, indexManifest);
  };
  const cache = createRecordAddressResolutionCache({ manifest, loadShard, resolveFn });
  const inputs = BROOKLYN_NAMED.map((row) => row.address);

  const first = cache.materialize(inputs);
  assert.equal(first.resolve_calls, 4);
  assert.equal(resolveCalls, 4);
  assert.equal(first.entry_count, 4);
  assert.equal(first.pad_content_identity, padContentIdentity(manifest));

  // Unchanged PAD identity: replay adds zero extra resolver calls.
  const second = cache.materialize(inputs);
  assert.equal(resolveCalls, 4);
  assert.equal(second.resolve_calls, 4);
  assert.equal(second.entry_count, 4);
  assert.deepEqual(
    second.results.map((row) => row.bbl),
    BROOKLYN_NAMED.map((row) => row.bbl),
  );

  // Same production function with a changed PAD content identity invalidates.
  const nextManifest = {
    ...manifest,
    source: {
      ...manifest.source,
      version: "26c-fixture",
      sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
  };
  const third = cache.materialize(inputs, { manifest: nextManifest });
  assert.equal(third.pad_content_identity, padContentIdentity(nextManifest));
  assert.notEqual(third.pad_content_identity, padContentIdentity(manifest));
  assert.equal(resolveCalls, 8);
  assert.equal(third.resolve_calls, 8);
  assert.equal(third.entry_count, 4);
  assert.deepEqual(
    third.results.map((row) => row.bbl),
    BROOKLYN_NAMED.map((row) => row.bbl),
  );

  // Alias identity after exact resolution: two cache keys may share one BBL
  // only through exact matches, never fuzzy text.
  const coneyKey = third.results[2].cache_key;
  assert.deepEqual(cache.entriesForBbl("3050700035"), [coneyKey]);
});

test("locality and unit suffixes leave a usable street key through PAD and parcel shards", () => {
  const { manifest, shard, loadShard } = loadPadFixture();
  const parcelShard = fixtureJson("parcel-membership-subsets.json");
  const cache = createRecordAddressResolutionCache({ manifest, loadShard });

  const forestHillsAddress =
    "104-01 Metropolitan Ave, Forest Hills, NY 11375, USA";
  const forestHillsId =
    "meeting:community_board:0pue8uab456hejvloi8sikfpke@google.com::2026-09-08";
  const worthAddress =
    "125 Worth Street, 2nd Floor Auditorium, New York, NY, 10013";
  const worthId = "meeting:city_record:20260106034";

  // Mutation control: the pre-fix contaminated street keys cannot hit PAD.
  const contaminatedForest = {
    house: "104-01",
    house_sort: 100104001,
    street: "METROPOLITAN AVE FOREST HILLS NY USA",
    borough_code: null,
    zip: "11375",
  };
  assert.equal(
    resolveAddressFromShard(contaminatedForest, shard, manifest).reason,
    "not_covered",
  );
  const contaminatedWorth = {
    house: "125",
    house_sort: 125000,
    street: "WORTH ST 2",
    borough_code: "1",
    zip: "10013",
  };
  assert.equal(
    resolveAddressFromShard(contaminatedWorth, shard, manifest).reason,
    "not_covered",
  );

  // A1: Forest Hills / USA suffix separates from the street; exact PAD BBL
  // and parcel Q06 / QN0602 produce venue membership inputs.
  const forestQuery = parseAddressQuery(forestHillsAddress);
  assert.equal(forestQuery.street, "METROPOLITAN AVE");
  assert.equal(forestQuery.zip, "11375");
  assert.equal(forestQuery.locality, "FOREST HILLS");
  assert.equal(forestQuery.locality_conflict, undefined);

  const forestAssertion = buildLocationAssertion({
    meeting_id: forestHillsId,
    role: LOCATION_ROLES.VENUE,
    original_address: forestHillsAddress,
    source_field: "venue.address",
    mode: "in-person",
  });
  assert.equal(forestAssertion.validity, "admitted_physical_venue");
  const forestEntry = cache.resolveAddress(null, { assertion: forestAssertion });
  assert.equal(forestEntry.status, "matched");
  assert.equal(forestEntry.bbl, "4032400041");
  assert.equal(forestEntry.normalized.street, "METROPOLITAN AVE");
  assert.equal(forestEntry.normalized.locality, "FOREST HILLS");
  const forestKey = normalizedAddressCacheKey(forestQuery, padContentIdentity(manifest));
  assert.equal(forestEntry.cache_key, forestKey);

  const forestParcel = lookupParcelMemberships(parcelShard, forestEntry.bbl);
  assert.ok(forestParcel);
  assert.equal(forestParcel.memberships.nta2020.ids[0], "QN0602");
  assert.equal(forestParcel.memberships.community_district.ids[0], "Q06");

  // A2: City Record second-floor auditorium is a floor, not a second house.
  const worthQuery = parseAddressQuery(worthAddress);
  assert.equal(worthQuery.street, "WORTH ST");
  assert.equal(worthQuery.house, "125");
  assert.equal(worthQuery.borough_code, "1");
  assert.equal(worthQuery.zip, "10013");
  assert.equal(worthQuery.locality, null);

  const worthAssertion = buildLocationAssertion({
    meeting_id: worthId,
    role: LOCATION_ROLES.VENUE,
    original_address: worthAddress,
    source_field: "venue.address",
    mode: "in-person",
  });
  assert.equal(worthAssertion.validity, "admitted_physical_venue");
  const worthEntry = cache.resolveAddress(null, { assertion: worthAssertion });
  assert.equal(worthEntry.status, "matched");
  assert.equal(worthEntry.bbl, "1001680032");
  assert.equal(worthEntry.normalized.street, "WORTH ST");
  const worthParcel = lookupParcelMemberships(parcelShard, worthEntry.bbl);
  assert.ok(worthParcel);
  assert.equal(worthParcel.memberships.nta2020.ids[0], "MN0102");
  assert.equal(worthParcel.memberships.community_district.ids[0], "M01");

  // A3: contradictory Flushing locality, unsupported ZIP, intersection-only,
  // and multiple parcel hits stay unresolved — never drop conflict text.
  const flushing = cache.resolveAddress(
    "104-01 Metropolitan Ave, Flushing, NY 11375, USA",
  );
  assert.equal(flushing.status, "unknown");
  assert.equal(flushing.reason, "contradictory_locality");
  assert.equal(flushing.bbl, null);
  // Dropping Flushing would still yield the Forest Hills BBL — prove that.
  const dropped = resolveAddressFromShard(
    parseAddressQuery("104-01 Metropolitan Ave, NY 11375, USA"),
    shard,
    manifest,
  );
  assert.equal(dropped.status, "matched");
  assert.equal(dropped.bbl, "4032400041");

  const badZip = cache.resolveAddress(
    "104-01 Metropolitan Ave, Forest Hills, NY 90210, USA",
  );
  assert.equal(badZip.status, "unknown");
  assert.equal(badZip.reason, "unsupported_zip");
  assert.equal(badZip.bbl, null);

  const intersection = cache.resolveAddress("135th Street and Malcolm X Boulevard");
  assert.equal(intersection.status, "unknown");
  assert.equal(intersection.bbl, null);
  assert.ok(
    intersection.reason === "not_full_address" || intersection.reason === "empty_or_malformed",
  );

  const ambiguous = cache.resolveAddress("250 Broadway");
  assert.equal(ambiguous.status, "unknown");
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.candidate_count, 2);
  assert.equal(ambiguous.bbl, null);

  // A5: already-clean Brooklyn rows keep their prior cache keys / BBLs
  // (role and ID sets unchanged for the frozen physical-venue positives).
  for (const row of BROOKLYN_NAMED) {
    const entry = cache.resolveAddress(row.address);
    assert.equal(entry.status, "matched");
    assert.equal(entry.bbl, row.bbl);
  }
});
