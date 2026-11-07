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

function ntaMembers(ntaId) {
  const list = membership.by_geography?.nta2020?.[ntaId];
  return Array.isArray(list) ? [...list] : [];
}

function ntaKey(ntaId) {
  return `geography:nta2020:${ntaId}`;
}

const ALL_NTA_IDS = Object.keys(membership.by_geography?.nta2020 || {}).sort();

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

// ---------------------------------------------------------------------------
// Every specimen below is discovered by rule against the live committed
// catalog/membership (via the real query path above), not pinned to a fixed
// NTA/project id, so a refresh that rotates NTA membership does not re-break
// this file. Picks are deterministic: NTA ids sorted, first qualifying match
// taken.
// ---------------------------------------------------------------------------

/**
 * First NTA (status=all, stage=any) whose geography filter is non-empty AND
 * whose every member is query-admitted (no member rejected by the default
 * land-procedure facet), so the independent oracle -- which re-implements
 * only the membership join, not the procedure facet -- agrees with it.
 */
function findSimpleNtaSpecimen() {
  for (const ntaId of ALL_NTA_IDS) {
    const members = ntaMembers(ntaId);
    if (!members.length) continue;
    const route = `#land?status=all&stage=any&geo=${encodeURIComponent(ntaKey(ntaId))}`;
    const { ids } = runLandQuery(route);
    if (ids.length >= 1 && ids.length === members.length) return ntaId;
  }
  throw new Error("no non-empty, fully-admitted NTA specimen found in the live catalog");
}

/** First pair of NTAs with a real, query-admitted overlapping member. */
function findOverlappingNtaPair() {
  for (let i = 0; i < ALL_NTA_IDS.length; i++) {
    const a = ntaMembers(ALL_NTA_IDS[i]);
    if (!a.length) continue;
    for (let j = i + 1; j < ALL_NTA_IDS.length; j++) {
      const b = ntaMembers(ALL_NTA_IDS[j]);
      if (!b.length) continue;
      const overlap = a.filter((id) => b.includes(id));
      if (!overlap.length) continue;
      const route = `#land?status=all&stage=any&geo=${encodeURIComponent(ntaKey(ALL_NTA_IDS[i]))}&geo=${encodeURIComponent(ntaKey(ALL_NTA_IDS[j]))}`;
      const { ids } = runLandQuery(route);
      if (overlap.some((id) => ids.includes(id))) return { a: ALL_NTA_IDS[i], b: ALL_NTA_IDS[j] };
    }
  }
  throw new Error("no query-admitted overlapping NTA pair found in the live catalog");
}

/**
 * First NTA with >=1 member admitted under the given borough + default
 * facets, while a different (structurally disjoint) borough's intersection
 * with the same NTA stays empty.
 */
function findBoroughCrossNtaSpecimen(borough, disjointBorough) {
  for (const ntaId of ALL_NTA_IDS) {
    const route = `#land?status=all&stage=any&boro=${encodeURIComponent(borough)}&geo=${encodeURIComponent(ntaKey(ntaId))}`;
    const { ids } = runLandQuery(route);
    if (!ids.length) continue;
    const other = runLandQuery(
      `#land?status=all&stage=any&boro=${encodeURIComponent(disjointBorough)}&geo=${encodeURIComponent(ntaKey(ntaId))}`,
    );
    if (other.ids.length === 0) return ntaId;
  }
  throw new Error(`no cross-facet ${borough}/NTA specimen found in the live catalog`);
}

/**
 * A keyword drawn from a real admitted member's own name, chosen so that it
 * still resolves non-empty against the same NTA set under default facets.
 */
function findNtaKeywordSpecimen(ntaIds) {
  const geoParams = ntaIds.map((ntaId) => `geo=${encodeURIComponent(ntaKey(ntaId))}`).join("&");
  const base = runLandQuery(`#land?status=all&stage=any&${geoParams}`);
  for (const id of base.ids) {
    const row = catalogRows.find((item) => item.project_id === id);
    const words = String(row.project_name || "").split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4);
    for (const word of words) {
      const probe = runLandQuery(`#land?status=all&stage=any&q=${encodeURIComponent(word)}&${geoParams}`);
      if (probe.ids.length >= 1) return word.toLowerCase();
    }
  }
  throw new Error("no keyword specimen found for the given NTA set in the live catalog");
}

/** A word from a project's own name that no other catalog row's name carries. */
function uniqueNameToken(targetRow, rows) {
  const words = String(targetRow.project_name || "").split(/[^A-Za-z]+/).filter((w) => w.length >= 4);
  for (const word of words) {
    const lower = word.toLowerCase();
    const collision = rows.some(
      (row) => row.project_id !== targetRow.project_id && String(row.project_name || "").toLowerCase().includes(lower),
    );
    if (!collision) return lower;
  }
  return null;
}

/**
 * A real NTA/target/token triple: an NTA with a query-admitted member, that
 * member as the target project, a word from its own name that no other
 * catalog row's name shares (for the lexical pre-limit specimen below), no
 * OTHER member of the same NTA already sitting in the first 40 raw catalog
 * rows (so a 40-row "unfiltered filler + target" fixture resolves to exactly
 * the target under the geography filter, never a second row), and the
 * target itself surviving an ordinary borough-only (no geography) query at
 * the default limit (so broadening to its own borough still surfaces it).
 */
function findNtaTargetAndToken() {
  for (const ntaId of ALL_NTA_IDS) {
    const route = `#land?status=all&stage=any&geo=${encodeURIComponent(ntaKey(ntaId))}`;
    const direct = runLandQuery(route);
    for (const target of direct.ids) {
      const fillerIds = new Set(
        catalogRows.filter((row) => row.project_id !== target).slice(0, LAND_DEFAULT_RESULT_LIMIT).map((row) => row.project_id),
      );
      const otherMembers = ntaMembers(ntaId).filter((id) => id !== target);
      if (otherMembers.some((id) => fillerIds.has(id))) continue;
      const row = catalogRows.find((item) => item.project_id === target);
      const borough = row.borough;
      const broadened = filterLandSnapshot(catalogRows, {
        status: "all",
        stage: "any",
        today: TODAY,
        borough,
        limit: LAND_DEFAULT_RESULT_LIMIT,
      });
      if (!broadened.some((item) => item.project_id === target)) continue;
      const token = uniqueNameToken(row, catalogRows);
      if (token) return { ntaId, target, token, borough };
    }
  }
  throw new Error("no NTA/target/token specimen found in the live catalog");
}

const SIMPLE_NTA_ID = findSimpleNtaSpecimen();
const { a: OVERLAP_NTA_A, b: OVERLAP_NTA_B } = findOverlappingNtaPair();
const CROSS_BOROUGH = "Manhattan";
const CROSS_NTA_ID = findBoroughCrossNtaSpecimen(CROSS_BOROUGH, "Brooklyn");
const KEYWORD_PAIR_NTA_IDS = ["MN0401", "MN0402"];
const KEYWORD_PAIR_TOKEN = findNtaKeywordSpecimen(KEYWORD_PAIR_NTA_IDS);
const { ntaId: TARGET_NTA_ID, target: TARGET_PROJECT_ID, token: TARGET_TOKEN, borough: TARGET_BOROUGH } =
  findNtaTargetAndToken();

const NTA = Object.freeze({
  SIMPLE: ntaKey(SIMPLE_NTA_ID),
  OVERLAP_A: ntaKey(OVERLAP_NTA_A),
  OVERLAP_B: ntaKey(OVERLAP_NTA_B),
  CROSS: ntaKey(CROSS_NTA_ID),
  KEYWORD_A: ntaKey(KEYWORD_PAIR_NTA_IDS[0]),
  KEYWORD_B: ntaKey(KEYWORD_PAIR_NTA_IDS[1]),
  TARGET: ntaKey(TARGET_NTA_ID),
});

describe("land NTA geography filter parity", () => {
  it("A1 same NTA plus stage query yields identical ordered IDs across direct load and List/Map receipt", () => {
    const route = `#land?status=all&stage=any&geo=${encodeURIComponent(NTA.SIMPLE)}`;
    const direct = runLandQuery(route);
    const again = runLandQuery(route);
    assert.deepEqual(direct.ids, again.ids);
    const members = ntaMembers(SIMPLE_NTA_ID);
    assert.ok(members.length >= 1, `${SIMPLE_NTA_ID} membership must stay populated`);
    assert.ok(direct.ids.length >= 1, `${SIMPLE_NTA_ID} query must stay non-empty while membership is populated`);
    for (const id of direct.ids) {
      assert.ok(members.includes(id), `${SIMPLE_NTA_ID} result ${id} must stay inside membership`);
    }
    assert.deepEqual(direct.receipt.list_ids, direct.ids);
    assert.deepEqual(
      [...direct.receipt.marker_ids, ...direct.receipt.unmapped_ids].sort(),
      [...direct.ids].sort(),
    );

    const semantic = landSemanticScopeFromState(direct.state);
    assert.deepEqual(semantic.geographies, [NTA.SIMPLE]);

    const oracle = oracleLandIds(catalogRows, {
      status: "all",
      stage: "any",
      geographies: [NTA.SIMPLE],
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(direct.ids, oracle.ids);
  });

  it("A1 multi-NTA OR deduplicates projects that sit in more than one selected NTA", () => {
    const route = `#land?status=all&stage=any&geo=${encodeURIComponent(NTA.OVERLAP_A)}&geo=${encodeURIComponent(NTA.OVERLAP_B)}`;
    const { ids, state } = runLandQuery(route);
    assert.deepEqual(state.geographies, [NTA.OVERLAP_A, NTA.OVERLAP_B].sort());
    const overlapA = ntaMembers(OVERLAP_NTA_A);
    const overlapB = ntaMembers(OVERLAP_NTA_B);
    assert.ok(overlapA.length >= 1 && overlapB.length >= 1, `${OVERLAP_NTA_A}/${OVERLAP_NTA_B} membership must stay populated`);
    const overlap = overlapA.filter((id) => overlapB.includes(id));
    assert.ok(overlap.length >= 1, `${OVERLAP_NTA_A}∩${OVERLAP_NTA_B} overlap must stay populated for the dedup control`);
    assert.ok(ids.length >= 1, "multi-NTA OR must stay non-empty while membership is populated");
    const overlapInResults = overlap.filter((id) => ids.includes(id));
    assert.ok(overlapInResults.length >= 1, "OR union must surface at least one overlap member");
    for (const id of overlapInResults) {
      assert.equal(ids.filter((item) => item === id).length, 1, `${id} must appear once`);
    }

    const union = new Set([...overlapA, ...overlapB]);
    for (const id of ids) assert.ok(union.has(id), id);

    const oracle = oracleLandIds(catalogRows, {
      status: "all",
      stage: "any",
      geographies: [NTA.OVERLAP_A, NTA.OVERLAP_B],
    });
    assert.deepEqual(ids, oracle.ids);
  });

  it("A1 cross-facet AND keeps only projects that satisfy geography and borough together", () => {
    // The chosen NTA is discovered by rule (findBoroughCrossNtaSpecimen): it
    // must have a query-admitted member (surviving the default land-procedure
    // facet, which only admits ULURP/ELURP) inside CROSS_BOROUGH.
    const route = `#land?status=all&stage=any&boro=${encodeURIComponent(CROSS_BOROUGH)}&geo=${encodeURIComponent(NTA.CROSS)}`;
    const { ids } = runLandQuery(route);
    const members = ntaMembers(CROSS_NTA_ID);
    assert.ok(members.length >= 1, `${CROSS_NTA_ID} membership must stay populated`);
    assert.ok(ids.length >= 1, `${CROSS_BOROUGH}∩${CROSS_NTA_ID} must stay non-empty while membership is populated`);
    for (const id of ids) {
      const row = catalogRows.find((item) => item.project_id === id);
      assert.equal(row?.borough, CROSS_BOROUGH);
      assert.ok(members.includes(id));
    }
    const brooklynOnly = runLandQuery(
      `#land?status=all&stage=any&boro=Brooklyn&geo=${encodeURIComponent(NTA.CROSS)}`,
    );
    assert.deepEqual(brooklynOnly.ids, []);
  });

  it("A2 a qualifying project after forty unfiltered records remains eligible under area-before-limit", () => {
    const target = TARGET_PROJECT_ID;
    const filler = catalogRows
      .filter((row) => row.project_id !== target)
      .slice(0, LAND_DEFAULT_RESULT_LIMIT);
    assert.equal(filler.length, LAND_DEFAULT_RESULT_LIMIT);
    const rows = [
      ...filler,
      catalogRows.find((row) => row.project_id === target),
    ];
    assert.equal(rows.length, LAND_DEFAULT_RESULT_LIMIT + 1);

    // Old wrong order: presentation limit first, then geography — the target project is gone.
    const truncated = rows.slice(0, LAND_DEFAULT_RESULT_LIMIT);
    assert.equal(truncated.some((row) => row.project_id === target), false);
    const withoutGeoFirst = filterLandSnapshot(truncated, {
      status: "all",
      stage: "any",
      procedure: "any",
      family: "any",
      today: TODAY,
      geographies: [NTA.TARGET],
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
      geographies: [NTA.TARGET],
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(withGeo), [target]);

    const oracle = oracleLandIds(rows, {
      status: "all",
      stage: "any",
      geographies: [NTA.TARGET],
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(withGeo), oracle.ids);
  });

  it("A3 block search with no intersection and explicit NTA stays empty and does not broaden", () => {
    const blockIds = catalogRows
      .filter((row) => row.borough === TARGET_BOROUGH)
      .map((row) => row.project_id)
      .filter((id) => !ntaMembers(TARGET_NTA_ID).includes(id))
      .slice(0, 12);
    assert.ok(blockIds.length >= 5);
    assert.equal(blockIds.includes(TARGET_PROJECT_ID), false);

    const rows = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      projectIds: blockIds,
      geographies: [NTA.TARGET],
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
      borough: TARGET_BOROUGH,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.ok(broadened.some((row) => row.project_id === TARGET_PROJECT_ID));
    assert.equal(landCanonicalIds(rows).includes(TARGET_PROJECT_ID), false);
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
    const constraint = resolveLandNtaGeographyConstraint([NTA.TARGET], null);
    assert.equal(constraint.status, "unavailable");
    assert.equal(constraint.projectIds, null);

    const rows = filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      today: TODAY,
      geographies: [NTA.TARGET],
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
    const ready = resolveLandNtaGeographyConstraint([NTA.TARGET], membership);
    assert.equal(ready.status, "ready");
    assert.deepEqual(landNtaGeographyConstraintFindings(ready), []);

    const invalid = resolveLandNtaGeographyConstraint(["geography:borough:3"], membership);
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(landNtaGeographyConstraintFindings(invalid), []);

    const broken = {
      status: "ready",
      keys: [NTA.TARGET],
      invalidKeys: [],
      ntaIds: [TARGET_NTA_ID],
      projectIds: null,
    };
    const findings = landNtaGeographyConstraintFindings(broken);
    assert.ok(findings.includes("ready constraint missing projectIds"));
  });

  it("A5 address-branch thirtieth-candidate and lexical pre-limit survivors match the full-catalog oracle", () => {
    // TARGET_PROJECT_ID/TARGET_TOKEN are discovered by rule (findNtaTargetAndToken)
    // against the live catalog/membership, not pinned, so a refresh rotating
    // this NTA's membership does not re-break this specimen.
    const target = TARGET_PROJECT_ID;
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
      geographies: [NTA.TARGET],
      placeMembership: membership,
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(addressRows), [target]);

    const addressOracle = oracleLandIds(catalogRows, {
      status: "all",
      stage: "any",
      projectIds: addressCandidates,
      geographies: [NTA.TARGET],
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(addressRows), addressOracle.ids);

    // Lexical pre-limit: old path truncated the catalog before keyword/geography, dropping the
    // matching NTA row that sits after the ordinary forty-project ceiling.
    const token = TARGET_TOKEN;
    const lexicalTarget = catalogRows.find((row) => row.project_id === target);
    assert.match(String(lexicalTarget.project_name || "").toLowerCase(), new RegExp(token));
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
      geographies: [NTA.TARGET],
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
      geographies: [NTA.TARGET],
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(lexicalFiltered), [target]);

    const lexicalOracle = oracleLandIds(lexicalRows, {
      status: "all",
      stage: "any",
      keyword: token,
      geographies: [NTA.TARGET],
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(landCanonicalIds(lexicalFiltered), lexicalOracle.ids);
  });

  it("A1/A4 ordinary, lexical, and address branches all thread geographies through landSnapshotQueryFromState", () => {
    // KEYWORD_PAIR_TOKEN is discovered by rule (findNtaKeywordSpecimen): a
    // word drawn from a real admitted MN0401/MN0402 member's own name that
    // still resolves non-empty under the default land-procedure facet.
    const mn0401 = ntaMembers(KEYWORD_PAIR_NTA_IDS[0]);
    const mn0402 = ntaMembers(KEYWORD_PAIR_NTA_IDS[1]);
    assert.ok(mn0401.length >= 1 && mn0402.length >= 1, "MN0401/MN0402 membership must stay populated");

    const state = landFilterStateFromRouteParams({
      status: "all",
      stage: "any",
      q: KEYWORD_PAIR_TOKEN,
      geo: [NTA.KEYWORD_A, NTA.KEYWORD_B],
    });
    const ordinary = landSnapshotQueryFromState(state, {
      today: TODAY,
      placeMembership: membership,
      limit: LAND_DEFAULT_RESULT_LIMIT,
    });
    assert.deepEqual(ordinary.geographies, [NTA.KEYWORD_A, NTA.KEYWORD_B].sort());
    assert.equal(ordinary.limit, LAND_DEFAULT_RESULT_LIMIT);

    const ordinaryIds = landCanonicalIds(filterLandSnapshot(catalogRows, ordinary));
    assert.ok(ordinaryIds.length >= 1, "ordinary MN0401/MN0402 query must stay non-empty");
    for (const id of ordinaryIds) {
      assert.ok(mn0401.includes(id) || mn0402.includes(id), `${id} must stay inside MN0401∪MN0402`);
    }

    // Address branch reuses a keyword-surviving membership id so the pin tracks refresh.
    const target = ordinaryIds[0];
    const address = landSnapshotQueryFromState(state, {
      today: TODAY,
      placeMembership: membership,
      projectIds: [target, "nope"],
      limit: LAND_ADDRESS_RESULT_LIMIT,
    });
    assert.deepEqual(address.geographies, ordinary.geographies);
    assert.equal(address.limit, LAND_ADDRESS_RESULT_LIMIT);
    const addressIds = landCanonicalIds(filterLandSnapshot(catalogRows, address));
    assert.deepEqual(addressIds, [target]);
  });
});
