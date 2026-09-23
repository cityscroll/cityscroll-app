import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseHtmlPdfSource,
} from "../site/community_board_source_adapters.mjs";
import {
  LOCATION_ROLES,
  LOCATION_VALIDITY,
  extractAgendaSubjectPlaces,
  isAdmittedPhysicalVenue,
  isAdmittedSubjectProperty,
} from "../site/meeting_location_assertions.mjs";
import {
  addressShardKey,
  parseAddressQuery,
  resolveAddressFromShard,
} from "../site/precomputed_address_geocoder.mjs";
import { materializeCommunityBoardMeetingRow } from "../tools/build_community_board_meeting_index.mjs";

const retentionFixture = (name) => readFileSync(
  new URL(`./fixtures/community_board_meeting_retention/${name}`, import.meta.url),
  "utf8",
);
const locationFixture = (name) => readFileSync(
  new URL(`./fixtures/meeting_location_assertions/${name}`, import.meta.url),
  "utf8",
);

const CB14_SEPT14_URL = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const CB14_HOUSING_URL = "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const OFFICIAL_HTML = retentionFixture("september-2026-board-meeting.html");
const OFFICIAL_SHA256 = "0fcab5cd4a67004d7e76513a1ac321efc9bae6f7fe6f1e6ace3928529cd7fff5";

function parseEventDetail(html, url = CB14_SEPT14_URL) {
  return parseHtmlPdfSource(html, {
    adapter: "html_pdf_v1",
    role: "event_detail",
    source_role: "event_detail",
    board_id: "brooklyn-cb-14",
    body_name: "Brooklyn Community Board 14",
    url: "https://cb14brooklyn.com/meetings/",
    event_detail: true,
    format: "board-owned WordPress HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } })
    .filter((row) => row.record_url === url || row.record_id === url);
}

function materialize(record) {
  return materializeCommunityBoardMeetingRow(record, {
    id: "brooklyn-cb-14",
    name: "Brooklyn Community Board 14",
  }, "2026-09-23T05:09:59.711Z");
}

function resolvePad(address) {
  const query = parseAddressQuery(address);
  assert.ok(query?.street, `PAD parse must yield a street for ${address}`);
  const shard = JSON.parse(
    readFileSync(new URL(`../site/data/address-index/${addressShardKey(query.street)}.json`, import.meta.url), "utf8"),
  );
  return resolveAddressFromShard(query, shard);
}

test("A1 official September 14 source yields cannabis subject assertion and distinct 1625 Ocean venue", () => {
  assert.equal(createHash("sha256").update(OFFICIAL_HTML).digest("hex"), OFFICIAL_SHA256);

  const records = parseEventDetail(OFFICIAL_HTML);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.record_url, CB14_SEPT14_URL);
  assert.equal(record.location_components?.street_address, "1625 Ocean Avenue");
  assert.match(record.description || "", /461 Coney Island Avenue/);
  assert.match(record.description || "", /cannabis application/i);

  const meeting = materialize(record);
  const venue = meeting.location_assertions.find((row) => row.role === LOCATION_ROLES.VENUE);
  const subjects = meeting.location_assertions.filter((row) => row.role === LOCATION_ROLES.SUBJECT_PROPERTY);

  assert.ok(venue);
  assert.equal(venue.components.street_address, "1625 Ocean Avenue");
  assert.equal(isAdmittedPhysicalVenue(venue), true);

  assert.equal(subjects.length, 1);
  const subject = subjects[0];
  assert.equal(isAdmittedSubjectProperty(subject), true);
  assert.equal(subject.validity, LOCATION_VALIDITY.ADMITTED_SUBJECT_PROPERTY);
  assert.equal(subject.original_address, "461 Coney Island Avenue");
  assert.equal(subject.components.street_address, "461 Coney Island Avenue");
  assert.equal(subject.components.address_locality, "Brooklyn");
  assert.equal(subject.components.address_borough, "Brooklyn");
  assert.match(subject.source_passage || "", /application/i);
  assert.match(subject.source_passage || "", /461 Coney Island Avenue/);
  assert.ok(subject.passage_locator);
  assert.match(subject.passage_locator, /application_at/);
  assert.equal(subject.passage_text_sha256?.length, 64);
  assert.doesNotMatch(subject.original_address, /1625 Ocean/);
  assert.doesNotMatch(subject.original_address, /810 East 16th/);
});

test("A2 PAD resolves the subject address to 3050700035 without replacing source wording", () => {
  const records = parseEventDetail(OFFICIAL_HTML);
  const meeting = materialize(records[0]);
  const subject = meeting.location_assertions.find((row) => row.role === LOCATION_ROLES.SUBJECT_PROPERTY);
  assert.ok(subject);
  assert.equal(subject.original_address, "461 Coney Island Avenue");

  const withBorough = resolvePad("461 Coney Island Avenue, Brooklyn");
  assert.equal(withBorough.status, "matched");
  assert.equal(withBorough.bbl, "3050700035");

  // MapPLUTO labels the same corner parcel 901 Church Avenue; that alternate
  // label must not replace the publisher wording or create a second property.
  assert.equal(
    meeting.location_assertions.filter((row) => /901 Church/i.test(row.original_address || "")).length,
    0,
  );
  assert.equal(
    meeting.location_assertions.filter((row) => row.role === LOCATION_ROLES.SUBJECT_PROPERTY).length,
    1,
  );
  assert.equal(subject.original_address, "461 Coney Island Avenue");
  assert.equal(subject.components.street_address, "461 Coney Island Avenue");
});

test("A3 footer, neighboring links, and September 23 do not emit the 461 subject", () => {
  const sept14 = materialize(parseEventDetail(OFFICIAL_HTML)[0]);
  assert.equal(
    sept14.location_assertions.filter((row) => (
      row.role === LOCATION_ROLES.SUBJECT_PROPERTY
      && /810 East 16th/i.test(row.original_address || "")
    )).length,
    0,
  );
  assert.equal(String(OFFICIAL_HTML).includes("810 East 16th Street"), true);
  assert.doesNotMatch(String(sept14.venue?.address || ""), /810 East 16th/);

  // Neighboring-event chrome and registration/contact copy carry no subject clause.
  const neighboringOnly = extractAgendaSubjectPlaces(
    "« Public Hearing on ULURP Application and Executive Committee Meeting contact the District Office to sign up 810 East 16th Street",
  );
  assert.equal(neighboringOnly.length, 0);

  const housingHtml = locationFixture("cb14-housing-land-use-september-2026.html");
  const housingRecords = parseHtmlPdfSource(housingHtml, {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "brooklyn-cb-14",
    body_name: "Brooklyn Community Board 14",
    url: "https://cb14brooklyn.com/meetings/",
    format: "board-owned WordPress HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } });
  assert.equal(housingRecords.length, 1);
  assert.equal(housingRecords[0].record_url, CB14_HOUSING_URL);
  const housing = materialize(housingRecords[0]);
  assert.equal(
    housing.location_assertions.filter((row) => row.role === LOCATION_ROLES.SUBJECT_PROPERTY).length,
    0,
  );
  assert.equal(
    housing.location_assertions.some((row) => /461 Coney Island/i.test(row.original_address || "")),
    false,
  );
  assert.match(housing.venue?.address || "", /810 East 16th Street/);
});

test("A4 only an actual subject clause creates the AG-14 subject edge; footer relocation does not", () => {
  const official = materialize(parseEventDetail(OFFICIAL_HTML)[0]);
  const officialSubjects = official.location_assertions.filter(isAdmittedSubjectProperty);
  assert.equal(officialSubjects.length, 1);
  assert.equal(officialSubjects[0].original_address, "461 Coney Island Avenue");

  // Controlled page: remove every subject clause mentioning 461, keep the
  // address only in the site footer / contact line.
  const relocated = OFFICIAL_HTML
    .replace(/retail cannabis application for OC Dispensary at 461 Coney Island Avenue/gi, "retail cannabis application for OC Dispensary")
    .replace(/Public Hearing on Retail Cannabis Application:\s*461 Coney Island Avenue/gi, "Public Hearing on Retail Cannabis Application")
    .replace(/Retail Cannabis Dispensary Application\s*[-–—]\s*461 Coney Island Avenue/gi, "Retail Cannabis Dispensary Application")
    .replace(/461 Coney Island Avenue/gi, (match, offset, whole) => {
      // Preserve the footer contact line's own street; strip remaining body hits.
      const window = whole.slice(Math.max(0, offset - 80), offset + match.length + 40);
      if (/810 East 16th Street/i.test(window) || /info@cb14brooklyn\.com/i.test(window)) {
        return match;
      }
      return "";
    });
  // Ensure the address still appears once in the footer contact strip.
  assert.equal(relocated.includes("810 East 16th Street, Brooklyn, NY 11230"), true);
  const footerWithSubjectAddress = relocated.replace(
    "810 East 16th Street, Brooklyn, NY 11230",
    "810 East 16th Street, Brooklyn, NY 11230 • subject property mailing: 461 Coney Island Avenue",
  );
  assert.equal(footerWithSubjectAddress.includes("461 Coney Island Avenue"), true);

  const controlled = materialize(parseEventDetail(footerWithSubjectAddress)[0]);
  assert.equal(
    controlled.location_assertions.filter((row) => row.role === LOCATION_ROLES.SUBJECT_PROPERTY).length,
    0,
  );
  assert.equal(controlled.location_assertions.filter(isAdmittedSubjectProperty).length, 0);
  assert.equal(controlled.location_components?.street_address || controlled.venue?.components?.street_address, "1625 Ocean Avenue");
});
