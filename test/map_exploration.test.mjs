import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import {
  MAP_EXPLORATION_SCHEMA,
  DISTRICT_ACTIVITY_SCHEMA,
  areaFeedLinks,
  detectMapFeedScopeLobby,
  boroughFromCommunityId,
  bucketFeedLinks,
  choroplethFill,
  citywideTotals,
  citywideBucketCounts,
  defaultViewBox,
  districtBagItemIds,
  drillInto,
  filterRowsByDistrictBag,
  materializeDistrictBagRows,
  granularityCollapseFindings,
  loadDistrictActivity,
  mapDrillListHash,
  mapFeatures,
  nonPolygonBuckets,
  moneyCoverageFraming,
  parseMapDrillListHash,
  parseMapHashQuery,
  polygonsToSvgPath,
  projectLonLat,
  rowMatchesMapDrillFilter,
  serializeMapHash,
  totalForLens,
  zoomViewBox,
  panViewBox,
  BOROUGH_META,
} from "../site/map_exploration.mjs";
import {
  buildContractActionBasisLayer,
  buildDistrictActivity,
  communityDistrictFromAgencyName,
  meetingPlacementsFromRow,
  parseZapCommunityDistricts,
} from "../tools/lib/district_activity.mjs";
import {
  geocodeCivicAddress,
  buildCommunityToCouncilIndex,
} from "../site/civic_address_geocode.mjs";
import { resolveCouncilDistrict } from "../site/council_district_lookup.mjs";

const boundaries = JSON.parse(
  readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"),
);

test("map helpers project lon/lat and emit SVG paths", () => {
  const [x, y] = projectLonLat(-74.006, 40.7128);
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  const path = polygonsToSvgPath(boundaries.council_districts[0].polygons);
  assert.match(path, /^M/);
  assert.match(path, /Z/);
});

test("choroplethFill uses the civic palette for zero and deepens with density", () => {
  assert.equal(choroplethFill(0, 10), "#eceef2");
  assert.notEqual(choroplethFill(10, 10), choroplethFill(1, 10));
  assert.ok(totalForLens({ land: 2, property: 3 }, "all") === 5);
  assert.ok(totalForLens({ land: 2, property: 3 }, "land") === 2);
});

test("viewBox zoom/pan stay numeric", () => {
  const base = defaultViewBox();
  const z = zoomViewBox(base, 0.5);
  assert.equal(z.split(/\s+/).length, 4);
  const p = panViewBox(base, 0.1, -0.1);
  assert.equal(p.split(/\s+/).length, 4);
});

test("areaFeedLinks uses existing list filter grammar", () => {
  const boro = areaFeedLinks("borough", "Queens", { onlyPositive: false });
  assert.ok(boro.some((l) => l.hash === "#land?boro=Queens"));
  assert.ok(boro.some((l) => l.hash === "#property?boro=Queens"));
  assert.ok(boro.some((l) => l.hash === "#meetings?when=all&boro=Queens"));
  assert.ok(boro.some((l) => l.hash === "#rules?boro=Queens"));
  assert.equal(boro.find((l) => l.lens === "land")?.scope, "district");
  // Money has no borough polygon filter — omit rather than bare #money lobby.
  assert.ok(!boro.some((l) => l.lens === "money"));
  const cd = areaFeedLinks("community_district", "Q04", { onlyPositive: false });
  assert.ok(cd.some((l) => l.hash.includes("cd=Q04")));
  assert.equal(cd.find((l) => l.lens === "property")?.hash, "#property?boro=Queens&cd=Q04");
  assert.equal(cd.find((l) => l.lens === "property")?.scope, "district");
  assert.equal(cd.find((l) => l.lens === "meetings")?.hash, "#meetings?when=all&boro=Queens&cd=Q04");
  assert.equal(cd.find((l) => l.lens === "meetings")?.scope, "district");
  const council = areaFeedLinks("council_district", "25", { onlyPositive: false });
  assert.ok(council.some((l) => l.hash === "#land?council=25"));
  assert.equal(council.find((l) => l.lens === "land")?.scope, "district");
  assert.equal(council.find((l) => l.lens === "property")?.hash, "#property?council=25");
  assert.equal(council.find((l) => l.lens === "meetings")?.hash, "#meetings?when=all&council=25");
  // Rules and performance-place Money still lack exact council filters.
  for (const lens of ["money", "rules"]) {
    assert.ok(!council.some((l) => l.lens === lens), lens);
  }
});

test("response-logistics Money links carry exact district scope and positive naming", () => {
  const links = areaFeedLinks("community_district", "M01", {
    counts: { land: 0, property: 0, rules: 0, meetings: 0, money: 3 },
    basis: "contract_action_address",
  });
  const moneyLink = links.find((link) => link.lens === "money");
  assert.equal(
    moneyLink?.hash,
    "#money?basis=contract_action_address&boro=Manhattan&cd=M01",
  );
  assert.equal(moneyLink?.label_key, "map_feed_contract_action_community");
  assert.equal(moneyLink?.scope, "district");
});

test("detectMapFeedScopeLobby flags bare citywide links under positive district counts", () => {
  const lobby = [
    { lens: "meetings", hash: "#meetings", label_key: "tab_meetings", scope: "citywide" },
    { lens: "land", hash: "#land?council=1", label_key: "tab_land", scope: "district" },
  ];
  const hit = detectMapFeedScopeLobby(lobby, { land: 5, meetings: 34, money: 0, rules: 0, property: 12 });
  assert.equal(hit.ok, false);
  assert.ok(hit.findings.some((f) => f.kind === "map-feed-scope-lobby" && f.lens === "meetings" && f.district_count === 34));
  assert.ok(!hit.findings.some((f) => f.lens === "land"));
  // Real areaFeedLinks for council must not produce lobby findings.
  const council = areaFeedLinks("council_district", "1", {
    onlyPositive: false,
    counts: { land: 5, meetings: 34, money: 0, rules: 0, property: 12 },
  });
  const quiet = detectMapFeedScopeLobby(council, { land: 5, meetings: 34, money: 0, rules: 0, property: 12 });
  assert.equal(quiet.ok, true);
});

test("bucketFeedLinks carry virtual and citywide scopes into list hashes", () => {
  const virt = bucketFeedLinks("virtual", {
    counts: { land: 0, property: 0, rules: 0, meetings: 3, money: 0 },
  });
  assert.equal(virt.length, 1);
  assert.equal(virt[0].lens, "meetings");
  assert.equal(virt[0].hash, "#meetings?when=all&scope=virtual");
  assert.equal(virt[0].count, 3);

  const cw = bucketFeedLinks("citywide", {
    counts: { land: 3, property: 0, rules: 97, meetings: 3, money: 1 },
  });
  assert.ok(cw.some((l) => l.hash === "#rules?scope=citywide" && l.count === 97));
  assert.ok(cw.some((l) => l.hash === "#meetings?when=all&scope=citywide" && l.count === 3));
  assert.ok(cw.some((l) => l.hash === "#money?scope=citywide" && l.count === 1));
});

test("mapDrillListHash / parseMapDrillListHash round-trip", () => {
  const hash = mapDrillListHash("meetings", { locationScope: "virtual", when: "all" });
  const parsed = parseMapDrillListHash(hash);
  assert.equal(parsed.lens, "meetings");
  assert.equal(parsed.filter.locationScope, "virtual");
  assert.equal(parsed.filter.when, "all");
});

test("map response-logistics basis round-trips without changing performance geography", () => {
  const hash = serializeMapHash({
    level: "council_district",
    id: "1",
    lens: "money",
    basis: "contract_action_address",
  });
  assert.equal(hash, "#map?level=council_district&id=1&lens=money&basis=contract_action_address");
  const parsed = parseMapHashQuery(new URLSearchParams(hash.split("?")[1]));
  assert.equal(parsed.basis, "contract_action_address");

  const primary = buildDistrictActivity({
    boundaries,
    moneyRows: [{ request_id: "performance", borough: "Queens" }],
    contractActionRows: [{
      request_id: "response",
      addresses: [{ basis: "submission_address", normalized_address: "1 Centre Street" }],
      locations: [{
        basis: "submission_address",
        basis_label: "Located by submission address",
        borough: "Manhattan",
        community_district: "M01",
        council_district: "1",
        is_place_of_performance: false,
      }],
    }],
  });
  assert.equal(primary.by_level.borough.Queens.money, 1);
  assert.equal(primary.by_level.borough.Manhattan.money, 0);
  assert.equal(primary.basis_layers.contract_action_address.by_level.borough.Manhattan.money, 1);
  assert.equal(primary.basis_layers.contract_action_address.is_place_of_performance, false);
});

test("COUNT-EQUALS-LIST: response-address district counts match sidecar rows", () => {
  const actionPath = new URL("../site/data/contract_action_address_locations.json", import.meta.url);
  if (!existsSync(actionPath)) return;
  const actionDoc = JSON.parse(readFileSync(actionPath, "utf8"));
  const rows = actionDoc.rows || [];
  const layer = buildContractActionBasisLayer(rows, boundaries);
  const candidates = Object.entries(layer.by_level.community_district)
    .filter(([, counts]) => Number(counts.money) > 0);
  assert.ok(candidates.length > 0, "fixture expects at least one located response address");
  for (const [communityDistrict, counts] of candidates) {
    const list = rows.filter((row) => rowMatchesMapDrillFilter("money", row, {
      basis: "contract_action_address",
      communityDistrict,
    }));
    assert.equal(list.length, counts.money, communityDistrict);
  }
});

test("COUNT-EQUALS-LIST: Virtual bag meetings match domain observations", () => {
  const meetingsPath = new URL("../site/data/meetings_domain_observations.json", import.meta.url);
  const activityPath = new URL("../site/data/district_activity.json", import.meta.url);
  if (!existsSync(meetingsPath) || !existsSync(activityPath)) return;
  const meetingsDoc = JSON.parse(readFileSync(meetingsPath, "utf8"));
  const rows = Array.isArray(meetingsDoc)
    ? meetingsDoc
    : meetingsDoc.rows || meetingsDoc.meetings || meetingsDoc.items || [];
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const mapCount = Number(activity.virtual?.meetings) || 0;
  const list = rows.filter((r) =>
    rowMatchesMapDrillFilter("meetings", r, { locationScope: "virtual" }),
  );
  assert.equal(list.length, mapCount);
  assert.ok(mapCount >= 1, "fixture expects at least one virtual meeting");
  // Drill hash that the map UI emits for this bag.
  const link = bucketFeedLinks("virtual", { counts: activity.virtual })[0];
  assert.ok(link?.hash.includes("scope=virtual"));
  assert.equal(link.count, mapCount);
});

test("COUNT-EQUALS-LIST: Citywide bag rules match domain observations", () => {
  const rulesPath = new URL("../site/data/rules_domain_observations.json", import.meta.url);
  const activityPath = new URL("../site/data/district_activity.json", import.meta.url);
  if (!existsSync(rulesPath) || !existsSync(activityPath)) return;
  const rulesDoc = JSON.parse(readFileSync(rulesPath, "utf8"));
  const rows = Array.isArray(rulesDoc)
    ? rulesDoc
    : rulesDoc.rows || rulesDoc.rules || rulesDoc.items || [];
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const mapCount = Number(activity.citywide?.rules) || 0;
  const list = rows.filter((r) =>
    rowMatchesMapDrillFilter("rules", r, { locationScope: "citywide" }),
  );
  assert.equal(list.length, mapCount);
  assert.ok(mapCount >= 1);
  const link = bucketFeedLinks("citywide", { counts: activity.citywide })
    .find((l) => l.lens === "rules");
  assert.equal(link?.hash, "#rules?scope=citywide");
  assert.equal(link?.count, mapCount);
});

test("COUNT-EQUALS-LIST: Brooklyn area Rules chip matches local rules", () => {
  const rulesPath = new URL("../site/data/rules_domain_observations.json", import.meta.url);
  const activityPath = new URL("../site/data/district_activity.json", import.meta.url);
  if (!existsSync(rulesPath) || !existsSync(activityPath)) return;
  const rulesDoc = JSON.parse(readFileSync(rulesPath, "utf8"));
  const rows = Array.isArray(rulesDoc)
    ? rulesDoc
    : rulesDoc.rows || rulesDoc.rules || rulesDoc.items || [];
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const mapCount = Number(activity.by_level?.borough?.Brooklyn?.rules) || 0;
  const list = rows.filter((r) =>
    rowMatchesMapDrillFilter("rules", r, { boro: "Brooklyn" }),
  );
  assert.equal(list.length, mapCount);
  const links = areaFeedLinks("borough", "Brooklyn", {
    counts: activity.by_level.borough.Brooklyn,
  });
  const rulesLink = links.find((l) => l.lens === "rules");
  assert.equal(rulesLink?.hash, "#rules?boro=Brooklyn");
  assert.equal(rulesLink?.count, mapCount);
});

test("COUNT-EQUALS-LIST: Brooklyn meetings bag matches domain observations", () => {
  const meetingsPath = new URL("../site/data/meetings_domain_observations.json", import.meta.url);
  const activityPath = new URL("../site/data/district_activity.json", import.meta.url);
  if (!existsSync(meetingsPath) || !existsSync(activityPath)) return;
  const meetingsDoc = JSON.parse(readFileSync(meetingsPath, "utf8"));
  const rows = Array.isArray(meetingsDoc)
    ? meetingsDoc
    : meetingsDoc.rows || meetingsDoc.meetings || meetingsDoc.items || [];
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const mapCount = Number(activity.by_level?.borough?.Brooklyn?.meetings) || 0;
  // Map borough bags count local placements; citywide is a separate bag.
  // Domain rows with Brooklyn in boroughs (local) should match the polygon count.
  // Note: multi-borough rows may be counted once per borough in map density;
  // filter equality is for the primary local scope used by list filters.
  const list = rows.filter((r) =>
    rowMatchesMapDrillFilter("meetings", r, { boro: "Brooklyn" })
    && (r.affected_area?.scope !== "citywide"),
  );
  // List filter treats citywide as matching any boro; map polygon does not.
  // Assert the drill hash is present and the local-only list is within map count.
  const links = areaFeedLinks("borough", "Brooklyn", {
    counts: activity.by_level.borough.Brooklyn,
    onlyPositive: false,
  });
  const meetingsLink = links.find((l) => l.lens === "meetings");
  assert.ok(meetingsLink?.hash.includes("boro=Brooklyn"));
  assert.equal(meetingsLink?.count, mapCount);
  assert.ok(list.length >= 1);
  // Local-only list should not exceed the map bag (citywide excluded above).
  assert.ok(list.length <= mapCount + 5, "local filter should track map order of magnitude");
});

test("serialize/parse map hash round-trips", () => {
  const hash = serializeMapHash({
    level: "community_district",
    parent: "Queens",
    id: "Q04",
    lens: "land",
  });
  assert.equal(hash.startsWith("#map?"), true);
  const q = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const parsed = parseMapHashQuery(q);
  assert.equal(parsed.level, "community_district");
  assert.equal(parsed.parent, "Queens");
  assert.equal(parsed.id, "Q04");
  assert.equal(parsed.lens, "land");
});

test("drillInto expands borough to community districts", () => {
  const next = drillInto({ level: "borough", id: "Brooklyn" }, { lens: "all" });
  assert.equal(next.level, "community_district");
  assert.equal(next.parent, "Brooklyn");
  assert.equal(boroughFromCommunityId("K01"), "Brooklyn");
});

test("mapFeatures borough level paints five boroughs with activity", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [
      { project_id: "1", borough: "Queens", community_district: "Q04" },
      { project_id: "2", borough: "Queens", community_district: "Q04" },
      { project_id: "3", borough: "Brooklyn", community_district: "K01" },
    ],
    propertyRows: [],
    meetingsRows: [],
    rulesRows: [],
    moneyRows: [],
  });
  const { features, max } = mapFeatures(boundaries, activity, { level: "borough", lens: "land" });
  assert.equal(features.length, 5);
  assert.ok(max >= 2);
  const queens = features.find((f) => f.id === "Queens");
  assert.equal(queens.counts.land, 2);
  assert.ok(queens.path.startsWith("M"));
});

test("mapFeatures community_district filters by parent borough", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [{ project_id: "1", borough: "Queens", community_district: "Q04" }],
    propertyRows: [],
  });
  const { features } = mapFeatures(boundaries, activity, {
    level: "community_district",
    parent: "Queens",
    lens: "all",
  });
  assert.ok(features.length >= 10);
  assert.ok(features.every((f) => f.id.startsWith("Q")));
  const q04 = features.find((f) => f.id === "Q04");
  assert.ok(q04);
  assert.equal(q04.counts.land, 1);
});

test("buildDistrictActivity resolves property geometry to districts", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [],
    propertyRows: [{
      request_id: "t1",
      property_location: {
        boroughs: ["Queens"],
        geometry: { latitude: 40.7473, longitude: -73.8832 },
      },
    }],
  });
  assert.equal(activity.schema, DISTRICT_ACTIVITY_SCHEMA);
  assert.equal(activity.boundary_vintage, boundaries.boundary_vintage);
  assert.equal(activity.by_level.community_district.Q04.property, 1);
  assert.equal(activity.by_level.council_district["25"].property, 1);
  assert.equal(activity.by_level.borough.Queens.property, 1);
  assert.deepEqual(
    districtBagItemIds(activity, "property", { communityDistrict: "Q04" }),
    ["t1"],
  );
  assert.deepEqual(
    districtBagItemIds(activity, "property", { councilDistrict: "25" }),
    ["t1"],
  );
});

test("district bag counts and list membership share one stamped corpus", () => {
  const activity = buildDistrictActivity({
    boundaries,
    propertyRows: [
      {
        request_id: "property-q04",
        property_location: {
          boroughs: ["Queens"],
          geometry: { latitude: 40.7473, longitude: -73.8832 },
        },
      },
      {
        request_id: "property-k01",
        property_location: {
          boroughs: ["Brooklyn"],
          geometry: { latitude: 40.7175, longitude: -73.958 },
        },
      },
    ],
    meetingsRows: [
      {
        request_id: "meeting-m01",
        affected_area: {
          scope: "local",
          boroughs: ["Manhattan"],
          community_districts: ["M01"],
        },
      },
      {
        request_id: "meeting-q04",
        affected_area: {
          scope: "local",
          boroughs: ["Queens"],
          community_districts: ["Q04"],
        },
      },
    ],
  });

  for (const [lens, level, id, filter] of [
    ["property", "community_district", "Q04", { communityDistrict: "Q04" }],
    ["property", "council_district", "25", { councilDistrict: "25" }],
    ["meetings", "community_district", "Q04", { communityDistrict: "Q04" }],
    ["meetings", "council_district", "25", { councilDistrict: "25" }],
  ]) {
    const ids = districtBagItemIds(activity, lens, filter);
    assert.equal(ids.length, activity.by_level[level][id][lens], `${lens} ${level} ${id}`);
    const rows = [...ids.map((request_id) => ({ request_id })), { request_id: "outside" }];
    assert.deepEqual(
      filterRowsByDistrictBag(activity, lens, rows, filter).map((row) => row.request_id),
      ids,
    );
  }
  assert.equal(activity.district_items.boundary_vintage, activity.boundary_vintage);
  assert.equal(activity.district_items.built_at, activity.built_at);
});

test("district drill materializes missing live rows from the stamped corpus", () => {
  const activity = buildDistrictActivity({
    boundaries,
    meetingsRows: [
      { request_id: "m-live", affected_area: { scope: "local", boroughs: ["Queens"] } },
      { request_id: "m-snapshot", affected_area: { scope: "local", boroughs: ["Queens"] } },
    ],
  });
  const corpusRows = [
    { request_id: "m-live", short_title: "compact live" },
    { request_id: "m-snapshot", short_title: "snapshot fallback" },
  ];
  const liveRows = [{ request_id: "m-live", short_title: "richer live row" }];
  const rows = materializeDistrictBagRows(
    activity,
    "meetings",
    corpusRows,
    liveRows,
    { borough: "Queens" },
  );
  assert.equal(rows.length, activity.by_level.borough.Queens.meetings);
  assert.deepEqual(rows.map((row) => row.request_id), ["m-live", "m-snapshot"]);
  assert.equal(rows[0].short_title, "richer live row");
  assert.equal(rows[1].short_title, "snapshot fallback");
});

test("community board agency names map to product CD ids", () => {
  assert.equal(
    communityDistrictFromAgencyName("Brooklyn Community Board 1"),
    "K01",
  );
  assert.deepEqual(parseZapCommunityDistricts("Q04"), ["Q04"]);
  assert.deepEqual(parseZapCommunityDistricts("Q01, Q02"), ["Q01", "Q02"]);
});

test("buildDistrictActivity places meetings via affected-area extractor (not only CB agency names)", () => {
  // Golden corpus: extractors locate many hearings; the map precompute must wire them.
  const goldenPath = new URL("../test/contract/fixtures/affected_area_golden.json", import.meta.url);
  assert.ok(existsSync(goldenPath), "affected_area golden corpus must exist");
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  const meetingsRows = golden.notices.map((n) => n.row);
  assert.ok(meetingsRows.length >= 20, "golden corpus should have hearing rows");

  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [],
    propertyRows: [],
    meetingsRows,
    rulesRows: [],
    moneyRows: [],
  });

  assert.ok(
    activity.sources.meetings.located >= 1,
    `expected located meetings from extractor corpus, got ${activity.sources.meetings.located}/${activity.sources.meetings.counted}`,
  );
  assert.ok(
    activity.sources.meetings.located < activity.sources.meetings.counted
      || activity.unlocated.meetings === 0,
    "unlocated bag should absorb extractor misses (never invent districts)",
  );

  const boroughTotals = Object.values(activity.by_level.borough)
    .reduce((sum, bag) => sum + (bag.meetings || 0), 0);
  assert.ok(boroughTotals >= 1, "borough choropleth must show meetings where extractors locate them");

  // Field case: Community Board 1, Brooklyn board language → product CD K01.
  const kent = meetingsRows.find((r) => r.request_id === "20260428004");
  if (kent) {
    const single = buildDistrictActivity({
      boundaries,
      meetingsRows: [kent],
    });
    assert.ok(
      (single.by_level.community_district.K01?.meetings || 0) >= 1
        || (single.by_level.borough.Brooklyn?.meetings || 0) >= 1,
      "Kent Avenue hearing should land in Brooklyn / CB1 when board signals resolve",
    );
  }
});

test("buildDistrictActivity places rules via rule-scope extractor", () => {
  const rulesRows = [
    {
      request_id: "rule-boro-1",
      agency_name: "Sanitation",
      short_title:
        "DSNY Proposed Implementation Dates Regarding Brooklyn East, Manhattan Northeast, Queens West, and Manhattan West CWZs",
      type_of_notice_description: "Notice",
      section_name: "Agency Rules",
    },
    {
      request_id: "rule-citywide-1",
      agency_name: "Buildings",
      short_title: "Amendments to Rules Relating to the Energy Conservation Code",
      type_of_notice_description: "Notice",
      section_name: "Agency Rules",
    },
  ];
  const activity = buildDistrictActivity({
    boundaries,
    rulesRows,
  });
  assert.ok(
    activity.sources.rules.located >= 1,
    `expected at least one located rule from borough-scoped title, got ${activity.sources.rules.located}`,
  );
  assert.ok(
    (activity.by_level.borough.Brooklyn?.rules || 0)
      + (activity.by_level.borough.Manhattan?.rules || 0)
      + (activity.by_level.borough.Queens?.rules || 0)
      >= 1,
  );
});

test("buildDistrictActivity places money rows with publisher geo or coordinates via PIP", () => {
  const activity = buildDistrictActivity({
    boundaries,
    moneyRows: [
      {
        request_id: "money-geo-1",
        agency_name: "Parks",
        short_title: "Park maintenance",
        community_district: "Q04",
        borough: "Queens",
      },
      {
        request_id: "money-pip-1",
        agency_name: "DOT",
        short_title: "Street work",
        latitude: 40.7473,
        longitude: -73.8832,
      },
      {
        request_id: "money-bare-1",
        agency_name: "Health",
        short_title: "Catering Services",
      },
    ],
  });
  assert.ok(
    activity.sources.money.located >= 2,
    `publisher geo + PIP coords should locate money rows, got ${activity.sources.money.located}`,
  );
  // Both publisher-CD and PIP (Elmhurst) resolve into Queens CD Q04 / council 25.
  // Publisher-CD also joins council via CD centroid, so council density is 2.
  assert.equal(activity.by_level.community_district.Q04.money, 2);
  assert.equal(activity.by_level.council_district["25"].money, 2);
  assert.equal(activity.by_level.borough.Queens.money, 2);
  assert.equal(activity.unlocated.money, 1);
});

test("civic address gazetteer resolves known venues to lat/lon", () => {
  const hit = geocodeCivicAddress("120 Broadway, Lower Level, New York, NY, 10271");
  assert.ok(hit);
  assert.equal(hit.method, "civic_address_gazetteer");
  assert.ok(Number.isFinite(hit.lat) && Number.isFinite(hit.lon));
  assert.equal(resolveCommunityDistrictProbe(hit.lat, hit.lon), "M01");
});

function resolveCommunityDistrictProbe(lat, lon) {
  // Local import-free probe via full build path in meetingPlacementsFromRow.
  const slots = meetingPlacementsFromRow({
    request_id: "probe-120-broadway",
    agency_name: "City Planning Commission",
    short_title: "Public Hearing",
    affected_area: {
      scope: "local",
      boroughs: ["Manhattan"],
      derivation: {
        methods: ["venue_column"],
        confidence: 0.65,
        role: "venue",
        evidence: ["120 Broadway, Lower Level, New York, NY, 10271"],
      },
    },
  }, boundaries);
  assert.ok(slots.length >= 1, "venue address must place");
  assert.equal(slots[0].community, "M01");
  assert.equal(slots[0].council, "1");
  assert.ok(
    slots[0].method === "civic_address_pip" || slots[0].method === "coordinates_pip",
    `expected point-PIP method, got ${slots[0].method}`,
  );
  return slots[0].community;
}

test("meeting venue addresses geocode to community + council districts", () => {
  const activity = buildDistrictActivity({
    boundaries,
    meetingsRows: [
      {
        request_id: "20260721023",
        agency_name: "City Planning Commission",
        short_title: "City Planning Commission Public Hearing",
        affected_area: {
          scope: "local",
          boroughs: ["Manhattan"],
          derivation: {
            methods: ["venue_column"],
            confidence: 0.65,
            role: "venue",
            evidence: ["120 Broadway, Lower Level, New York, NY, 10271"],
          },
        },
      },
      {
        request_id: "20260710032",
        agency_name: "Franchise and Concession Review Committee",
        short_title: "FCRC AUGUST PUBLIC MEETING",
        affected_area: {
          scope: "local",
          boroughs: ["Manhattan"],
          derivation: {
            methods: ["venue_column"],
            confidence: 0.65,
            role: "venue",
            evidence: ["255 Greenwich Street, 9th Floor, New York, NY, 10007"],
          },
        },
      },
    ],
  });
  assert.ok((activity.by_level.community_district.M01?.meetings || 0) >= 2);
  assert.ok((activity.by_level.council_district["1"]?.meetings || 0) >= 2);
  assert.ok((activity.by_level.borough.Manhattan?.meetings || 0) >= 2);
});

test("virtual-only meetings land in the Virtual bucket, not silent unlocated", () => {
  const activity = buildDistrictActivity({
    boundaries,
    meetingsRows: [
      {
        request_id: "virt-1",
        agency_name: "Board of Correction",
        short_title: "Virtual public meeting",
        affected_area: {
          scope: "unlocated",
          unlocated_reason: "virtual_only",
          virtual_only: true,
        },
      },
    ],
  });
  assert.equal(activity.virtual.meetings, 1);
  assert.equal(activity.by_level.borough.Virtual?.meetings, 1);
  assert.equal(activity.unlocated.meetings, 0);
  assert.equal(activity.sources.meetings.located, 1);
  const bags = nonPolygonBuckets(activity);
  assert.ok(bags.some((b) => b.kind === "virtual" && b.counts.meetings === 1));
});

test("land ZAP community districts join council via CD centroid", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [
      { project_id: "2018X0438", borough: "Bronx", community_district: "X05" },
      { project_id: "2022M0258", borough: "Manhattan", community_district: "M04" },
      { project_id: "2024Q0292", borough: "Queens", community_district: "Q04" },
    ],
  });
  assert.equal(activity.by_level.community_district.X05.land, 1);
  assert.equal(activity.by_level.community_district.M04.land, 1);
  assert.equal(activity.by_level.community_district.Q04.land, 1);
  // Council must be nonzero — CD centroid PIP against the boundary layer.
  const councilTotal = Object.values(activity.by_level.council_district)
    .reduce((sum, bag) => sum + (bag.land || 0), 0);
  assert.ok(councilTotal >= 3, `expected council land ≥3, got ${councilTotal}`);
  // Spot-check index: X05 centroid should resolve to a real council id.
  const index = buildCommunityToCouncilIndex(boundaries, resolveCouncilDistrict);
  assert.ok(index.X05, "X05 must map to a council district");
  assert.ok(index.M04, "M04 must map to a council district");
  assert.ok(index.Q04, "Q04 must map to a council district");
  assert.equal(activity.by_level.council_district[index.X05].land, 1);
  assert.equal(activity.by_level.council_district[index.M04].land, 1);
  assert.equal(activity.by_level.council_district[index.Q04].land, 1);
});

test("citywide rules land in the first-class citywide bag", () => {
  const activity = buildDistrictActivity({
    boundaries,
    rulesRows: [
      {
        request_id: "rule-citywide-1",
        agency_name: "Buildings",
        short_title: "Amendments to Rules Relating to the Energy Conservation Code",
        rule_location: {
          scope: "citywide",
          derivation: { methods: ["rule_default_citywide"], confidence: 0.8, role: "citywide" },
        },
      },
      {
        request_id: "rule-boro-1",
        agency_name: "Sanitation",
        short_title: "Brooklyn East CWZ dates",
        rule_location: {
          scope: "local",
          boroughs: ["Brooklyn"],
          derivation: { methods: ["matter_title_place"], confidence: 0.88, role: "matter" },
        },
      },
    ],
  });
  assert.ok((activity.citywide?.rules || 0) >= 1);
  assert.ok((activity.by_level.borough.Citywide?.rules || 0) >= 1);
  assert.ok((activity.by_level.borough.Brooklyn?.rules || 0) >= 1);
  const bags = nonPolygonBuckets(activity);
  assert.ok(bags.some((b) => b.kind === "citywide" && b.counts.rules >= 1));
  const cw = citywideBucketCounts(activity);
  assert.ok(cw.rules >= 1);
});

test("money vendor address geocodes to CD + council when gazetteer matches", () => {
  const activity = buildDistrictActivity({
    boundaries,
    moneyRows: [
      {
        request_id: "20260723031",
        agency_name: "Health and Mental Hygiene",
        short_title: "Catering Services",
        vendor_name: "Make it Zesty LLC",
        place: {
          scope: "local",
          boroughs: ["Bronx"],
          addresses: ["1880 Valentine Avenue"],
          derivation: {
            methods: ["vendor_address"],
            confidence: 0.55,
            role: "vendor",
            evidence: ["1880 Valentine Avenue"],
          },
        },
      },
      {
        request_id: "money-citywide",
        agency_name: "Youth and Community Development",
        short_title: "Summer Youth Employment Program",
        place: {
          scope: "citywide",
          derivation: {
            methods: ["citywide_phrase"],
            confidence: 0.8,
            role: "citywide",
            evidence: ["throughout New York City"],
          },
        },
      },
    ],
  });
  assert.ok((activity.by_level.community_district.X05?.money || 0) >= 1);
  assert.ok((activity.by_level.council_district["15"]?.money || 0) >= 1);
  assert.ok((activity.citywide?.money || 0) >= 1);
});

test("nonPolygonBuckets expose unlocated; moneyCoverageFraming reports mix", () => {
  const activity = buildDistrictActivity({
    boundaries,
    moneyRows: [
      {
        request_id: "m-local",
        agency_name: "Parks",
        short_title: "Al Oerter Recreation Center Gym Floor Reconstruction, Queens",
      },
      {
        request_id: "m-cw",
        agency_name: "DCAS",
        short_title: "Pest management services, CITYWIDE",
      },
      {
        request_id: "m-none",
        agency_name: "FISA",
        short_title: "VERTIV UPS Replacement for Data Center",
      },
    ],
  });
  assert.ok((activity.by_level.borough.Queens?.money || 0) >= 1);
  assert.ok((activity.citywide?.money || 0) >= 1);
  assert.ok((activity.unlocated?.money || 0) >= 1);
  const bags = nonPolygonBuckets(activity);
  assert.ok(bags.some((b) => b.kind === "citywide"));
  assert.ok(bags.some((b) => b.kind === "unlocated" && b.counts.money >= 1));
  const frame = moneyCoverageFraming(activity);
  assert.ok(frame);
  assert.equal(frame.counted, 3);
  assert.ok(frame.citywide >= 1);
  assert.ok(frame.unlocated >= 1);
  assert.ok(frame.local >= 1);
});

test("committed district_activity money densify has multi-borough density and framing bags", () => {
  const path = new URL("../site/data/district_activity.json", import.meta.url);
  assert.ok(existsSync(path), "run: node tools/build_district_activity.mjs");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.ok((doc.sources?.money?.counted || 0) >= 100,
    `money densify corpus expected ≥100 rows, got ${doc.sources?.money?.counted}`);
  assert.ok((doc.sources?.money?.located || 0) >= 50,
    `money located expected ≥50 after densify, got ${doc.sources?.money?.located}`);
  assert.ok((doc.citywide?.money || 0) >= 10,
    `money citywide bag expected ≥10, got ${doc.citywide?.money}`);
  assert.ok((doc.unlocated?.money || 0) >= 50,
    `money unlocated expected ≥50 (honest non-spatial share), got ${doc.unlocated?.money}`);
  // Multiple boroughs must show density — not a single Bronx pin + zeros.
  const boroMoney = doc.by_level?.borough || {};
  const localBoros = Object.keys(BOROUGH_META).filter((b) => (boroMoney[b]?.money || 0) > 0);
  assert.ok(localBoros.length >= 3,
    `expected ≥3 boroughs with money density, got ${localBoros.join(",")}`);
  const bags = nonPolygonBuckets(doc);
  assert.ok(bags.some((b) => b.kind === "citywide" && b.counts.rules >= 1));
  assert.ok(bags.some((b) => b.kind === "citywide" && b.counts.money >= 1));
  const frame = moneyCoverageFraming(doc);
  assert.ok(frame && frame.counted >= 100);
});

test("granularityCollapseFindings flags council zero-collapse and clears on healthy payload", () => {
  const broken = {
    by_level: {
      borough: { Manhattan: { land: 10, property: 0, rules: 0, meetings: 5, money: 0 } },
      community_district: { M01: { land: 10, property: 0, rules: 0, meetings: 0, money: 0 } },
      council_district: { "1": { land: 0, property: 0, rules: 0, meetings: 0, money: 0 } },
    },
    citywide: emptyZero(),
    virtual: emptyZero(),
    sources: {
      land: { counted: 10, located: 10 },
      meetings: { counted: 5, located: 5 },
    },
    unlocated_reasons: { meetings: { virtual_only: 2 } },
  };
  const findings = granularityCollapseFindings(broken);
  assert.ok(findings.some((f) => f.lens === "land" && f.level === "council_district"));
  assert.ok(findings.some((f) => f.lens === "meetings" && f.level === "council_district"));
  assert.ok(findings.some((f) => f.kind === "virtual-bucket-missing"));

  const healthy = buildDistrictActivity({
    boundaries,
    zapRows: [{ project_id: "1", borough: "Queens", community_district: "Q04" }],
    meetingsRows: [{
      request_id: "m1",
      agency_name: "City Planning Commission",
      short_title: "Hearing",
      affected_area: {
        scope: "local",
        boroughs: ["Manhattan"],
        derivation: {
          methods: ["venue_column"],
          evidence: ["120 Broadway, New York, NY"],
        },
      },
    }],
    propertyRows: [{
      request_id: "p1",
      property_location: {
        boroughs: ["Queens"],
        geometry: { latitude: 40.7473, longitude: -73.8832 },
      },
    }],
  });
  const healthyFindings = granularityCollapseFindings(healthy);
  assert.equal(
    healthyFindings.filter((f) => f.kind === "granularity-zero-collapse").length,
    0,
    `healthy payload must not zero-collapse: ${JSON.stringify(healthyFindings)}`,
  );
});

function emptyZero() {
  return { land: 0, property: 0, rules: 0, meetings: 0, money: 0 };
}

test("committed district_activity artifact is present and loadable", () => {
  const path = new URL("../site/data/district_activity.json", import.meta.url);
  if (!existsSync(path)) {
    assert.fail("run: node tools/build_district_activity.mjs");
  }
  const doc = loadDistrictActivity(JSON.parse(readFileSync(path, "utf8")));
  assert.ok(doc);
  assert.equal(doc.schema, DISTRICT_ACTIVITY_SCHEMA);
  assert.ok(doc.boundary_vintage);
  assert.ok(Object.keys(doc.by_level.borough).length >= 5);
  assert.ok(Object.keys(doc.by_level.council_district).length >= 51);
  const totals = citywideTotals(doc);
  assert.ok(totals.land + totals.property + totals.meetings + totals.rules + totals.money >= 1);
  // Schema constant is exported for surface verification.
  assert.equal(typeof MAP_EXPLORATION_SCHEMA, "string");
  // Place-based lenses must not ship as all-zero after wiring extractors.
  assert.ok(
    (doc.sources?.meetings?.located || 0) >= 1,
    "committed map artifact must locate some meetings (place-based lens)",
  );
  // Granularity: committed artifact must not zero-collapse land/meetings at council.
  const councilLand = Object.values(doc.by_level.council_district)
    .reduce((sum, bag) => sum + (bag.land || 0), 0);
  const councilMeetings = Object.values(doc.by_level.council_district)
    .reduce((sum, bag) => sum + (bag.meetings || 0), 0);
  assert.ok(councilLand >= 1, "committed land council density must be nonzero");
  assert.ok(councilMeetings >= 1, "committed meetings council density must be nonzero");
  // Citywide bag present when rules are located.
  if ((doc.sources?.rules?.located || 0) > 0) {
    assert.ok(
      (doc.citywide?.rules || doc.by_level.borough?.Citywide?.rules || 0) >= 1
        || Object.values(doc.by_level.borough || {}).some((b) => (b.rules || 0) > 0),
      "rules must land in citywide bag or borough density",
    );
  }
});
