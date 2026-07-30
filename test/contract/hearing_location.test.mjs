import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  hearingMatchesLocation,
  normalizeHearing,
} from "../../worker/src/lib/hearings.mjs";

const require = createRequire(import.meta.url);
const {
  hearingMatchesArea,
  normalizeHearingRow,
} = require("../../site/hearing_location.js");
const fixtures = JSON.parse(await readFile(new URL("./fixtures/hearings.json", import.meta.url), "utf8"));

for (const fixture of fixtures) {
  test(`browser fallback matches the Worker materialized view: ${fixture.name}`, () => {
    const worker = normalizeHearing(fixture.row);
    const browser = normalizeHearingRow(fixture.row);
    assert.deepEqual(browser.affected_area, worker.affected_area);
    assert.deepEqual(browser.venue, worker.venue);
    assert.deepEqual(browser.affects, worker.affects);
    assert.equal(browser.decides, worker.decides);
    assert.equal(browser.event_date, worker.event_date);
  });
}

test("affected geography, not a Manhattan venue, drives the Queens match", () => {
  const record = normalizeHearing(fixtures[1].row);
  assert.equal(record.venue.address, "120 Broadway, Lower Level, New York, NY, 10271");
  assert.deepEqual(record.affected_area.boroughs, ["Queens"]);
  assert.equal(hearingMatchesLocation(record, { borough: "Queens" }), true);
  assert.equal(hearingMatchesLocation(record, { borough: "Manhattan" }), false);
  assert.equal(hearingMatchesArea(record, { neighborhood: "Sunnyside" }), true);
});

test("venue-only geography stays unlocated instead of becoming an affected area", () => {
  const row = {
    request_id: "venue-only",
    section_name: "Public Hearings and Meetings",
    short_title: "Public hearing",
    additional_description_1: "The hearing will be held in Manhattan. Testimony may also be submitted online.",
    street_address_1: "22 Reade Street",
    city: "New York",
    state: "NY",
    zip_code: "10007",
  };
  const browser = normalizeHearingRow(row);
  const worker = normalizeHearing(row);
  assert.equal(browser.affected_area.scope, "unlocated");
  assert.equal(worker.affected_area.scope, "unlocated");
  assert.equal(worker.venue.address, "22 Reade Street, New York, NY, 10007");
  assert.equal(hearingMatchesLocation(worker, { borough: "Manhattan" }), false);
});

test("citywide matters match every borough while unlocated matters remain explicit", () => {
  const citywide = normalizeHearing(fixtures[2].row);
  const unlocated = normalizeHearing(fixtures[3].row);
  assert.equal(citywide.affected_area.scope, "citywide");
  assert.equal(hearingMatchesLocation(citywide, { borough: "Bronx" }), true);
  assert.equal(unlocated.affected_area.scope, "unlocated");
  assert.equal(hearingMatchesLocation(unlocated, { borough: "Manhattan" }), false);
  assert.equal(hearingMatchesLocation(unlocated, { locationScope: "citywide-unlocated" }), true);
});

test("participation and audience clues are extracted only when the notice supplies them", () => {
  const contact = ["example", "example.com"].join("@");
  const rule = normalizeHearing({
    ...fixtures[2].row,
    additional_description_1: `${fixtures[2].row.additional_description_1} Email ${contact} to submit comments.`,
  });
  assert.deepEqual(rule.affects, ["audience_restaurants"]);
  assert.equal(rule.venue.mode, "virtual");
  assert.equal(rule.participation.links[0].label, "Join online");
  assert.deepEqual(rule.participation.emails, [contact]);

  const unlocated = normalizeHearing(fixtures[3].row);
  assert.deepEqual(unlocated.affects, []);
  assert.deepEqual(unlocated.participation.links, []);
});
