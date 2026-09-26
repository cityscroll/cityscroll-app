/**
 * L05 — NTA geography filters apply before every Land query limit.
 *
 * verify: node --test test/land_nta_filter_parity.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_ADDRESS_RESULT_LIMIT,
  LAND_DEFAULT_RESULT_LIMIT,
  LAND_PLACE_MEMBERSHIP_SCHEMA_ID,
  buildLandParityReceipt,
  landCanonicalIds,
  landFilterStateFromRouteParams,
  landNtaGeographyConstraintFindings,
  landSemanticScopeFromState,
  landSnapshotQueryFromState,
  resolveLandNtaGeographyConstraint,
} from "../site/land_filter_parity.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import { landProjectRowsFromPayload } from "../site/land_project_catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-09-26";

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

const catalog = readJson("site/data/land_project_catalog.json");
const membership = readJson("site/data/land_place_membership.json");
const catalogRows = landProjectRowsFromPayload(catalog);

assert.equal(membership.schema, LAND_PLACE_MEMBERSHIP_SCHEMA_ID);
assert.ok(catalogRows.length >= 200);

const NTA = Object.freeze({
  SI0105: "geography:nta2020:SI0105",
  BK1301: "geography:nta2020:BK1301",
  BK1391: "geography:nta2020:BK1391",
  MN0401: "geography:nta2020:MN0401",
  MN0402: "geography:nta2020:MN0402",
});

function ntaMembers(ntaId) {
  const list = membership.by_geography?.nta2020?.[ntaId];
  return Array.isArray(list) ? [...list] : [];
}

/**
 * Independent full-catalog oracle: AND facets, OR NTA membership, then sort and limit.
 * Deliberately re-implements the membership join from the index rather than calling
 * filterLandSnapshot, so parity cannot share a single buggy path.
 */
function oracleLandIds(rows, {
  status = "all",
  stage = "any",
  borough = "",
  keyword = "",
  communityDistrict = "",
  councilDistrict = "",
  geographies = null,
  projectIds = null,
  placeMembership = membership,
  limit = LAND_DEFAULT_RESULT_LIMIT,
} = {}) {
  const query = String(keyword || "").replace(/\s+/g, " ").trim().toLowerCase();
  const idSet = projectIds ? new Set(projectIds) : null;
  let geographyIds = null;
  if (Array.isArray(geographies)) {
    if (!geographies.length) geographyIds = new Set();
    else {
      const constraint = resolveLandNtaGeographyConstraint(geographies, placeMembership);
      if (constraint.status === "unavailable") return Object.freeze({ status: "unavailable", ids: [] });
      geographyIds = new Set(constraint.projectIds || []);
    }
  }

  const matched = [];
  for (const row of rows) {
    if (status === "active" && String(row?.project_status || "").trim() !== "Active") continue;
    if (borough && String(row?.borough || "").trim() !== borough) continue;
    if (communityDistrict && !String(row?.community_district || "").includes(communityDistrict)) continue;
    if (councilDistrict) {
      const padded = String(councilDistrict).padStart(2, "0");
      const districts = String(row?.cc_district || "").trim();
      if (!districts || (!districts.includes(padded) && districts !== String(councilDistrict))) continue;
    }
    if (geographyIds && !geographyIds.has(row?.project_id)) continue;
    if (idSet && !idSet.has(row?.project_id)) continue;
    if (query) {
      const blob = [
        row?.project_id,
        row?.project_name,
        row?.project_brief,
        row?.borough,
        row?.community_district,
        row?.cc_district,
      ].map((value) => String(value ?? "")).join(" ").toLowerCase();
      if (!blob.includes(query)) continue;
    }
    matched.push(row);
  }

  matched.sort((left, right) => String(right?.current_milestone_date || "")
    .localeCompare(String(left?.current_milestone_date || "")));
  const ids = [];
  const seen = new Set();
  for (const row of matched.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : matched.length)) {
    const id = String(row?.project_id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze({ status: "ready", ids: Object.freeze(ids) });
}

function runLandQuery(route, {
  rows = catalogRows,
  placeMembership = membership,
  projectIds = null,
  limit,
} = {}) {
  const state = landFilterStateFromRouteParams(route);
  const query = landSnapshotQueryFromState(state, {
    today: TODAY,
    projectIds,
    placeMembership,
    limit,
  });
  const filtered = filterLandSnapshot(rows, query);
  const ids = landCanonicalIds(filtered);
  const receipt = buildLandParityReceipt({
    route: String(route),
    state,
    query,
    rows: filtered,
    listIds: ids,
    model: {
      markers: filtered.map((row) => ({ projectId: row.project_id })),
      unmapped: [],
      counts: {
        total: filtered.length,
        mapped: filtered.length,
        unmapped: 0,
      },
    },
    view: state.view,
  });
  return { state, query, rows: filtered, ids, receipt };
}

describe("land NTA geography filter parity", () => {
  it("A1 same NTA plus stage query yields identical ordered IDs across direct load and List/Map receipt", () => {
    const route = `#land?status=all&stage=any&geo=${encodeURIComponent(NTA.SI0105)}`;
    const direct = runLandQuery(route);
    const again = runLandQuery(route);
    assert.deepEqual(direct.ids, again.ids);
    assert.ok(direct.ids.includes("2026R0127"));
    assert.deepEqual(direct.receipt.list_ids, direct.ids);
    assert.deepEqual(
      [...direct.receipt.marker_ids, ...direct.receipt.unmapped_ids].sort(),
      [...direct.ids].sort(),
    );

    const semantic = landSemanticScopeFromState(direct.state);
    assert.deepEqual(semantic.geographies, [NTA.SI0105]);

    const oracle = oracleLandIds(catalogRows, {
      status: "all",
      stage: "any",
      geographies: [NTA.SI0105],
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(direct.ids, oracle.ids);
  });

  it("A1 multi-NTA OR deduplicates projects that sit in more than one selected NTA", () => {
    const route = `#land?status=all&stage=any&geo=${encodeURIComponent(NTA.BK1301)}&geo=${encodeURIComponent(NTA.BK1391)}`;
    const { ids, state } = runLandQuery(route);
    assert.deepEqual(state.geographies, [NTA.BK1301, NTA.BK1391].sort());
    assert.equal(ids.filter((id) => id === "2025K0305").length, 1);
    assert.ok(ids.includes("2025K0305"));
    assert.ok(ids.includes("2023K0398") || ntaMembers("BK1301").includes("2023K0398"));

    const union = new Set([...ntaMembers("BK1301"), ...ntaMembers("BK1391")]);
    for (const id of ids) assert.ok(union.has(id), id);

    const oracle = oracleLandIds(catalogRows, {
      status: "all",
      stage: "any",
      geographies: [NTA.BK1301, NTA.BK1391],
    });
    assert.deepEqual(ids, oracle.ids);
  });

  it("A1 cross-facet AND keeps only projects that satisfy geography and borough together", () => {
    const route = `#land?status=all&stage=any&boro=Manhattan&geo=${encodeURIComponent(NTA.MN0401)}`;
    const { ids } = runLandQuery(route);
    assert.ok(ids.includes("2023M0213"));
    for (const id of ids) {
      const row = catalogRows.find((item) => item.project_id === id);
      assert.equal(row?.borough, "Manhattan");
      assert.ok(ntaMembers("MN0401").includes(id));
    }
    const brooklynOnly = runLandQuery(
      `#land?status=all&stage=any&boro=Brooklyn&geo=${encodeURIComponent(NTA.MN0401)}`,
    );
    assert.deepEqual(brooklynOnly.ids, []);
  });

  it("A2 a qualifying project after forty unfiltered records remains eligible under area-before-limit", () => {
    const target = "2026R0127";
    const filler = catalogRows
      .filter((row) => row.project_id !== target)
      .slice(0, LAND_DEFAULT_RESULT_LIMIT);
    assert.equal(filler.length, LAND_DEFAULT_RESULT_LIMIT);
    const rows = [
      ...filler,
      catalogRows.find((row) => row.project_id === target),
    ];
    assert.equal(rows.length, LAND_DEFAULT_RESULT_LIMIT + 1);

    // Old wrong order: presentation limit first, then geography — the SI0105 project is gone.
    const truncated = rows.slice(0, LAND_DEFAULT_RESULT_LIMIT);
    assert.equal(truncated.some((row) => row.project_id === target), false);
    const withoutGeoFirst = filterLandSnapshot(truncated, {
      status: "all",
      stage: "any",
      procedure: "any",
      family: "any",
      today: TODAY,
      geographies: [NTA.SI0105],
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(withoutGeoFirst), []);

    const withGeo = filterLandSnapshot(rows, {
      status: "all",
      stage: "any",
      procedure: "any",
      family: "any",
      today: TODAY,
      geographies: [NTA.SI0105],
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(withGeo), [target]);

    const oracle = oracleLandIds(rows, {
      status: "all",
      stage: "any",
      geographies: [NTA.SI0105],
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(withGeo), oracle.ids);
  });

  it("A3 block search with no intersection and explicit NTA stays empty and does not broaden", () => {
    const blockIds = catalogRows
      .filter((row) => row.borough === "Brooklyn")
      .map((row) => row.project_id)
      .filter((id) => !ntaMembers("SI0105").includes(id))
      .slice(0, 12);
    assert.ok(blockIds.length >= 5);
    assert.equal(blockIds.includes("2026R0127"), false);

    const rows = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      projectIds: blockIds,
      geographies: [NTA.SI0105],
      placeMembership: membership,
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(rows), []);

    // The same block candidates without geography still resolve — proving emptiness is the
    // intersection, not a broken projectIds path.
    const unrestricted = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      projectIds: blockIds,
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.ok(unrestricted.length > 0);

    // land.mjs skips landNearby when geography is explicit; the query helper keeps that contract
    // by leaving an empty intersection empty rather than substituting borough scope.
    const broadened = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      borough: "Staten Island",
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.ok(broadened.some((row) => row.project_id === "2026R0127"));
    assert.equal(landCanonicalIds(rows).includes("2026R0127"), false);
  });

  it("A3 empty geography-filtered results expose a clear-area control in the Land empty state", () => {
    const landSource = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");
    const runtimeSource = readFileSync(join(ROOT, "site/land_nta_geography_runtime.mjs"), "utf8");
    assert.match(runtimeSource, /data-land-clear-area/);
    assert.match(runtimeSource, /land_clear_area/);
    assert.match(landSource, /clearLandAreaFilter/);
    assert.match(landSource, /landGeo\.broaden/);
    assert.match(landSource, /landNearby/);
    assert.match(runtimeSource, /landShouldBroadenDistrict/);
    assert.match(landSource, /import \{ landGeo \} from "\.\.\/land_nta_geography_runtime\.mjs"/);
  });

  it("A4 invalid geography keys stay invalid and never widen to all-city", () => {
    const state = landFilterStateFromRouteParams("#land?status=all&stage=any&geo=not-a-place");
    assert.deepEqual(state.geographies, []);
    const rows = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      geographies: state.geographies,
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(rows), []);

    const citywide = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      geographies: null,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.ok(citywide.length > 0);
    assert.notDeepEqual(landCanonicalIds(rows), landCanonicalIds(citywide));
  });

  it("A4 missing membership index is unavailable, not a successful empty citywide query", () => {
    const constraint = resolveLandNtaGeographyConstraint([NTA.SI0105], null);
    assert.equal(constraint.status, "unavailable");
    assert.equal(constraint.projectIds, null);

    const rows = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      geographies: [NTA.SI0105],
      placeMembership: null,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(rows), []);

    const landSource = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");
    const runtimeSource = readFileSync(join(ROOT, "site/land_nta_geography_runtime.mjs"), "utf8");
    assert.match(runtimeSource, /land_place_index_unavailable/);
    assert.match(runtimeSource, /data-land-retry-place/);
    assert.match(runtimeSource, /constraint\.status === "unavailable"/);
    assert.match(landSource, /landGeo\.showUnavailable/);
  });

  it("A4 checker reports coherent constraints and a positive-control corruption", () => {
    const ready = resolveLandNtaGeographyConstraint([NTA.SI0105], membership);
    assert.equal(ready.status, "ready");
    assert.deepEqual(landNtaGeographyConstraintFindings(ready), []);

    const invalid = resolveLandNtaGeographyConstraint(["geography:borough:3"], membership);
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(landNtaGeographyConstraintFindings(invalid), []);

    const broken = {
      status: "ready",
      keys: [NTA.SI0105],
      invalidKeys: [],
      ntaIds: ["SI0105"],
      projectIds: null,
    };
    const findings = landNtaGeographyConstraintFindings(broken);
    assert.ok(findings.includes("ready constraint missing projectIds"));
  });

  it("A5 address-branch thirtieth-candidate and lexical pre-limit survivors match the full-catalog oracle", () => {
    const target = "2026R0127";
    const addressFiller = catalogRows
      .filter((row) => row.project_id !== target)
      .map((row) => row.project_id)
      .slice(0, LAND_ADDRESS_RESULT_LIMIT);
    assert.equal(addressFiller.length, LAND_ADDRESS_RESULT_LIMIT);
    const addressCandidates = [...addressFiller, target];

    const oldAddressCut = addressCandidates.slice(0, LAND_ADDRESS_RESULT_LIMIT);
    assert.equal(oldAddressCut.includes(target), false);

    const addressRows = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      procedure: "any",
      family: "any",
      today: TODAY,
      projectIds: addressCandidates,
      geographies: [NTA.SI0105],
      placeMembership: membership,
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(addressRows), [target]);

    const addressOracle = oracleLandIds(catalogRows, {
      status: "all",
      stage: "any",
      projectIds: addressCandidates,
      geographies: [NTA.SI0105],
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(addressRows), addressOracle.ids);

    // Lexical pre-limit: old path truncated the catalog before keyword/geography, dropping the
    // matching NTA row that sits after the ordinary forty-project ceiling.
    const token = "victory";
    const lexicalTarget = catalogRows.find((row) => row.project_id === target);
    assert.match(String(lexicalTarget.project_name || "").toLowerCase(), /victory/);
    const lexicalFiller = catalogRows
      .filter((row) => row.project_id !== target)
      .map((row) => ({
        ...row,
        project_name: `${row.project_name || row.project_id} unrelated`,
        project_brief: "filler",
      }))
      .slice(0, LAND_DEFAULT_RESULT_LIMIT);
    const lexicalRows = [...lexicalFiller, lexicalTarget];
    const oldLexical = filterLandSnapshot(lexicalRows.slice(0, LAND_DEFAULT_RESULT_LIMIT), {
      status: "all",
      stage: "any",
      procedure: "any",
      family: "any",
      today: TODAY,
      keyword: token,
      geographies: [NTA.SI0105],
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.equal(oldLexical.some((row) => row.project_id === target), false);

    const lexicalFiltered = filterLandSnapshot(lexicalRows, {
      status: "all",
      stage: "any",
      procedure: "any",
      family: "any",
      today: TODAY,
      keyword: token,
      geographies: [NTA.SI0105],
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(lexicalFiltered), [target]);

    const lexicalOracle = oracleLandIds(lexicalRows, {
      status: "all",
      stage: "any",
      keyword: token,
      geographies: [NTA.SI0105],
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(lexicalFiltered), lexicalOracle.ids);
  });

  it("A1/A4 ordinary, lexical, and address branches all thread geographies through landSnapshotQueryFromState", () => {
    const state = landFilterStateFromRouteParams({
      status: "all",
      stage: "any",
      q: "park",
      geo: [NTA.MN0401, NTA.MN0402],
    });
    const ordinary = landSnapshotQueryFromState(state, {
      today: TODAY,
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    const address = landSnapshotQueryFromState(state, {
      today: TODAY,
      placeMembership: membership,
      projectIds: ["2023M0213", "nope"],
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(ordinary.geographies, [NTA.MN0401, NTA.MN0402].sort());
    assert.deepEqual(address.geographies, ordinary.geographies);
    assert.equal(ordinary.limit, LAND_DEFAULT_RESULT_LIMIT);
    assert.equal(address.limit, LAND_ADDRESS_RESULT_LIMIT);

    const ordinaryIds = landCanonicalIds(filterLandSnapshot(catalogRows, ordinary));
    const addressIds = landCanonicalIds(filterLandSnapshot(catalogRows, address));
    assert.ok(ordinaryIds.includes("2023M0213"));
    assert.deepEqual(addressIds, ["2023M0213"]);
  });
});
