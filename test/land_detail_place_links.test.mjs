/**
 * Land detail place links — neighborhoods and boards from published lots.
 *
 *   node --test test/land_detail_place_links.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceActionRole,
} from "../site/affordance_grammar.mjs";
import { communityBoardIdFromCommunityDistrict } from "../site/community_board_geography.mjs";
import { normalizeLandUseActionType } from "../site/land_use_action_type.mjs";
import {
  LAND_DETAIL_PLACE_LINKS_HEADING,
  LAND_DETAIL_PLACE_LINKS_NOTE,
  LAND_DETAIL_PLACE_LINKS_SCHEMA,
  buildLandDetailPlaceLinksView,
  landDetailPlaceLinksFindings,
  landDetailPlaceMembershipForProject,
  landDetailPlaceCoverageCopy,
  ntaLabelIndexFromLayer,
  ntaNearYouHref,
  ntaSubtypeIndexFromLayer,
  ntaSubtypeKindLabel,
  renderLandDetailPlaceLinksSection,
} from "../site/land_detail_place_links.mjs";
import { landPlaceLayerCoverage } from "../site/land_place_membership.mjs";
import { landProjectPath } from "../site/land_project_route.mjs";
import { landProjectDisplayTitle } from "../site/display_title.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import { normalizeGeographyKey } from "../site/scope_v0.mjs";

const ROOT = process.cwd();

// fdny (2026R0127), dewitt (2023M0213), and noBblManhattan (2025M0252) were
// the prior specimens until a refresh retired them from the live ZAP
// catalog (westshore, 2025K0305, stays valid: it only left the 40-row
// Default Land snapshot, not the full admitted catalog this file reads).
// 2019M0059 (single-NTA MN0401/M04), 2024K0444 (multi-NTA BK1301+BK1391,
// partial coverage), and 2025M0399 (Manhattan, no retained BBL) replace
// them with the same membership shapes.
const ANCHORS = Object.freeze({
  fdny: "2019M0059",
  westshore: "2025K0305",
  dewitt: "2024K0444",
  noBblManhattan: "2025M0399",
  citywide: "2022Y0395",
});

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadCatalogProject(projectId) {
  const catalog = readJson("site/data/land_project_catalog.json");
  const projects = Array.isArray(catalog.projects) ? catalog.projects : [];
  return projects.find((row) => row.project_id === projectId) || null;
}

function loadShared() {
  const index = readJson("site/data/land_place_membership.json");
  const layer = readJson("site/data/geography/layers/nta2020/26B.json");
  const geography = readJson("site/data/community_board_geography_lookup.json");
  return {
    index,
    geography,
    labelIndex: ntaLabelIndexFromLayer(layer),
    subtypeIndex: ntaSubtypeIndexFromLayer(layer),
  };
}

function viewFor(projectId, shared = loadShared()) {
  const membership = landDetailPlaceMembershipForProject(shared.index, projectId);
  const record = loadCatalogProject(projectId);
  return buildLandDetailPlaceLinksView({
    projectId,
    membership,
    record,
    labelIndex: shared.labelIndex,
    subtypeIndex: shared.subtypeIndex,
    geography: shared.geography,
  });
}

function assertRestoresNtaKey(href, ntaId) {
  assert.ok(href, `missing href for ${ntaId}`);
  const state = parseGeographyNavigationState(href);
  assert.equal(state.ok, true, `geo state not ok for ${href}`);
  assert.equal(state.type, "nta2020");
  assert.equal(state.id, ntaId);
  assert.equal(state.key, `geography:nta2020:${ntaId}`);
  assert.equal(normalizeGeographyKey(state.key), `geography:nta2020:${ntaId}`);
}

function nativeAnchors(html) {
  return [...String(html).matchAll(/<a\b([^>]*)>/g)].map((match) => match[1]);
}

describe("land_detail_place_links", () => {
  it("A1: FDNY-replacement names Chelsea-Hudson Yards, Manhattan board 4, and single-area identity", () => {
    const shared = loadShared();
    const record = loadCatalogProject(ANCHORS.fdny);
    assert.ok(record, "catalog retains the fdny-replacement project");

    const view = viewFor(ANCHORS.fdny, shared);
    assert.ok(view, "fdny-replacement physical membership present");
    assert.equal(view.schema, LAND_DETAIL_PLACE_LINKS_SCHEMA);
    assert.equal(view.heading, LAND_DETAIL_PLACE_LINKS_HEADING);
    assert.equal(view.project_path, landProjectPath(ANCHORS.fdny));

    const nta = view.neighborhoods.find((item) => item.nta_id === "MN0401");
    assert.ok(nta, "MN0401 membership retained");
    assert.match(nta.label, /Chelsea-Hudson Yards/);
    assert.equal(nta.subtype, "residential");
    assert.equal(nta.kind_label, "Neighborhood");
    assertRestoresNtaKey(nta.href, "MN0401");
    assert.match(nta.href, /lens=land/);

    const district = view.districts.find((item) => item.community_district_id === "M04");
    assert.ok(district, "M04 lot membership retained");
    assert.match(district.district_label, /Manhattan Community District 4/);
    assert.equal(district.board_id, "manhattan-cb-04");
    assert.equal(
      district.board_id,
      communityBoardIdFromCommunityDistrict("M04", shared.geography),
    );
    assert.equal(district.board_href, "/community-boards/manhattan-cb-04/");
    assert.match(district.board_label, /Manhattan Community Board 4/);

    const mnMembers = shared.index?.by_geography?.nta2020?.MN0401 || [];
    assert.ok(mnMembers.length >= 1, "MN0401 membership must stay populated");
    assert.ok(mnMembers.includes(ANCHORS.fdny), "fdny-replacement anchor must remain inside MN0401 membership");

    const html = renderLandDetailPlaceLinksSection(view);
    assert.match(html, /Chelsea-Hudson Yards/);
    assert.match(html, /Manhattan Community Board 4/);
    assert.ok(
      html.includes(`data-project-path="${view.project_path}"`),
      "place-links markup must carry the rendered project path",
    );
    assert.deepEqual(landDetailPlaceLinksFindings(view, { html }), []);
  });

  it("A2: Westshore and Dewitt expose multi-area memberships with partial coverage", () => {
    const shared = loadShared();

    const westMembership = landDetailPlaceMembershipForProject(shared.index, ANCHORS.westshore);
    const westCoverage = landPlaceLayerCoverage(westMembership, "nta2020");
    assert.equal(westCoverage.fraction, "14/25");
    assert.equal(landDetailPlaceCoverageCopy(westCoverage), "14 of 25 lot points placed");

    const west = viewFor(ANCHORS.westshore, shared);
    assert.ok(west);
    const westIds = west.neighborhoods.map((item) => item.nta_id).sort();
    assert.deepEqual(westIds, ["BK1301", "BK1391"]);
    const gravesend = west.neighborhoods.find((item) => item.nta_id === "BK1301");
    const park = west.neighborhoods.find((item) => item.nta_id === "BK1391");
    assert.ok(gravesend);
    assert.equal(park.label, "Calvert Vaux Park");
    assert.equal(park.subtype, "park");
    assert.equal(park.kind_label, "Park");
    assert.equal(park.is_special_use, true);
    assert.equal(park.may_label_as_neighborhood, false);
    assert.equal(ntaSubtypeKindLabel("park"), "Park");
    assertRestoresNtaKey(gravesend.href, "BK1301");
    assertRestoresNtaKey(park.href, "BK1391");
    assert.equal(west.coverage.fraction, "14/25");
    assert.equal(west.coverage.copy, "14 of 25 lot points placed");

    const westHtml = renderLandDetailPlaceLinksSection(west);
    assert.match(westHtml, /data-nta-id="BK1301"/);
    assert.match(westHtml, /Calvert Vaux Park/);
    assert.match(westHtml, /data-geography-special-use="true"/);
    assert.match(westHtml, /14 of 25 lot points placed/);
    assert.match(westHtml, /data-land-place-coverage="14\/25"/);

    const dewittMembership = landDetailPlaceMembershipForProject(shared.index, ANCHORS.dewitt);
    const dewittCoverage = landPlaceLayerCoverage(dewittMembership, "nta2020");
    assert.equal(dewittCoverage.fraction, "13/25");

    const dewitt = viewFor(ANCHORS.dewitt, shared);
    assert.ok(dewitt);
    const dewittIds = dewitt.neighborhoods.map((item) => item.nta_id).sort();
    assert.deepEqual(dewittIds, ["BK1301", "BK1391"]);
    assert.equal(
      dewitt.neighborhoods.find((item) => item.nta_id === "BK1301").label,
      "Gravesend (South)",
    );
    assert.equal(
      dewitt.neighborhoods.find((item) => item.nta_id === "BK1391").label,
      "Calvert Vaux Park",
    );
    assert.equal(dewitt.coverage.fraction, "13/25");
    assert.equal(dewitt.coverage.copy, "13 of 25 lot points placed");

    const dewittHtml = renderLandDetailPlaceLinksSection(dewitt);
    assert.match(dewittHtml, /Gravesend/);
    assert.match(dewittHtml, /Calvert Vaux Park/);
    assert.match(dewittHtml, /13 of 25 lot points placed/);
  });

  it("A3: no-BBL projects keep publisher districts without fabricated neighborhoods", () => {
    const shared = loadShared();

    for (const projectId of [ANCHORS.noBblManhattan, ANCHORS.citywide]) {
      const membership = landDetailPlaceMembershipForProject(shared.index, projectId);
      assert.ok(membership, `${projectId} membership row present`);
      assert.equal(membership.bbl_association_state, "absent_from_index");
      assert.deepEqual(membership.layers.nta2020.places, []);
      assert.deepEqual(membership.layers.community_district.places, []);

      const view = buildLandDetailPlaceLinksView({
        projectId,
        membership,
        record: loadCatalogProject(projectId),
        labelIndex: shared.labelIndex,
        subtypeIndex: shared.subtypeIndex,
        geography: shared.geography,
      });
      assert.equal(view, null, `${projectId} must not invent physical places`);
      assert.equal(renderLandDetailPlaceLinksSection(view), "");
    }

    const manhattan = landDetailPlaceMembershipForProject(shared.index, ANCHORS.noBblManhattan);
    assert.equal(manhattan.publisher_geography.community_district, "M06");
    assert.equal(manhattan.publisher_geography.borough, "Manhattan");

    const citywide = landDetailPlaceMembershipForProject(shared.index, ANCHORS.citywide);
    assert.equal(citywide.publisher_geography.borough, "Citywide");
    assert.equal(citywide.publisher_geography.community_district, null);

    // Boundary: physical membership copy never becomes impact or authority.
    assert.match(LAND_DETAIL_PLACE_LINKS_NOTE, /not a claim of project impact or board review authority/i);

    const forged = {
      schema: LAND_DETAIL_PLACE_LINKS_SCHEMA,
      project_id: ANCHORS.noBblManhattan,
      project_path: landProjectPath(ANCHORS.noBblManhattan),
      heading: LAND_DETAIL_PLACE_LINKS_HEADING,
      note: LAND_DETAIL_PLACE_LINKS_NOTE,
      association_kind: "published_project_lot",
      bbl_association_state: "absent_from_index",
      neighborhoods: [{
        nta_id: "MN0501",
        key: "geography:nta2020:MN0501",
        label: "Invented",
        href: ntaNearYouHref("MN0501"),
        subtype: "residential",
        kind_label: "Neighborhood",
        is_special_use: false,
        may_label_as_neighborhood: true,
      }],
      districts: [],
      publisher_geography: manhattan.publisher_geography,
      coverage: null,
      evidence_shard: null,
      source_dates: null,
      publisher_note: "",
    };
    const forgedFindings = landDetailPlaceLinksFindings(forged, {
      html: renderLandDetailPlaceLinksSection(forged) + " this shows the project impact",
    });
    assert.ok(
      forgedFindings.includes("no-bbl project fabricated physical place membership"),
      `expected fabrication finding, got ${JSON.stringify(forgedFindings)}`,
    );
    assert.ok(
      forgedFindings.includes("place-links claims project impact or board review authority"),
      `expected impact-claim finding, got ${JSON.stringify(forgedFindings)}`,
    );
  });

  it("A4: destinations are real anchors with navigate roles; publisher stays separate from lots", () => {
    const shared = loadShared();
    const view = viewFor(ANCHORS.fdny, shared);
    const html = renderLandDetailPlaceLinksSection(view);
    assert.match(html, /data-land-detail-place-links="1"/);
    assert.match(html, new RegExp(LAND_DETAIL_PLACE_LINKS_HEADING));

    const anchors = nativeAnchors(html);
    assert.ok(anchors.length >= 2, "NTA and board anchors present");
    for (const attrs of anchors) {
      assert.match(attrs, /\bhref="/);
      assert.doesNotMatch(attrs, /\btarget="/);
      const href = attrs.match(/\bhref="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
      assert.equal(affordanceActionRole({ href }), AFFORDANCE_ACTION_ROLES.navigate, href);
    }

    // Keyboard: native anchors remain in-tab stops (no tabindex=-1).
    assert.doesNotMatch(html, /tabindex="-1"/);

    // Publisher-versus-lot separation: publisher geography is retained on the
    // model but the physical section lists only lot-derived places.
    assert.equal(view.publisher_geography.community_district, "M04");
    assert.equal(view.publisher_geography.borough, "Manhattan");
    assert.match(html, /Publisher-reported districts stay in Where above/);
    assert.doesNotMatch(html, /data-land-record-place=/);
    // Resident HTML must not leak implementation schema tokens into disclosure.
    assert.doesNotMatch(html, /published_project_lot/);
    assert.doesNotMatch(html, /pluto_25v4/);

    // Complete coverage omits the partial-coverage sentence.
    assert.equal(view.coverage.copy, null);
    assert.doesNotMatch(html, /lot points placed/);

    assert.deepEqual(landDetailPlaceLinksFindings(view, { html }), []);
  });
});
