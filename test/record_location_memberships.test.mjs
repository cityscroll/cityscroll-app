/**
 * Record-location membership projection: attach cached parcel memberships to
 * each record's distinct locations while keeping venue vs subject roles and
 * distinct reverse record IDs.
 *
 * Named positive BBLs and geography answers are publisher values from the
 * committed parcel-geography generation (PAD + MapPLUTO + full polygons),
 * never verdict or fabricated geography.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { civicGeographyKey } from "../site/civic_geography_registry.mjs";
import {
  LOCATION_ROLES,
  LOCATION_VALIDITY,
  buildLocationAssertion,
} from "../site/meeting_location_assertions.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_PATH,
  lookupParcelMemberships,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import {
  createRecordAddressResolutionCache,
  linkAssertionToResolution,
} from "../site/record_address_resolution_cache.mjs";
import {
  RECORD_LOCATION_EDGE_METHOD,
  RECORD_LOCATION_MEMBERSHIP_PROJECTION_SCHEMA,
  assertionSourceContentHash,
  createRecordLocationMembershipProjection,
  materializeRecordLocationMemberships,
} from "../site/record_location_memberships.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARCEL_DIR = path.join(ROOT, "site", "data", "parcel-geography");
const ADDRESS_FIXTURE_DIR = path.join(
  ROOT,
  "test",
  "fixtures",
  "record_address_resolution_cache",
);

const SEPT23_MEETING_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const SEPT14_MEETING_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";

const BBL_810 = "3066990010";
const BBL_1625 = "3076200025";
const BBL_461 = "3050700035";

const GEO_K14 = civicGeographyKey("community_district", "K14");
const GEO_MIDWOOD = civicGeographyKey("nta2020", "BK1403");
const GEO_COUNCIL_45 = civicGeographyKey("council_district", "45");
const GEO_FLATBUSH = civicGeographyKey("nta2020", "BK1402");

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadPadFixture() {
  const manifest = loadJson(path.join(ADDRESS_FIXTURE_DIR, "pad-manifest.json"));
  const shard = loadJson(path.join(ADDRESS_FIXTURE_DIR, "pad-street-subsets.json"));
  const loadShard = () => shard;
  return { manifest, shard, loadShard };
}

/** Real committed parcel shards — the foundation generation this card joins. */
function loadRealParcelShard(shardKey) {
  return loadJson(path.join(PARCEL_DIR, `${shardKey}.json`));
}

function labelFor(type, id) {
  if (type === "nta2020" && id === "BK1403") return "Midwood";
  if (type === "nta2020" && id === "BK1402") return "Flatbush (West)-Ditmas Park-Parkville";
  if (type === "community_district" && id === "K14") return "Brooklyn Community District 14";
  if (type === "council_district" && id === "45") return "City Council District 45";
  if (type === "council_district" && id === "40") return "City Council District 40";
  return null;
}

function venueAssertion({
  meetingId,
  address,
  street,
  postal,
  sourceField = "location.address",
}) {
  return buildLocationAssertion({
    meeting_id: meetingId,
    role: LOCATION_ROLES.VENUE,
    original_address: address,
    components: {
      street_address: street,
      address_locality: "Brooklyn",
      address_region: "NY",
      postal_code: postal,
    },
    source_field: sourceField,
    mode: "in-person",
  });
}

function subjectAssertion({
  meetingId,
  address,
  street,
  postal,
  sourceField = "description.cannabis_application",
  sourcePassage = null,
  passageLocator = null,
}) {
  return buildLocationAssertion({
    meeting_id: meetingId,
    role: LOCATION_ROLES.SUBJECT_PROPERTY,
    original_address: address,
    components: {
      street_address: street,
      address_locality: "Brooklyn",
      address_region: "NY",
      postal_code: postal,
    },
    source_field: sourceField,
    source_passage: sourcePassage,
    passage_locator: passageLocator,
    mode: "in-person",
  });
}

function resolveLinks(assertions) {
  const { manifest, loadShard } = loadPadFixture();
  const cache = createRecordAddressResolutionCache({ manifest, loadShard });
  const inputs = assertions.map((assertion) => ({ assertion }));
  const document = cache.materialize(inputs);
  const links = cache.assertionLinks();
  assert.equal(links.length, assertions.length);
  return assertions.map((assertion, index) => ({
    assertion,
    resolution: links[index],
    entry: document.results[index],
  }));
}

function createRealProjectionBuilder() {
  const manifest = loadJson(path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH));
  return createRecordLocationMembershipProjection({
    loadParcelShard: loadRealParcelShard,
    labelFor,
    parcelMembershipGeneration: manifest.memberships?.generation
      || manifest.coordinate_vintage
      || manifest.built_at
      || null,
  });
}

test("committed parcel memberships still answer Midwood/K14/Council 45 for 810 East 16th", () => {
  const shard = loadRealParcelShard(parcelShardKey(BBL_810));
  const bundle = lookupParcelMemberships(shard, BBL_810);
  assert.ok(bundle);
  assert.deepEqual(bundle.memberships.nta2020.ids, ["BK1403"]);
  assert.deepEqual(bundle.memberships.community_district.ids, ["K14"]);
  assert.deepEqual(bundle.memberships.council_district.ids, ["45"]);
});

test("A1 September 23 venue assertion joins parcel 3066990010 with Midwood/K14/Council 45 and inspectable source path", () => {
  const assertion = venueAssertion({
    meetingId: SEPT23_MEETING_ID,
    address: "810 East 16th Street, Brooklyn, NY 11230",
    street: "810 East 16th Street",
    postal: "11230",
  });
  assert.equal(assertion.validity, LOCATION_VALIDITY.ADMITTED_PHYSICAL);
  assert.equal(assertion.source_field, "location.address");

  const [{ resolution }] = resolveLinks([assertion]);
  assert.equal(resolution.bbl, BBL_810);
  assert.equal(resolution.status, "matched");

  const builder = createRealProjectionBuilder();
  const document = builder.project([{ assertion, resolution }], {
    observedAt: "2026-09-23T12:00:00.000Z",
  });

  assert.equal(document.schema, RECORD_LOCATION_MEMBERSHIP_PROJECTION_SCHEMA);
  assert.equal(document.active_assertion_count, 1);
  assert.ok(document.edge_count >= 3);

  const venueEdges = document.edges.filter((edge) => edge.role === LOCATION_ROLES.VENUE);
  assert.ok(venueEdges.length >= 3);
  for (const edge of venueEdges) {
    assert.equal(edge.bbl, BBL_810);
    assert.equal(edge.record_id, SEPT23_MEETING_ID);
    assert.equal(edge.assertion_id, assertion.assertion_id);
    assert.equal(edge.provenance.method, RECORD_LOCATION_EDGE_METHOD);
    assert.equal(edge.source_path?.source_field, "location.address");
    assert.equal(edge.source_path?.original_address, assertion.original_address);
    assert.equal(edge.source_path?.components?.street_address, "810 East 16th Street");
  }

  const byKey = Object.fromEntries(venueEdges.map((edge) => [edge.geography_key, edge]));
  assert.ok(byKey[GEO_MIDWOOD], "expected Midwood NTA edge");
  assert.equal(byKey[GEO_MIDWOOD].geography_id, "BK1403");
  assert.equal(byKey[GEO_MIDWOOD].geography_label, "Midwood");
  assert.ok(byKey[GEO_K14], "expected K14 community-district edge");
  assert.equal(byKey[GEO_K14].geography_id, "K14");
  assert.ok(byKey[GEO_COUNCIL_45], "expected Council 45 edge");
  assert.equal(byKey[GEO_COUNCIL_45].geography_id, "45");

  // Active assertion keeps the inspectable source path beside the join.
  const active = document.active_assertions[0];
  assert.equal(active.assertion_id, assertion.assertion_id);
  assert.equal(active.role, LOCATION_ROLES.VENUE);
  assert.equal(active.resolution.bbl, BBL_810);
  assert.equal(active.source_path.source_field, "location.address");
  assert.equal(active.source_content_hash, assertionSourceContentHash(assertion));
});

test("A2 September 14 venue and subject both retain K14 while the reverse record list is one meeting id", () => {
  const venue = venueAssertion({
    meetingId: SEPT14_MEETING_ID,
    address: "1625 Ocean Avenue, Brooklyn, NY 11230",
    street: "1625 Ocean Avenue",
    postal: "11230",
  });
  const subject = subjectAssertion({
    meetingId: SEPT14_MEETING_ID,
    address: "461 Coney Island Avenue, Brooklyn, NY 11218",
    street: "461 Coney Island Avenue",
    postal: "11218",
    sourcePassage: "cannabis application at 461 Coney Island Avenue",
    passageLocator: "description.cannabis_application",
  });

  const linked = resolveLinks([venue, subject]);
  assert.equal(linked[0].resolution.bbl, BBL_1625);
  assert.equal(linked[1].resolution.bbl, BBL_461);

  const builder = createRealProjectionBuilder();
  const document = builder.project(linked.map(({ assertion, resolution }) => ({
    assertion,
    resolution,
  })), { observedAt: "2026-09-14T18:30:00.000Z" });

  const roles = new Set(document.active_assertions.map((row) => row.role));
  assert.ok(roles.has(LOCATION_ROLES.VENUE));
  assert.ok(roles.has(LOCATION_ROLES.SUBJECT_PROPERTY));
  assert.equal(document.active_assertions.length, 2);

  const k14 = document.reverse[GEO_K14];
  assert.ok(k14, "expected K14 reverse bucket");
  assert.deepEqual(k14.record_ids, [SEPT14_MEETING_ID]);
  assert.equal(k14.record_ids.length, 1);

  const k14Roles = new Set(k14.evidence.map((edge) => edge.role));
  assert.ok(k14Roles.has(LOCATION_ROLES.VENUE));
  assert.ok(k14Roles.has(LOCATION_ROLES.SUBJECT_PROPERTY));
  assert.equal(
    k14.evidence.filter((edge) => edge.role === LOCATION_ROLES.VENUE).length,
    1,
  );
  assert.equal(
    k14.evidence.filter((edge) => edge.role === LOCATION_ROLES.SUBJECT_PROPERTY).length,
    1,
  );

  // Distinct neighborhoods still keep their own role evidence.
  assert.ok(document.reverse[GEO_MIDWOOD]?.evidence.some((edge) => edge.role === LOCATION_ROLES.VENUE));
  assert.ok(document.reverse[GEO_FLATBUSH]?.evidence.some((edge) => (
    edge.role === LOCATION_ROLES.SUBJECT_PROPERTY
  )));
  assert.equal(document.reverse[GEO_MIDWOOD].record_ids.length, 1);
  assert.equal(document.reverse[GEO_FLATBUSH].record_ids.length, 1);
});

test("A3 ambiguous address creates no parcel edge; venue removal keeps subject/host roles intact", () => {
  const builder = createRealProjectionBuilder();
  const { manifest, loadShard } = loadPadFixture();
  const cache = createRecordAddressResolutionCache({ manifest, loadShard });

  const ambiguous = buildLocationAssertion({
    meeting_id: "meeting:example:ambiguous-250-broadway",
    role: LOCATION_ROLES.VENUE,
    original_address: "250 Broadway",
    components: { street_address: "250 Broadway" },
    source_field: "location.address",
    mode: "in-person",
  });
  const ambiguousEntry = cache.resolveAddress("250 Broadway", { assertion: ambiguous });
  assert.equal(ambiguousEntry.bbl, null);
  assert.equal(ambiguousEntry.reason, "ambiguous");
  const ambiguousLink = linkAssertionToResolution(ambiguous, ambiguousEntry);

  const ambiguousDoc = builder.project([{
    assertion: ambiguous,
    resolution: ambiguousLink,
  }], { observedAt: "2026-09-24T00:00:00.000Z" });
  assert.equal(ambiguousDoc.edge_count, 0);
  assert.equal(ambiguousDoc.active_assertion_count, 1);
  assert.equal(ambiguousDoc.active_assertions[0].resolution.bbl, null);

  // Controlled record with venue + subject + host; then withdraw the venue.
  const meetingId = "meeting:example:venue-correction-sept14";
  const venue = venueAssertion({
    meetingId,
    address: "1625 Ocean Avenue, Brooklyn, NY 11230",
    street: "1625 Ocean Avenue",
    postal: "11230",
  });
  const subject = subjectAssertion({
    meetingId,
    address: "461 Coney Island Avenue, Brooklyn, NY 11218",
    street: "461 Coney Island Avenue",
    postal: "11218",
  });
  const host = buildLocationAssertion({
    meeting_id: meetingId,
    role: LOCATION_ROLES.HOST_JURISDICTION,
    original_address: null,
    source_field: "board_id",
    mode: null,
  });
  // Host validity defaults to unlocated without address evidence; force the
  // role-only relation the projection preserves separately from parcels.
  host.validity = LOCATION_VALIDITY.UNLOCATED;

  const linked = resolveLinks([venue, subject]);
  const initial = builder.project([
    { assertion: linked[0].assertion, resolution: linked[0].resolution },
    { assertion: linked[1].assertion, resolution: linked[1].resolution },
    {
      assertion: host,
      host_geography: {
        geography_type: "community_district",
        geography_id: "K14",
        geography_key: GEO_K14,
        geography_label: "Brooklyn Community District 14",
      },
    },
  ], { observedAt: "2026-09-14T18:30:00.000Z" });

  assert.ok(initial.edges.some((edge) => edge.role === LOCATION_ROLES.VENUE));
  assert.ok(initial.edges.some((edge) => edge.role === LOCATION_ROLES.SUBJECT_PROPERTY));
  assert.ok(initial.edges.some((edge) => edge.role === LOCATION_ROLES.HOST_JURISDICTION));

  const afterRemoval = builder.replaceRecordAssertions(meetingId, [
    { assertion: linked[1].assertion, resolution: linked[1].resolution },
    {
      assertion: host,
      host_geography: {
        geography_type: "community_district",
        geography_id: "K14",
        geography_key: GEO_K14,
        geography_label: "Brooklyn Community District 14",
      },
    },
  ], { observedAt: "2026-09-15T12:00:00.000Z" });

  assert.equal(
    afterRemoval.edges.filter((edge) => edge.role === LOCATION_ROLES.VENUE).length,
    0,
  );
  assert.ok(afterRemoval.edges.some((edge) => edge.role === LOCATION_ROLES.SUBJECT_PROPERTY));
  assert.ok(afterRemoval.edges.some((edge) => edge.role === LOCATION_ROLES.HOST_JURISDICTION));

  for (const edge of afterRemoval.edges) {
    assert.notEqual(edge.role, LOCATION_ROLES.VENUE);
  }
  for (const active of afterRemoval.active_assertions) {
    assert.notEqual(active.role, LOCATION_ROLES.VENUE);
    if (active.assertion_id === subject.assertion_id) {
      assert.equal(active.role, LOCATION_ROLES.SUBJECT_PROPERTY);
    }
    if (active.assertion_id === host.assertion_id) {
      assert.equal(active.role, LOCATION_ROLES.HOST_JURISDICTION);
    }
  }

  // History retains the withdrawn venue assertion as dated, inactive evidence.
  assert.ok(afterRemoval.history.some((row) => (
    row.role === LOCATION_ROLES.VENUE
    && row.active === false
    && row.superseded_at === "2026-09-15T12:00:00.000Z"
  )));
});

test("A4 real projection builder: changed-address, duplicate-alias, multiple-role, and removal sequences", () => {
  const builder = createRealProjectionBuilder();
  const meetingId = "meeting:example:projection-sequences";

  const venueOcean = venueAssertion({
    meetingId,
    address: "1625 Ocean Avenue, Brooklyn, NY 11230",
    street: "1625 Ocean Avenue",
    postal: "11230",
  });
  const venueOffice = venueAssertion({
    meetingId,
    address: "810 East 16th Street, Brooklyn, NY 11230",
    street: "810 East 16th Street",
    postal: "11230",
    sourceField: "location.address.corrected",
  });
  const subject = subjectAssertion({
    meetingId,
    address: "461 Coney Island Avenue, Brooklyn, NY 11218",
    street: "461 Coney Island Avenue",
    postal: "11218",
  });
  // Duplicate alias: same parcel BBL via a second published wording for 461.
  const subjectAlias = subjectAssertion({
    meetingId,
    address: "461 Coney Island Avenue, Brooklyn, NY 11218",
    street: "461 Coney Island Avenue",
    postal: "11218",
    sourceField: "description.alias_repeat",
  });

  const firstLinks = resolveLinks([venueOcean, subject, subjectAlias]);
  assert.equal(firstLinks[0].resolution.bbl, BBL_1625);
  assert.equal(firstLinks[1].resolution.bbl, BBL_461);
  assert.equal(firstLinks[2].resolution.bbl, BBL_461);
  assert.equal(firstLinks[1].resolution.cache_key, firstLinks[2].resolution.cache_key);
  assert.notEqual(firstLinks[1].assertion.assertion_id, firstLinks[2].assertion.assertion_id);

  const multiRole = builder.project(firstLinks.map(({ assertion, resolution }) => ({
    assertion,
    resolution,
  })), { observedAt: "2026-09-14T18:30:00.000Z" });

  // Exact reverse IDs: one meeting under K14, with full multi-role evidence.
  assert.deepEqual(multiRole.reverse[GEO_K14].record_ids, [meetingId]);
  const k14Roles = multiRole.reverse[GEO_K14].evidence.map((edge) => edge.role).sort();
  assert.ok(k14Roles.includes(LOCATION_ROLES.VENUE));
  assert.equal(
    multiRole.reverse[GEO_K14].evidence.filter((edge) => edge.role === LOCATION_ROLES.SUBJECT_PROPERTY).length,
    2,
  );
  assert.equal(
    multiRole.reverse[GEO_FLATBUSH].evidence.filter((edge) => edge.role === LOCATION_ROLES.SUBJECT_PROPERTY).length,
    2,
  );
  assert.deepEqual(
    multiRole.reverse[GEO_FLATBUSH].evidence.map((edge) => edge.assertion_id).sort(),
    [subject.assertion_id, subjectAlias.assertion_id].sort(),
  );

  // Changed address: replace Ocean venue with 810 East 16th.
  const correctedLinks = resolveLinks([venueOffice, subject]);
  assert.equal(correctedLinks[0].resolution.bbl, BBL_810);
  const afterChange = builder.replaceRecordAssertions(meetingId, correctedLinks.map(({ assertion, resolution }) => ({
    assertion,
    resolution,
  })), { observedAt: "2026-09-16T09:00:00.000Z" });

  assert.deepEqual(afterChange.reverse[GEO_K14].record_ids, [meetingId]);
  assert.ok(afterChange.edges.some((edge) => (
    edge.role === LOCATION_ROLES.VENUE && edge.bbl === BBL_810
  )));
  assert.equal(
    afterChange.edges.filter((edge) => edge.role === LOCATION_ROLES.VENUE && edge.bbl === BBL_1625).length,
    0,
  );
  assert.ok(afterChange.edges.some((edge) => (
    edge.role === LOCATION_ROLES.SUBJECT_PROPERTY && edge.bbl === BBL_461
  )));
  assert.equal(
    afterChange.reverse[GEO_MIDWOOD].evidence.filter((edge) => edge.role === LOCATION_ROLES.VENUE).length,
    1,
  );

  // Removal: drop venue; subject evidence and exact reverse ID remain.
  const afterRemoval = builder.replaceRecordAssertions(meetingId, [
    { assertion: correctedLinks[1].assertion, resolution: correctedLinks[1].resolution },
  ], { observedAt: "2026-09-17T09:00:00.000Z" });

  assert.equal(afterRemoval.edges.filter((edge) => edge.role === LOCATION_ROLES.VENUE).length, 0);
  assert.deepEqual(afterRemoval.reverse[GEO_K14].record_ids, [meetingId]);
  assert.deepEqual(
    afterRemoval.reverse[GEO_K14].evidence.map((edge) => edge.role),
    [LOCATION_ROLES.SUBJECT_PROPERTY],
  );
  assert.equal(afterRemoval.reverse[GEO_K14].evidence[0].assertion_id, subject.assertion_id);
  assert.equal(afterRemoval.reverse[GEO_K14].evidence[0].bbl, BBL_461);
  assert.ok(!afterRemoval.reverse[GEO_MIDWOOD]
    || afterRemoval.reverse[GEO_MIDWOOD].record_ids.length === 0
    || !afterRemoval.reverse[GEO_MIDWOOD].evidence.some((edge) => edge.role === LOCATION_ROLES.VENUE));

  // Convenience materializer is the same production builder.
  const { document } = materializeRecordLocationMemberships({
    loadParcelShard: loadRealParcelShard,
    labelFor,
    inputs: correctedLinks.map(({ assertion, resolution }) => ({ assertion, resolution })),
    observedAt: "2026-09-16T09:00:00.000Z",
  });
  assert.equal(document.schema, RECORD_LOCATION_MEMBERSHIP_PROJECTION_SCHEMA);
  assert.ok(document.edges.some((edge) => edge.bbl === BBL_810 && edge.role === LOCATION_ROLES.VENUE));
  assert.ok(document.edges.some((edge) => edge.bbl === BBL_461 && edge.role === LOCATION_ROLES.SUBJECT_PROPERTY));
});
