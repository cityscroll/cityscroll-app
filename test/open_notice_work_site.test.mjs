// Work site named in an open City Record solicitation, placed in a community district.
// Run: node --test test/open_notice_work_site.test.mjs
//
// The real-notice cases read test/fixtures/open-notice-work-site/notices.json: free-text fields of real
// City Record solicitations, e-mail addresses and telephone numbers replaced by [removed]. The geocoder and
// boundary layers are the committed snapshots, the same ones the acquisition command uses.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  NOTICE_TEXT_FIELDS,
  OPEN_NOTICE_SITE_LABELS,
  OPEN_NOTICE_WORK_SITE_COVERAGE_SCHEMA,
  OPEN_NOTICE_WORK_SITE_SOURCE,
  WORK_SITE_REASONS,
  addressMentionsIn,
  attachOpenNoticeWorkSites,
  classifyAddressMention,
  presentationRole,
  quoteFor,
  scanNoticeAddresses,
  splitNoticeSegments,
} from "../site/open_notice_work_site.mjs";
import {
  createCommittedAddressGeocoder,
  loadFullBoundaryLayers,
  workSiteResolverSources,
} from "../tools/lib/open_notice_work_site_resolver.mjs";
import { buildAll } from "../tools/build_batch_precompute_snapshots.mjs";
import { buildMoneyOpenSolicitationsSnapshot } from "../tools/lib/batch_precompute_snapshots.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/open-notice-work-site/notices.json", import.meta.url), "utf8"));
const BY_CASE = Object.fromEntries(FIXTURE.rows.map((row) => [FIXTURE.cases[row.request_id], row]));
const AS_OF = "2026-11-17";

const geocode = createCommittedAddressGeocoder();
const layerData = loadFullBoundaryLayers();

function attach(rows, extra = {}) {
  const notices = rows.map((row) => ({
    request_id: row.request_id,
    agency_name: row.agency_name,
    short_title: row.short_title,
    coverage: { category: { state: "missing", reason: "no_pin" } },
  }));
  return attachOpenNoticeWorkSites(notices, { textRows: rows, asOf: AS_OF, geocode, layerData, ...extra });
}

function one(name) {
  const row = BY_CASE[name];
  assert.ok(row, name);
  return attach([row]).notices[0];
}

/* ---- the reading primitives ------------------------------------------------------------------ */

test("segments follow the notice's own paragraphs, list items, numbered headings and sentences", () => {
  const html = "<p><strong><u>2. LOCATION</u></strong></p><p>NYC Health + Hospitals NCB: 3424 Kossuth Ave, Bronx, NY 10467</p><ul><li>Pre-bid at 65 Court St. Room 1201. Bring ID.</li></ul>";
  assert.deepEqual(splitNoticeSegments(html), [
    "2. LOCATION",
    "NYC Health + Hospitals NCB: 3424 Kossuth Ave, Bronx, NY 10467",
    "Pre-bid at 65 Court St. Room 1201.",
    "Bring ID.",
  ]);
  assert.deepEqual(splitNoticeSegments("1. PROJECT ID 2. LOCATION NYC Hospital 3. MANDATORY PRE-BID MEETING INFORMATION Only bidders"), [
    "1. PROJECT ID",
    "2. LOCATION NYC Hospital",
    "3. MANDATORY PRE-BID MEETING INFORMATION Only bidders",
  ]);
  assert.deepEqual(splitNoticeSegments(""), []);
  assert.deepEqual(splitNoticeSegments(null), []);
});

test("address mentions: whole house numbers, directions and printed locality, and no phrase that only looks like one", () => {
  const written = (text) => addressMentionsIn(text).map((mention) => mention.written);
  assert.deepEqual(written("Location: Elmhurst Hospital, 79-01 Broadway, Elmhurst, NY, 8th Floor"), ["79-01 Broadway, Elmhurst, NY"]);
  assert.deepEqual(written("LOCATION : Jacobi Medical Center, 1400 Pelham Parkway South, Bronx, NY 10461"), ["1400 Pelham Parkway South, Bronx, NY 10461"]);
  assert.deepEqual(written("a site located at 100 Gold Street in Manhattan (Block 94)"), ["100 Gold Street in Manhattan"]);
  assert.deepEqual(written("Electrical System Replacement - 156 South 9th Street, Brooklyn"), ["156 South 9th Street, Brooklyn"]);
  assert.deepEqual(written("324 EAST 5TH STREET"), ["324 EAST 5TH STREET"]);
  for (const phrase of [
    "search for the notice using 156 S 9 St BK",
    "The program will utilize Local Law 97 to drive engagement",
    "316 Reconstruction of Avenue",
    "48 TRUNK WATER MAIN AND APPURTENANCES IN E. 233RD STREET",
    "21 blocks from 40th St to 61st St",
    "located at Broadway and 7 th Avenue between 41 st Street and 53 rd Street",
  ]) {
    assert.deepEqual(written(phrase).filter((value) => !/^156 S 9/.test(value)), [], phrase);
  }
});

const SENTENCE_CASES = [
  ["Bids must be delivered to 100 Main Street, Queens, NY 11101 before the deadline.", "bid_drop"],
  ["Bidders plan to arrive at 100 Main Street, Brooklyn, NY 11201, Rm 1201 to drop off your bid.", "bid_drop"],
  ["Hard copies may be obtained at the Division of Contracts, 300 Main Street, Room 5.", "bid_drop"],
  ["Bid opening Location - 1 Centre Street, New York, NY 10007", "bid_drop"],
  ["A pre-bid conference will be held on March 6 at 200 Main Street, Brooklyn.", "meeting"],
  ["An optional site visit will be held on Friday at 44 Vernon Boulevard.", "meeting"],
  ["The Department of Example, located at 400 Main Street, Brooklyn, NY 11201.", "agency_office"],
  ["The agency requires parking within walking distance of its headquarters, located at 500 Main Street.", "agency_office"],
  ["The vendor's address is 700 Main Street, Queens, NY 11101.", "unclear"],
  ["Contact us at 800 Main Street, Queens, NY 11101.", "unclear"],
  ["The contractor shall perform the roof replacement work at 600 Main Street, Queens, NY 11101.", "work_site"],
  ["The pumping station is located in Brooklyn, New York at 6002 Flatlands Ave, Brooklyn, New York.", "work_site"],
  ["Located at Bellevue Hospital Center: 462 1st Ave, New York, NY 10016.", "work_site"],
  ["The renovation of the Park's headquarters at 334 Furman St. is a $20M project.", "work_site"],
];

for (const [sentence, expected] of SENTENCE_CASES) {
  test(`address role: ${expected} <- ${sentence.slice(0, 64)}`, () => {
    const [mention] = addressMentionsIn(sentence);
    assert.ok(mention, sentence);
    assert.equal(classifyAddressMention({ segment: sentence, mention }).class, expected);
  });
}

test("a title address is a work site, unless the title says it is where bids are opened", () => {
  const title = "Elevator Repair 308 West 150 St, MN";
  const [mention] = addressMentionsIn(title);
  assert.equal(classifyAddressMention({ segment: title, mention, isTitle: true }).class, "work_site");
  const odd = "Bid opening location 55 Water Street";
  const [other] = addressMentionsIn(odd);
  assert.equal(classifyAddressMention({ segment: odd, mention: other, isTitle: true }).class, "bid_drop");
});

test("a LOCATION label is a work site, and the same label inside a pre-bid meeting block is a meeting", () => {
  const work = scanNoticeAddresses({
    additional_description_1: "<p><strong>2. LOCATION</strong></p><p>NYC H+H NCB: 3424 Kossuth Ave, Bronx, NY 10467</p><p>3. MANDATORY PRE-BID MEETING INFORMATION</p>",
  });
  assert.deepEqual(work.mentions.map((mention) => [mention.class, mention.evidence]), [["work_site", "location_label"]]);
  assert.match(work.mentions[0].quote, /^2\. LOCATION NYC H\+H NCB: 3424 Kossuth Ave/);
  const meeting = scanNoticeAddresses({
    additional_description_1: "<p>The mandatory pre-bid meetings are scheduled for:</p><p>Tuesday, November 17, 2026 at 10:00 A.M.</p><p>Location: Elmhurst Hospital, 79-01 Broadway, Elmhurst, NY, Room E8-11</p>",
  });
  assert.deepEqual(meeting.mentions.map((mention) => mention.class), ["meeting"]);
});

test("a quoted sentence keeps the address in view, stays short, and carries no e-mail address or telephone number", () => {
  const segment = `${"Preamble words. ".repeat(40)}Work at 600 Main Street, Queens, NY 11101, questions to a.person@example.org or (212) 555-0100 ${"trailing words ".repeat(40)}`;
  const [mention] = addressMentionsIn(segment);
  const quote = quoteFor(segment, mention);
  assert.ok(quote.length <= 290, String(quote.length));
  assert.match(quote, /600 Main Street/);
  assert.equal(/@|555/.test(quote), false);
  assert.match(quote, /\[email removed\]/);
  assert.match(quote, /\[phone removed\]/);
});

/* ---- real notices through the committed snapshots --------------------------------------------- */

function districts(notice) {
  return notice.work_sites.map((site) => site.community_district.id);
}

test("resolved: a LOCATION label places the hospital in its district, with the quoted sentence and the source parcel", () => {
  const notice = one("resolved_location_label");
  assert.deepEqual(notice.coverage.work_site, { state: "available", reason: "resolved", source: OPEN_NOTICE_WORK_SITE_SOURCE, as_of: AS_OF });
  assert.equal(notice.coverage.category.reason, "no_pin", "the commodity key is kept");
  assert.equal(notice.work_sites.length, 1);
  const [site] = notice.work_sites;
  assert.equal(site.role, "work_site");
  assert.equal(site.label, "Work site");
  assert.equal(site.address, "3424 Kossuth Ave, Bronx, NY 10467");
  assert.equal(site.quote, "2. LOCATION NYC Health + Hospitals North Central Bronx (NCB): 3424 Kossuth Ave, Bronx, NY 10467");
  assert.equal(site.quote_field, "additional_description_1");
  assert.equal(site.basis, "location_label");
  assert.equal(site.bbl, "2033270200");
  assert.equal(site.borough, "Bronx");
  assert.equal(site.zip, "10467");
  assert.equal(site.community_district.key, "geography:community_district:X07");
  assert.equal(site.community_district.id, "X07");
  assert.equal(site.community_district.area_kind, "community_district");
  assert.equal(site.community_district.boundary_vintage, "2026-05-26");
  assert.equal(site.located_by, "point_containment");
});

test("resolved: other members of the population, by a title address and by a work sentence", () => {
  assert.deepEqual(districts(one("resolved_title")), ["K01"]);
  assert.deepEqual(districts(one("resolved_work_sentence")), ["K02"]);
  assert.deepEqual(districts(one("resolved_work_sentence_queens")), ["Q12"]);
  assert.deepEqual(districts(one("resolved_hospital_a")), ["K05"]);
  assert.deepEqual(districts(one("resolved_hospital_b")), ["Q08"]);
  assert.equal(one("resolved_title").work_sites[0].basis, "title");
});

test("a placed address is labelled from the typed role its sentence supports", () => {
  assert.equal(presentationRole({
    title: "Roof replacement",
    quote: "The contractor shall purchase and deliver materials for the roof renovation at 600 Main Street.",
  }), "work_site");
  assert.equal(presentationRole({
    title: "Event Operator Services for 1680 Lexington Avenue Event Space RFP",
    quote: "Event Operator Services for 1680 Lexington Avenue Event Space RFP",
  }), "facility_site");
  assert.equal(presentationRole({
    title: "Adaptive Reuse - 44-36 Vernon Boulevard Building",
    quote: "Adaptive Reuse - 44-36 Vernon Boulevard Building",
  }), "facility_site");
  assert.equal(OPEN_NOTICE_SITE_LABELS.work_site, "Work site");
  assert.equal(OPEN_NOTICE_SITE_LABELS.delivery_site, "Delivery site");
  assert.equal(OPEN_NOTICE_SITE_LABELS.facility_site, "Property in this solicitation");

  const delivery = attach([{
    request_id: "20260309013",
    agency_name: "City University",
    short_title: "Ancillary Medical Equipment for BMCC's Hospital Simulation Center",
    additional_description_1: "The Borough of Manhattan Community College ('College') of the City University of New York is seeking a vendor for the purchase and delivery of Ancillary Medical Equipment for BMCC's Hospital Simulation Center located at 70 Murray Street, NY NY 10007.",
  }]).notices[0];
  assert.equal(delivery.coverage.work_site.reason, "resolved");
  assert.equal(delivery.work_sites.length, 1);
  assert.equal(delivery.work_sites[0].role, "delivery_site");
  assert.equal(delivery.work_sites[0].label, "Delivery site");
  assert.equal(delivery.work_sites[0].community_district.key, "geography:community_district:M01");

  const property = one("range_site_partly_placed");
  assert.equal(property.coverage.work_site.reason, "resolved");
  assert.ok(property.work_sites.length >= 1);
  for (const site of property.work_sites) {
    assert.equal(site.role, "facility_site");
    assert.equal(site.label, "Property in this solicitation");
  }
});

test("two sites in different districts are both published, one per address", () => {
  const notice = one("two_sites_two_districts");
  assert.equal(notice.coverage.work_site.state, "available");
  assert.deepEqual(notice.work_sites.map((site) => [site.address.split(",")[0], site.community_district.id]).sort(), [
    ["23 Ash Street", "K01"],
    ["90 Church Street", "M01"],
  ]);
  assert.equal(notice.work_site_scan.sites_named, 2);
  assert.equal(notice.work_site_scan.sites_placed, 2);
});

test("a named site the address snapshot does not carry is listed as unplaced, and the placed one still resolves", () => {
  const notice = one("one_of_two_sites_placed");
  assert.equal(notice.coverage.work_site.reason, "resolved");
  assert.deepEqual(districts(notice), ["X09"]);
  assert.deepEqual(notice.work_sites_unplaced, [
    { address: "530 Zerega Avenue, Bronx, NY 10473", state: "unresolved", reason: "not_covered" },
  ]);
  assert.equal(notice.work_site_scan.sites_named, 2);
  assert.equal(notice.work_site_scan.sites_placed, 1);
});

test("bid-drop only: the Department of Education's boilerplate address is never a work site", () => {
  const notice = one("bid_drop_only_doe");
  assert.equal(notice.coverage.work_site.state, "missing");
  assert.equal(notice.coverage.work_site.reason, "only_bid_drop_address");
  assert.deepEqual(notice.work_sites, []);
  assert.ok(notice.work_site_scan.rejected.bid_drop >= 1);
  assert.equal(notice.work_site_scan.boroughs_named.length, 0, "the borough inside the bid-drop address is not the work's borough");
});

test("document pick-up and agency office addresses are never work sites", () => {
  assert.equal(one("pickup_only_ddc").coverage.work_site.reason, "only_bid_drop_address");
  const parks = one("meeting_and_office_parks");
  assert.equal(parks.coverage.work_site.state, "missing");
  assert.deepEqual(parks.work_sites, []);
  assert.ok(parks.work_site_scan.rejected.meeting >= 1);
  assert.ok(parks.work_site_scan.rejected.agency_office >= 1);
});

test("pre-bid meeting address only: the hospital where the meeting is held is not claimed as the work site", () => {
  const notice = one("meeting_only");
  assert.equal(notice.coverage.work_site.reason, "only_meeting_address");
  assert.deepEqual(notice.work_sites, []);
});

test("an address the snapshot cannot place is said so, with the address and the reason", () => {
  const notice = one("address_not_covered");
  assert.equal(notice.coverage.work_site.state, "missing");
  assert.equal(notice.coverage.work_site.reason, "address_not_resolved");
  assert.deepEqual(notice.work_sites_unplaced, [
    { address: "6002 Flatlands Ave, Brooklyn, New York", state: "unresolved", reason: "not_covered" },
  ]);
});

test("an address printed without its borough that exists in more than one is ambiguous, not guessed", () => {
  const notice = one("ambiguous_address");
  assert.equal(notice.coverage.work_site.state, "missing");
  assert.equal(notice.coverage.work_site.reason, "ambiguous");
  assert.deepEqual(notice.work_sites, []);
  assert.equal(notice.work_sites_unplaced[0].state, "ambiguous");
});

test("a list of development sites with one printed address is not resolved from that one address", () => {
  const notice = one("role_unclear_site_list");
  assert.equal(notice.coverage.work_site.reason, "address_role_unclear");
  assert.deepEqual(notice.work_sites, []);
});

test("a borough named without a street address stays missing and says so", () => {
  assert.equal(one("borough_only").coverage.work_site.reason, "borough_only");
  assert.equal(one("no_place_named").coverage.work_site.reason, "no_place_named");
});

test("vendor and publisher office fields are never read, only the notice text", () => {
  assert.equal(NOTICE_TEXT_FIELDS.some((field) => /vendor|address_to_request|street_address|contact|email/.test(field)), false);
  const row = {
    request_id: "20260101001",
    agency_name: "Department of Example",
    short_title: "Office supplies",
    additional_description_1: "<p>Supply of paper.</p>",
    vendor_address: "100 Main Street, Brooklyn, NY 11201",
    vendor_name: "Example Vendor",
    address_to_request: "200 Main Street, Brooklyn, NY 11201",
    street_address_1: "300 Main Street",
  };
  const notice = attach([row]).notices[0];
  assert.equal(notice.coverage.work_site.reason, "no_place_named");
  assert.deepEqual(notice.work_sites, []);
});

/* ---- failure and coverage ---------------------------------------------------------------------- */

test("a failed text read still publishes every notice, each missing, and the artifact is unavailable", () => {
  const rows = FIXTURE.rows.slice(0, 3);
  const { notices, coverage } = attach(rows, { textRows: null, unavailableReason: "soda-http-503" });
  assert.equal(notices.length, 3);
  for (const notice of notices) {
    assert.equal(notice.coverage.work_site.state, "missing");
    assert.equal(notice.coverage.work_site.reason, "text_unavailable");
    assert.deepEqual(notice.work_sites, []);
    assert.equal(notice.coverage.category.reason, "no_pin");
  }
  assert.equal(coverage.state, "unavailable");
  assert.equal(coverage.unavailable_reason, "soda-http-503");
  assert.equal(coverage.available, 0);
});

test("a notice with no text row is missing with its own reason, not a no-place verdict", () => {
  const { notices } = attachOpenNoticeWorkSites(
    [{ request_id: "20260101009", agency_name: "Example", short_title: "No text" }],
    { textRows: [], asOf: AS_OF, geocode, layerData },
  );
  assert.equal(notices[0].coverage.work_site.reason, "notice_text_missing");
});

test("a geocoder that cannot answer leaves the site unplaced and never throws", () => {
  const row = BY_CASE.resolved_location_label;
  const refusing = () => ({ status: "unknown", reason: "snapshot_unavailable" });
  const throwing = () => { throw new Error("boom"); };
  assert.equal(attach([row], { geocode: refusing }).notices[0].coverage.work_site.reason, "address_not_resolved");
  assert.doesNotThrow(() => attach([row], { geocode: () => ({ status: "matched", lon: Number.NaN, lat: 1 }) }));
  assert.throws(() => attach([row], { geocode: throwing }), /boom/, "a defect in the injected geocoder is not hidden as a no-place verdict");
});

test("a point inside a joint interest area is published as that area, not folded into a neighbouring district", () => {
  const row = BY_CASE.resolved_location_label;
  const centralPark = () => ({ status: "matched", bbl: "1011110001", lon: -73.9654, lat: 40.7829, borough: "Manhattan", zip: "10024" });
  const [site] = attach([row], { geocode: centralPark }).notices[0].work_sites;
  assert.equal(site.community_district.id, "M64");
  assert.equal(site.community_district.area_kind, "joint_interest_area");
});

test("a point outside every community district is unresolved, not assigned to the nearest", () => {
  const row = BY_CASE.resolved_location_label;
  const offshore = () => ({ status: "matched", bbl: "2033270200", lon: -74.5, lat: 40.2, borough: "Bronx" });
  const notice = attach([row], { geocode: offshore }).notices[0];
  assert.equal(notice.coverage.work_site.state, "missing");
  assert.equal(notice.coverage.work_site.reason, "address_not_resolved");
});

test("coverage names the cohort: counts add up, every reason is keyed, and the rule is stated", () => {
  const { notices, coverage } = attach(FIXTURE.rows, { observedAt: "2026-11-17T11:30:00.000Z", resolverSources: workSiteResolverSources({ geocode, layerData }) });
  assert.equal(coverage.schema, OPEN_NOTICE_WORK_SITE_COVERAGE_SCHEMA);
  assert.equal(coverage.state, "measured");
  assert.equal(coverage.unavailable_reason, null);
  assert.equal(coverage.open_notices, FIXTURE.rows.length);
  assert.equal(coverage.available + coverage.missing, coverage.open_notices);
  assert.deepEqual(Object.keys(coverage.by_reason), [...WORK_SITE_REASONS]);
  assert.equal(Object.values(coverage.by_reason).reduce((sum, value) => sum + value, 0), coverage.open_notices);
  assert.equal(coverage.by_reason.resolved, coverage.available);
  assert.equal(coverage.sites_published, notices.reduce((sum, notice) => sum + notice.work_sites.length, 0));
  assert.match(coverage.rule, /work site only when the notice presents it as the place of the work/);
  assert.equal(coverage.resolver.address.version, "26c");
  assert.equal(coverage.resolver.boundary.vintage, "2026-05-26");
  assert.equal(coverage.resolver.boundary.geometry_fidelity, "full");
});

test("the artifact never carries the notice text, contact fields or a vendor address", () => {
  const { notices } = attach(FIXTURE.rows);
  for (const notice of notices) {
    const text = JSON.stringify(notice);
    assert.equal(/@|vendor_address|address_to_request|contact_/.test(text), false, notice.request_id);
    assert.deepEqual(Object.keys(notice).filter((key) => /description|other_info|printout|text/.test(key)), [], notice.request_id);
    for (const site of notice.work_sites) assert.ok(site.quote.length <= 290);
  }
});

/* ---- the publisher ------------------------------------------------------------------------------- */

const NOW = new Date("2026-11-17T11:30:00.000Z");
const RAW = JSON.parse(readFileSync(new URL("./fixtures/batch-precompute/money_open_solicitations_raw.json", import.meta.url), "utf8"));
const COUNT = Number(JSON.parse(readFileSync(new URL("./fixtures/batch-precompute/money_open_solicitations_count.json", import.meta.url), "utf8"))[0].n);
const TEXT = JSON.parse(readFileSync(new URL("./fixtures/batch-precompute/open_notice_text.json", import.meta.url), "utf8"));

test("the snapshot builder publishes work_site_coverage beside the category coverage and keeps its bound", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot(
    { rows: RAW, sourceCount: COUNT, workSite: { textRows: TEXT, observedAt: NOW.toISOString(), geocode, layerData, resolverSources: workSiteResolverSources({ geocode, layerData }) } },
    { now: NOW },
  );
  assert.equal(snap.population.state, "complete");
  assert.equal(snap.count, 194);
  assert.equal(snap.work_site_coverage.state, "measured");
  assert.equal(snap.work_site_coverage.open_notices, 194);
  assert.equal(snap.work_site_coverage.available + snap.work_site_coverage.missing, 194);
  assert.equal(snap.work_site_coverage.by_reason.notice_text_missing, 194 - TEXT.length);
  assert.equal(snap.work_site_coverage.available, 6);
  for (const notice of snap.notices) {
    assert.ok(["available", "missing"].includes(notice.coverage.work_site.state));
    assert.ok(Array.isArray(notice.work_sites));
  }
  assert.ok(Buffer.byteLength(`${JSON.stringify(snap, null, 2)}\n`) < 768 * 1024);
});

test("the snapshot builder with no work-site input leaves the artifact shape as it was", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: COUNT }, { now: NOW });
  assert.equal(snap.work_site_coverage, undefined);
  assert.equal(snap.notices[0].work_sites, undefined);
  assert.equal(snap.notices[0].coverage, undefined);
});

test("an unavailable text read is recorded on the artifact and does not drop the City Record rows", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot(
    { rows: RAW, sourceCount: COUNT, workSite: { unavailable: "soda-http-503", observedAt: NOW.toISOString() } },
    { now: NOW },
  );
  assert.equal(snap.count, 194);
  assert.equal(snap.work_site_coverage.state, "unavailable");
  assert.equal(snap.work_site_coverage.by_reason.text_unavailable, 194);
});

test("builder fixture mode reads the retained text and publishes the measured cohort", async () => {
  const built = await buildAll({ fixture: true, now: NOW, moneyOpenSolicitationsOnly: true });
  const coverage = built.money_open_solicitations.work_site_coverage;
  assert.equal(coverage.state, "measured");
  assert.equal(coverage.open_notices, 194);
  assert.equal(coverage.available, 6);
  assert.equal(coverage.by_reason.resolved, 6);
  assert.equal(coverage.by_reason.notice_text_missing, 194 - 13);
  const strip = built.money_open_solicitations.notices.find((row) => row.request_id === "20260930001");
  assert.deepEqual(strip.work_sites.map((site) => site.community_district.id), ["X07"]);
});

test("the text query is the population's predicate and order, and the publisher does not name an internal product", async () => {
  const { moneyOpenSolicitationsQuery, moneyOpenSolicitationTextQuery } = await import("../tools/lib/batch_precompute_snapshots.mjs");
  const population = moneyOpenSolicitationsQuery(NOW);
  const text = moneyOpenSolicitationTextQuery(NOW);
  assert.equal(text.$where, population.$where);
  assert.equal(text.$order, population.$order);
  assert.equal(text.$limit, population.$limit);
  assert.deepEqual(text.$select.split(","), ["request_id", ...NOTICE_TEXT_FIELDS]);
  for (const file of ["../site/open_notice_work_site.mjs", "../tools/lib/open_notice_work_site_resolver.mjs"]) {
    assert.equal(/waypoint|cityscroll-product/i.test(readFileSync(new URL(file, import.meta.url), "utf8")), false, file);
  }
});
