import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISTRICT_DIGEST_SECTIONS,
  districtDigestAlertsHref,
  districtDigestRows,
  groupDistrictDigestRows,
} from "../site/district_weekly_digest.mjs";
import { buildDistrictWeeklyDigests } from "../tools/lib/district_weekly_digest.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const artifact = JSON.parse(readFileSync(join(ROOT, "site/data/district_weekly_digests.json"), "utf8"));
const boundaries = JSON.parse(readFileSync(join(ROOT, "site/data/district_boundaries.json"), "utf8"));
const communityBoardGeography = JSON.parse(
  readFileSync(join(ROOT, "site/data/community_board_geography_lookup.json"), "utf8"),
);

test("district weekly artifact covers all 51 council districts with exact count/list parity", () => {
  assert.equal(artifact.schema, "district_weekly_digests.v1");
  assert.equal(Object.keys(artifact.by_council_district).length, 51);
  for (let id = 1; id <= 51; id++) {
    const record = artifact.by_council_district[String(id)];
    assert.ok(record, `district ${id}`);
    const rows = districtDigestRows(artifact, String(id));
    assert.equal(record.total, rows.length, `district ${id} preview count equals its item list`);
    assert.equal(record.total, Object.values(record.counts).reduce((n, value) => n + value, 0));
    assert.equal(new Set(rows.map((row) => row.district_item_id)).size, rows.length, "items are unique within a district");
  }
});

test("publisher council takes precedence over community-district fallback in weekly land items", () => {
  const digest = buildDistrictWeeklyDigests({
    boundaries,
    communityBoardGeography,
    builtAt: "2026-08-18T00:00:00.000Z",
    zapRows: [
      {
        project_id: "2024K0001",
        borough: "Brooklyn",
        community_district: "K01",
        cc_district: "33",
      },
    ],
  });
  const councils = Object.entries(digest.by_council_district)
    .filter(([, record]) => record.items.some((item) => item.project_id === "2024K0001"))
    .map(([id]) => id);
  assert.deepEqual(councils, ["33"]);
});

test("hearing actions are current or upcoming at build time", () => {
  const builtDay = artifact.built_at.slice(0, 10);
  const hearings = Object.values(artifact.by_council_district)
    .flatMap((record) => record.items)
    .filter((row) => row.district_section === "hearings");
  // The committed corpus can honestly have zero council-district-placeable
  // upcoming hearings after a calendar day rolls; when hearings are present they
  // must still be on or after the digest build day.
  assert.ok(hearings.every((row) => row.event_date >= builtDay));

  const digest = buildDistrictWeeklyDigests({
    boundaries,
    communityBoardGeography,
    builtAt: "2026-09-16T00:00:00.000Z",
    meetingsRows: [
      {
        request_id: "20260916099",
        event_date: "2026-09-20T10:00:00.000",
        start_date: "2026-09-01T00:00:00.000",
        short_title: "Public Hearing on Local Budget",
        type_of_notice_description: "Public Hearings",
        agency_name: "Landmarks Preservation Commission",
        section_name: "Public Hearings and Meetings",
        street_address_1: "253 Broadway",
        source_system: "city_record",
        affected_area: {
          scope: "local",
          boroughs: ["Manhattan"],
          community_districts: ["M01"],
          derivation: { methods: ["stamped"], confidence: 1 },
          confidence_tier: "strong",
        },
      },
      {
        request_id: "20260801001",
        event_date: "2026-09-10T10:00:00.000",
        short_title: "Past Public Hearing",
        type_of_notice_description: "Public Hearings",
        source_system: "city_record",
        affected_area: {
          scope: "local",
          boroughs: ["Manhattan"],
          community_districts: ["M01"],
          derivation: { methods: ["stamped"], confidence: 1 },
          confidence_tier: "strong",
        },
      },
    ],
    zapRows: [],
    propertyRows: [],
    moneyRows: [],
  });
  const fixtureHearings = Object.values(digest.by_council_district)
    .flatMap((record) => record.items)
    .filter((row) => row.district_section === "hearings");
  assert.ok(fixtureHearings.length > 0);
  assert.deepEqual(
    [...new Set(fixtureHearings.map((row) => row.request_id))],
    ["20260916099"],
  );
  assert.ok(fixtureHearings.every((row) => row.event_date >= "2026-09-16"));
});

test("action sections are positive and honest-absent", () => {
  assert.deepEqual(
    DISTRICT_DIGEST_SECTIONS.map((section) => section.label),
    [
      "Review new contract awards",
      "Attend upcoming hearings",
      "Track land use actions",
      "Review property dispositions",
    ],
  );
  const grouped = groupDistrictDigestRows([
    { district_section: "hearings", district_item_id: "hearing:1" },
    { district_section: "land", district_item_id: "land:1" },
  ]);
  assert.deepEqual(grouped.map((section) => section.id), ["hearings", "land"]);
  assert.ok(grouped.every((section) => section.items.length > 0), "empty sections do not render");
});

test("district Following URL is one shareable weekly watch", () => {
  const href = districtDigestAlertsHref("33");
  assert.match(href, /^https:\/\/cityscroll\.org\/following\?/);
  const q = new URL(href).searchParams;
  assert.equal(q.get("lens"), "district");
  assert.equal(q.get("freq"), "weekly");
  assert.deepEqual(JSON.parse(q.get("filter")), { councilDistrict: "33" });
});

test("materialized payload stays under its declared transfer ceiling", () => {
  const perf = artifact.performance;
  assert.ok(perf.measured_bytes > 0);
  assert.ok(perf.target_bytes < perf.ceiling_bytes);
  assert.ok(perf.measured_bytes <= perf.ceiling_bytes, `${perf.measured_bytes} > ${perf.ceiling_bytes}`);
  assert.equal(perf.max_items_per_district, 100);
});

test("unified alerts retain district watches while Near you watches its shared scope", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  const nearView = readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8");
  const nearPage = readFileSync(join(ROOT, "site/near-you/index.html"), "utf8");
  const boot = readFileSync(join(ROOT, "site/app/boot.mjs"), "utf8");
  assert.match(index, /data-w="district"[^>]*>Follow City Council District</);
  assert.match(index, /id="adistrict"/);
  assert.match(boot, /targetLens==="district"/);
  assert.match(nearView, /watchFromScope/);
  assert.match(nearPage, />Watch these filters</);
});
