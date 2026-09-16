import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCommunityDistrictDigests } from "../tools/lib/community_district_digest.mjs";
import {
  COMMUNITY_DISTRICT_COVERAGE_STATES,
  COMMUNITY_DISTRICT_DIGEST_SCHEMA,
  COMMUNITY_DISTRICT_DIGEST_SECTIONS,
} from "../site/community_district_digest.mjs";

const districts = [
  ...Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `X${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 18 }, (_, i) => `K${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 14 }, (_, i) => `Q${String(i + 1).padStart(2, "0")}`),
  "R01", "R02", "R03",
];
const lenses = ["meetings", "land", "property", "rules", "money", "consultations"];

function fixtureActivity() {
  const records = Object.fromEntries(lenses.map((lens) => [lens, {}]));
  const byLevel = Object.fromEntries(districts.map((district) => [district, Object.fromEntries(lenses.map((lens) => [lens, []]))]));
  for (const district of districts) {
    for (const lens of lenses) {
      const id = `${lens}:${district}`;
      records[lens][id] = { id, title: `${lens} ${district}`, route: `/notices/${id}`, date: "2026-09-01" };
      byLevel[district][lens].push(id);
    }
  }
  return {
    schema: "cityscroll.district_activity.v1", boundary_vintage: "2026-05-26", built_at: "2026-09-14T00:00:00.000Z",
    district_items: { by_level: { community_district: byLevel }, corpora: Object.fromEntries(lenses.map((lens) => [lens, { stamp_value: "2026-09-01" }])) },
    records, sources: Object.fromEntries(lenses.map((lens) => [lens, { counted: 59 }])),
  };
}

test("A1: materializes one deterministic slice for every regular community district", () => {
  const digest = buildCommunityDistrictDigests({ activity: fixtureActivity(), builtAt: "2026-09-14T00:00:00.000Z" });
  assert.equal(digest.schema, COMMUNITY_DISTRICT_DIGEST_SCHEMA);
  assert.equal(Object.keys(digest.by_community_district).length, 59);
  assert.deepEqual(Object.keys(digest.by_community_district).sort(), districts.slice().sort());
  assert.ok(digest.performance.measured_bytes < digest.performance.ceiling_bytes);
});

test("emits all 59 regular districts when district_items omits zero-activity keys", () => {
  const activity = fixtureActivity();
  const bag = activity.district_items.by_level.community_district;
  const dropped = ["K09", "Q03", "Q11"];
  for (const id of dropped) delete bag[id];
  assert.equal(Object.keys(bag).length, 56);
  const digest = buildCommunityDistrictDigests({ activity, builtAt: "2026-09-14T00:00:00.000Z" });
  assert.deepEqual(Object.keys(digest.by_community_district).sort(), districts.slice().sort());
  for (const id of dropped) {
    const row = digest.by_community_district[id];
    assert.equal(row.community_district, id);
    for (const section of Object.values(row.sections)) {
      assert.equal(section.count, 0);
      assert.deepEqual(section.items, []);
    }
  }
});

test("A2: every slice carries all six bounded section projections", () => {
  const digest = buildCommunityDistrictDigests({ activity: fixtureActivity(), builtAt: "2026-09-14T00:00:00.000Z" });
  for (const row of Object.values(digest.by_community_district)) {
    assert.deepEqual(Object.keys(row.sections).sort(), COMMUNITY_DISTRICT_DIGEST_SECTIONS.map(({ id }) => id).sort());
    for (const section of Object.values(row.sections)) {
      assert.equal(typeof section.count, "number");
      assert.ok(section.items.length <= 8);
      assert.ok(section.items.every((item) => item.id && item.route));
    }
  }
});

test("A3: each slice preserves board, overlaps, build time, vintages, and coverage", () => {
  const builtAt = "2026-09-14T00:00:00.000Z";
  const geography = {
    gate: { publication_allowed: true },
    nodes: [{ id: "community-board:brooklyn-cb-15", name: "Brooklyn Community Board 15" }],
    public_edges: [
      { type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" },
      { type: "intersects", from: "community-district:K15", to: "council-district:44" },
    ],
  };
  const digest = buildCommunityDistrictDigests({ activity: fixtureActivity(), communityBoardGeography: geography, builtAt });
  assert.equal(digest.built_at, builtAt);
  const row = digest.by_community_district.K15;
  assert.equal(row.community_board, "brooklyn-cb-15");
  assert.deepEqual(row.council_districts, ["44"]);
  assert.deepEqual(row.source_vintages, Object.fromEntries(lenses.map((lens) => [lens, "2026-09-01"])));
  assert.ok(Object.values(row.sections).every((section) => section.coverage.state));
});

test("A4: all coverage states remain distinct and absence cannot become zero", () => {
  const activity = fixtureActivity();
  const states = COMMUNITY_DISTRICT_COVERAGE_STATES;
  const coverage = {
    K15: Object.fromEntries(lenses.map((lens, index) => [lens, { state: states[index], reason: "fixture" }])),
    K16: { money: { state: "failed", reason: "fixture" } },
  };
  const digest = buildCommunityDistrictDigests({ activity, builtAt: "2026-09-14T00:00:00.000Z", coverage });
  const sections = digest.by_community_district.K15.sections;
  assert.deepEqual(lenses.map((lens) => sections[lens].coverage.state), states.slice(0, lenses.length));
  const allStates = [
    ...Object.values(sections).map((section) => section.coverage.state),
    digest.by_community_district.K16.sections.money.coverage.state,
  ];
  assert.deepEqual([...new Set(allStates)].sort(), [...states].sort());
  for (const section of [...Object.values(sections), digest.by_community_district.K16.sections.money]) {
    if (section.coverage.state === "known_zero") assert.equal(section.count, 0);
    else if (section.coverage.state === "supported") assert.equal(typeof section.count, "number");
    else assert.equal(section.count, null);
    if (!["supported", "known_zero"].includes(section.coverage.state)) assert.deepEqual(section.items, []);
  }
  assert.throws(() => buildCommunityDistrictDigests({ activity, coverage: { K15: { money: { state: "invented" } } } }), /invalid coverage state/);
});

test("A6: K15 retains both land identifiers, meeting references, board mapping, and bounded payload", () => {
  const activity = fixtureActivity();
  activity.records.land["land:K15:second"] = { id: "land:K15:second", title: "second land project", route: "/land/land:K15:second", date: "2026-09-02" };
  activity.district_items.by_level.community_district.K15.land.push("land:K15:second");
  activity.records.meetings["meeting:K15:accepted"] = { id: "meeting:K15:accepted", title: "accepted meeting", route: "/meetings/meeting:K15:accepted", date: "2026-09-03" };
  activity.district_items.by_level.community_district.K15.meetings.push("meeting:K15:accepted");
  const geography = {
    gate: { publication_allowed: true },
    nodes: [{ id: "community-board:brooklyn-cb-15", name: "Brooklyn Community Board 15" }],
    public_edges: [{ type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" }],
  };
  const digest = buildCommunityDistrictDigests({ activity, communityBoardGeography: geography, builtAt: "2026-09-14T00:00:00.000Z" });
  const row = digest.by_community_district.K15;
  assert.deepEqual(row.sections.land.items.map((item) => item.id).sort(), ["land:K15", "land:K15:second"]);
  assert.equal(row.sections.meetings.items[0].id, "meeting:K15:accepted");
  assert.equal(row.community_board, "brooklyn-cb-15");
  assert.ok(digest.performance.measured_bytes <= digest.performance.ceiling_bytes);
  assert.match(digest.note, /no request-time corpus reads/);
  assert.deepEqual(Object.keys(row.sections.land.items[0]).sort(), ["date", "id", "project_id", "route", "title"].sort());
  assert.deepEqual(Object.keys(row.sections.consultations.items[0]).sort(), ["consultation_id", "date", "id", "route", "title"].sort());
  assert.deepEqual(Object.keys(row.sections.meetings.items[0]).sort(), ["date", "id", "request_id", "route", "title"].sort());
});

test("retains a textual capture manifest for the materialized route payload", () => {
  const manifest = JSON.parse(readFileSync(new URL("../docs/evidence/community-district-digest/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.capture_type, "textual-route-manifest");
  assert.ok(manifest.entries.every((entry) => entry.route && entry.viewport && entry.revision && entry.data_vintage && entry.assertion && /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test("keeps board identity, overlaps, vintages, and explicit unavailable coverage", () => {
  const geography = {
    gate: { publication_allowed: true },
    nodes: [{ id: "community-board:brooklyn-cb-15", name: "Brooklyn Community Board 15" }],
    public_edges: [
      { type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" },
      { type: "intersects", from: "community-district:K15", to: "council-district:44" },
    ],
  };
  const digest = buildCommunityDistrictDigests({ activity: fixtureActivity(), communityBoardGeography: geography, coverage: { K15: { money: { state: "unavailable", reason: "fixture" } } } });
  const row = digest.by_community_district.K15;
  assert.equal(row.community_board, "brooklyn-cb-15");
  assert.deepEqual(row.council_districts, ["44"]);
  assert.equal(row.source_vintages.money, "2026-09-01");
  assert.equal(row.sections.money.coverage.state, "unavailable");
});
