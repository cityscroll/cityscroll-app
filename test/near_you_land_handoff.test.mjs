/**
 * Near You → Land handoff — same neighborhood membership and supported facets.
 *
 *   node --test test/near_you_land_handoff.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceActionRole,
} from "../site/affordance_grammar.mjs";
import {
  landFilterStateFromRouteParams,
  landFilterStateToSearchParams,
  landSnapshotQueryFromState,
  landCanonicalIds,
} from "../site/land_filter_parity.mjs";
import {
  NEAR_YOU_LAND_HANDOFF_SCHEMA,
  buildNearYouLandHandoff,
  landFilterStateFromNearYouScope,
  nearYouLandHandoffFindings,
  nearYouLandNtaKeysFromScope,
  nearYouLandPreLimitIds,
  nearYouLandRecordHref,
  nearYouLandResultsHref,
  nearYouLandReturnHref,
  resolveNearYouLandSelection,
} from "../site/near_you_land_handoff.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import {
  buildNearYouViewModel,
  renderNearYouBody,
  renderNearYouDeferredBody,
} from "../site/near_you_view.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import { migrateLegacyUrl } from "../site/route_migration.mjs";
import { normalizeGeographyKey, scopeWithGeographies } from "../site/scope_v0.mjs";

const ROOT = process.cwd();

const ANCHORS = Object.freeze({
  fdny: "2026R0127",
  dewitt: "2023M0213",
  noBbl: "2025M0252",
  citywide: "2022Y0395",
  si0105: "geography:nta2020:SI0105",
  mn0401: "geography:nta2020:MN0401",
  mn0402: "geography:nta2020:MN0402",
});

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadShared() {
  return {
    membership: readJson("site/data/land_place_membership.json"),
    catalog: readJson("site/data/land_project_catalog.json"),
    activity: readJson("site/data/district_activity.json"),
  };
}

function scopeFor(...geoKeys) {
  const params = new URLSearchParams({ v: "0", lens: "land" });
  for (const key of geoKeys) params.append("geo", key);
  return scopeFromNearYouUrl(`/near-you/?${params}`);
}

function decodeGeoParams(href) {
  const url = new URL(href, "https://cityscroll.org");
  return url.searchParams.getAll("geo").map((value) => {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  });
}

describe("near_you_land_handoff", () => {
  it("A1: SI0105 opens Land with 2026R0127 eligible; either Manhattan NTA keeps 2023M0213 once", () => {
    const { membership, catalog } = loadShared();
    const rows = catalog.projects;

    const siScope = scopeFor(ANCHORS.si0105);
    const siIds = nearYouLandPreLimitIds({
      scope: siScope,
      catalogRows: rows,
      placeMembership: membership,
    });
    assert.equal(siIds.includes(ANCHORS.fdny), true);
    assert.equal(siIds.includes(ANCHORS.noBbl), false);
    assert.equal(siIds.includes(ANCHORS.citywide), false);
    assert.deepEqual(
      decodeGeoParams(nearYouLandResultsHref(siScope)),
      [ANCHORS.si0105],
    );

    const mn0401Ids = nearYouLandPreLimitIds({
      scope: scopeFor(ANCHORS.mn0401),
      catalogRows: rows,
      placeMembership: membership,
    });
    const mn0402Ids = nearYouLandPreLimitIds({
      scope: scopeFor(ANCHORS.mn0402),
      catalogRows: rows,
      placeMembership: membership,
    });
    assert.equal(mn0401Ids.filter((id) => id === ANCHORS.dewitt).length, 1);
    assert.equal(mn0402Ids.filter((id) => id === ANCHORS.dewitt).length, 1);

    const bothIds = nearYouLandPreLimitIds({
      scope: scopeFor(ANCHORS.mn0401, ANCHORS.mn0402),
      catalogRows: rows,
      placeMembership: membership,
    });
    assert.equal(bothIds.filter((id) => id === ANCHORS.dewitt).length, 1);

    // Converse control: a geography-less handoff must not claim the SI0105 singleton.
    const citywideIds = nearYouLandPreLimitIds({
      scope: scopeFromNearYouUrl("/near-you/?v=0&lens=land"),
      catalogRows: rows,
      placeMembership: membership,
    });
    assert.equal(citywideIds.length > siIds.length, true);
    assert.equal(siIds.length, 1);
  });

  it("A2: copied, new-tab, and no-JS destinations keep NTA scope without address or return URLs", () => {
    const scope = scopeFor(ANCHORS.si0105);
    const resultsHref = nearYouLandResultsHref(scope);
    const recordHref = nearYouLandRecordHref(ANCHORS.fdny);
    const returnHref = nearYouLandReturnHref(scope);

    assert.match(resultsHref, /^\/browse\/zoning\/\?/);
    assert.deepEqual(decodeGeoParams(resultsHref), [ANCHORS.si0105]);
    assert.match(resultsHref, /status=all/);
    assert.match(resultsHref, /stage=any/);
    assert.equal(recordHref, `/browse/zoning/#land/${ANCHORS.fdny}`);
    assert.match(returnHref, /^\/near-you\/\?/);
    assert.match(returnHref, /lens=land/);
    assert.deepEqual(
      decodeGeoParams(returnHref).map(normalizeGeographyKey),
      [ANCHORS.si0105],
    );

    // Legacy hash migration must forward geo (and family) onto the document route.
    const migrated = migrateLegacyUrl(
      `/#land?geo=${encodeURIComponent(ANCHORS.si0105)}&status=all&stage=any&family=acquisition`,
    );
    assert.equal(migrated.migrated, true);
    assert.deepEqual(decodeGeoParams(migrated.target), [ANCHORS.si0105]);
    assert.match(migrated.target, /family=acquisition/);
    assert.equal((migrated.unsupported || []).includes("geo"), false);

    const findings = nearYouLandHandoffFindings({
      resultsHref,
      recordHref,
      returnHref,
      state: landFilterStateFromNearYouScope(scope),
      ntaKeys: nearYouLandNtaKeysFromScope(scope),
    });
    assert.deepEqual(findings, []);

    // Positive control: the checker must fail a leaking destination.
    const leakFindings = nearYouLandHandoffFindings({
      resultsHref: "/browse/zoning/?geo=geography:community_district:R01&return=https://example.com/x&address=1688+Victory",
      recordHref: "https://evil.example/land",
      returnHref: "https://example.com/back",
    });
    assert.equal(leakFindings.includes("results:nta_converted_to_community_district"), true);
    assert.equal(leakFindings.includes("results:arbitrary_return_url"), true);
    assert.equal(leakFindings.includes("results:raw_address_param"), true);
    assert.equal(leakFindings.includes("record:external_destination"), true);
    assert.equal(leakFindings.includes("return_href_not_near_you"), true);

    // NTA keys stay NTA keys even when a CD is also present on the Near You scope.
    const withCd = scopeWithGeographies(scope, [
      ANCHORS.si0105,
      "geography:community_district:R01",
    ]);
    assert.deepEqual(nearYouLandNtaKeysFromScope(withCd), [ANCHORS.si0105]);
    const state = landFilterStateFromNearYouScope(withCd);
    assert.equal(state.communityDistrict, "");
    assert.deepEqual(state.geographies, [ANCHORS.si0105]);
  });

  it("A3: removing the selected project clears selection and keeps a Near You return path", () => {
    const { membership, catalog } = loadShared();
    const scope = scopeFor(ANCHORS.si0105);
    const ids = nearYouLandPreLimitIds({
      scope,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });

    const kept = resolveNearYouLandSelection({
      projectId: ANCHORS.fdny,
      preLimitIds: ids,
      scope,
    });
    assert.equal(kept.status, "selected");
    assert.equal(kept.project_id, ANCHORS.fdny);
    assert.equal(kept.record_href, nearYouLandRecordHref(ANCHORS.fdny));

    const withoutFdny = ids.filter((id) => id !== ANCHORS.fdny);
    const cleared = resolveNearYouLandSelection({
      projectId: ANCHORS.fdny,
      preLimitIds: withoutFdny,
      scope,
      population: Math.max(withoutFdny.length, 1),
    });
    assert.equal(cleared.status, "cleared");
    assert.equal(cleared.project_id, null);
    assert.equal(cleared.record_href, null);
    assert.equal(cleared.reason, "project_out_of_scope");
    assert.match(cleared.return_href, /^\/near-you\/\?/);
    assert.deepEqual(decodeGeoParams(cleared.return_href).map(normalizeGeographyKey), [ANCHORS.si0105]);
    // Cleared selection must not invent a substitute project id.
    assert.equal(cleared.results_href.includes(ANCHORS.dewitt), false);
    assert.equal(cleared.results_href.includes("#land/"), false);

    const packet = buildNearYouLandHandoff({
      scope,
      projectId: ANCHORS.noBbl,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });
    assert.equal(packet.schema, NEAR_YOU_LAND_HANDOFF_SCHEMA);
    assert.equal(packet.selection.status, "cleared");
    assert.equal(packet.selection.reason, "project_out_of_scope");
    assert.match(packet.return_href, /lens=land/);
  });

  it("A4: encoded facets, pre-limit ID sets, direct load, and modified-click anchors agree", () => {
    const { membership, catalog, activity } = loadShared();
    const scope = scopeWithGeographies(
      {
        facets: {
          domains: ["land"],
          values: {
            family: "acquisition",
            regulatoryEffect: "unknown",
            stage: "any",
            status: "all",
          },
        },
      },
      [ANCHORS.si0105],
    );

    const state = landFilterStateFromNearYouScope(scope);
    assert.equal(state.family, "acquisition");
    assert.equal(state.stage, "any");
    assert.equal(state.status, "all");
    assert.deepEqual(state.geographies, [ANCHORS.si0105]);

    const params = landFilterStateToSearchParams(state);
    const roundTrip = landFilterStateFromRouteParams(params);
    assert.equal(roundTrip.family, "acquisition");
    assert.deepEqual(roundTrip.geographies, [ANCHORS.si0105]);

    const href = nearYouLandResultsHref(scope);
    const fromHref = landFilterStateFromRouteParams(href);
    assert.equal(fromHref.family, "acquisition");
    assert.deepEqual(fromHref.geographies, [ANCHORS.si0105]);

    const preLimit = nearYouLandPreLimitIds({
      state,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });
    const limitedQuery = landSnapshotQueryFromState(state, {
      placeMembership: membership,
      limit: 40,
    });
    const limitedIds = landCanonicalIds(filterLandSnapshot(catalog.projects, limitedQuery));
    // Pre-limit set is the authority; the display limit may only drop trailing rows.
    for (const id of limitedIds) assert.equal(preLimit.includes(id), true);
    assert.equal(preLimit.includes(ANCHORS.fdny), true);

    const landHref = `/near-you/?v=0&lens=land&geo=${encodeURIComponent(ANCHORS.si0105)}&surface=records`;
    const landScope = scopeFromNearYouUrl(landHref);
    const geographyState = parseGeographyNavigationState(landHref);
    const view = buildNearYouViewModel(landScope, activity, {}, { geographyState });
    assert.match(view.browseHref, /^\/browse\/zoning\/\?/);
    assert.deepEqual(decodeGeoParams(view.browseHref), [ANCHORS.si0105]);

    const fdny = (view.results?.records || []).find((row) => row.id === ANCHORS.fdny);
    assert.ok(fdny, "SI0105 land results must include 2026R0127");
    assert.equal(fdny.route, nearYouLandRecordHref(ANCHORS.fdny));
    assert.equal(affordanceActionRole({ href: fdny.route }), AFFORDANCE_ACTION_ROLES.navigate);
    assert.equal(affordanceActionRole({ href: view.browseHref }), AFFORDANCE_ACTION_ROLES.navigate);

    const body = renderNearYouBody(view);
    assert.match(body, /href="\/browse\/zoning\/\?[^"]*geo=geography%3Anta2020%3ASI0105/);
    const deferred = renderNearYouDeferredBody(view);
    // Inspect remains a button; Land results and full-record destinations are real anchors.
    assert.match(deferred, /<button[^>]*class="[^"]*near-record-inspect/);
    assert.match(deferred, /href="\/browse\/zoning\/#land\/2026R0127"/);
    assert.match(body, /<a[^>]*href="\/browse\/zoning\/\?/);

    const packet = buildNearYouLandHandoff({
      scope: landScope,
      projectId: ANCHORS.fdny,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });
    assert.deepEqual(nearYouLandHandoffFindings(packet), []);
    assert.equal(packet.selection.status, "selected");
    assert.deepEqual(
      packet.pre_limit_ids,
      nearYouLandPreLimitIds({
        scope: landScope,
        catalogRows: catalog.projects,
        placeMembership: membership,
      }),
    );
  });
});
