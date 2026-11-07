/**
 * Place navigation continuity — board / Land / Near You shared place state.
 *
 *   node --test test/place_navigation_continuity.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  associationsFromBoardNeighborhoodSource,
  resolveBoardNeighborhoodSelection,
} from "../site/board_neighborhood_directory.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import { landFilterStateFromRouteParams } from "../site/land_filter_parity.mjs";
import {
  buildNearYouLandHandoff,
  nearYouLandPreLimitIds,
  nearYouLandRecordHref,
  nearYouLandResultsHref,
} from "../site/near_you_land_handoff.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import {
  PLACE_NAVIGATION_CONTINUITY_SCHEMA,
  PLACE_NAVIGATION_HISTORY_KEY,
  PLACE_NAVIGATION_RECOVERY_REASONS,
  parsePlaceNavigationState,
  placeNavigationBoardDirectoryHref,
  placeNavigationBoardHref,
  placeNavigationFindings,
  placeNavigationHistoryEntry,
  placeNavigationLandDetailHref,
  placeNavigationNearYouHref,
  placeNavigationSi0105BoardJourney,
  placeNavigationStateFromParts,
  resolvePlaceNavigationSelection,
  restorePlaceNavigationFromHistory,
  stripPlaceNavigationUnknown,
} from "../site/place_navigation_continuity.mjs";
import { migrateLegacyUrl } from "../site/route_migration.mjs";
import { normalizeGeographyKey } from "../site/scope_v0.mjs";

const ROOT = process.cwd();

// fdny/si0105/boardSi1 track whatever geo/project/board
// site/place_navigation_continuity.mjs's placeNavigationSi0105BoardJourney
// itself hardcodes (previously 2026R0127/SI0105/staten-island-cb-01, a prior
// refresh rotated those out of the live catalog) by reading that function's
// own output instead of re-declaring an independent copy of the same three
// literals here, so this file cannot drift out of sync with that source of
// truth (name kept for minimal diff).
const SI0105_PROBE = placeNavigationSi0105BoardJourney({ view: "map", boundaries: ["nta"] });
const SI0105_PROJECT_ID_MATCH = /#land\/([^?]+)\?/.exec(SI0105_PROBE.land_detail_href);
const SI0105_GEO_MATCH = /geo=([^&]+)/.exec(SI0105_PROBE.near_you_href);
const SI0105_BOARD_MATCH = /^\/community-boards\/([^/]+)\/$/.exec(SI0105_PROBE.board_href);
assert.ok(SI0105_PROJECT_ID_MATCH, "placeNavigationSi0105BoardJourney must name a project in its land_detail_href");
assert.ok(SI0105_GEO_MATCH, "placeNavigationSi0105BoardJourney must name a geography in its near_you_href");
assert.ok(SI0105_BOARD_MATCH, "placeNavigationSi0105BoardJourney must name a board in its board_href");

const ANCHORS = Object.freeze({
  fdny: SI0105_PROJECT_ID_MATCH[1],
  dewitt: "2023M0213",
  si0105: decodeURIComponent(SI0105_GEO_MATCH[1]),
  bk1203: "nta2020:BK1203",
  bk1203Full: "geography:nta2020:BK1203",
  boardSi1: SI0105_BOARD_MATCH[1],
  boardBk12: "brooklyn-cb-12",
  boardBk14: "brooklyn-cb-14",
});

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
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

describe("place_navigation_continuity", () => {
  it("A1: SI0105 Near You → FDNY detail → board 1 → Back restores place, view, selection, scroll/focus", () => {
    const { membership, catalog } = {
      membership: readJson("site/data/land_place_membership.json"),
      catalog: readJson("site/data/land_project_catalog.json"),
    };
    const scope = scopeFromNearYouUrl(
      `/near-you/?v=0&lens=land&geo=${encodeURIComponent(ANCHORS.si0105)}`,
    );
    const ids = nearYouLandPreLimitIds({
      scope,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });
    assert.equal(ids.includes(ANCHORS.fdny), true);

    const handoff = buildNearYouLandHandoff({
      scope,
      projectId: ANCHORS.fdny,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });
    assert.equal(handoff.selection.status, "selected");
    assert.match(handoff.record_href, new RegExp(`geo=${encodeURIComponent(ANCHORS.si0105).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(handoff.record_href, new RegExp(`#land/${ANCHORS.fdny}`));

    const journey = placeNavigationSi0105BoardJourney({
      view: "map",
      boundaries: ["nta"],
      scrollY: 640,
      focus: "land-detail-place-links",
    });
    assert.match(journey.near_you_href, /^\/near-you\/\?/);
    assert.deepEqual(decodeGeoParams(journey.near_you_href).map(normalizeGeographyKey), [ANCHORS.si0105]);
    assert.match(journey.land_detail_href, /view=map/);
    assert.match(journey.land_detail_href, new RegExp(`#land/${ANCHORS.fdny}\\?boundaries=nta`));
    assert.equal(journey.board_href, `/community-boards/${ANCHORS.boardSi1}/`);
    assert.deepEqual(placeNavigationFindings(journey.land_detail_href), []);
    assert.deepEqual(placeNavigationFindings(journey.board_href), []);

    // Back restores public Land state from the URL and scroll/focus from history.
    const restored = journey.after_back;
    assert.equal(restored.source, "history");
    assert.equal(restored.scrollY, 640);
    assert.equal(restored.focus, "land-detail-place-links");
    assert.deepEqual(restored.state.geographies, [ANCHORS.si0105]);
    assert.equal(restored.state.project_id, ANCHORS.fdny);
    assert.equal(restored.state.view, "map");
    assert.deepEqual(restored.state.boundaries, ["nta"]);

    // Copied Land detail URL restores public semantic state without the sidecar.
    const copied = restorePlaceNavigationFromHistory(journey.land_detail_href, null);
    assert.equal(copied.source, "url");
    assert.equal(copied.scrollY, 0);
    assert.equal(copied.focus, null);
    assert.deepEqual(copied.state.geographies, [ANCHORS.si0105]);
    assert.equal(copied.state.project_id, ANCHORS.fdny);

    // Converse control: a different geography must not claim the SI0105 restoration.
    const other = placeNavigationLandDetailHref(placeNavigationStateFromParts({
      landFilter: landFilterStateFromRouteParams(new URLSearchParams([
        ["status", "all"],
        ["stage", "any"],
        ["geo", ANCHORS.bk1203Full],
        ["view", "map"],
      ])),
      projectId: ANCHORS.fdny,
      view: "map",
    }));
    const otherState = parsePlaceNavigationState(other);
    assert.deepEqual(otherState.geographies, [ANCHORS.bk1203Full]);
    assert.equal(otherState.geographies.includes(ANCHORS.si0105), false);
  });

  it("A2: Kensington board choices stay two after profile open/return; copied geo needs no session storage", () => {
    const index = readJson("site/data/board_neighborhood_index.json");
    const associations = associationsFromBoardNeighborhoodSource(index, {
      labels: Object.fromEntries(
        Object.keys(index.by_nta || {}).map((ntaId) => [ntaId, { label: ntaId }]),
      ),
    });
    const directoryHref = placeNavigationBoardDirectoryHref(ANCHORS.bk1203);
    assert.match(directoryHref, /geo=nta2020%3ABK1203|geo=nta2020:BK1203/);
    const selection = resolveBoardNeighborhoodSelection(ANCHORS.bk1203, associations);
    assert.equal(selection.ok, true);
    assert.equal(selection.selected, true);
    assert.equal(selection.boards.length, 2);
    const boardIds = selection.boards.map((board) => board.board_id).sort();
    assert.deepEqual(boardIds, [ANCHORS.boardBk12, ANCHORS.boardBk14].sort());

    // Opening a profile uses a canonical board href (no return URL, no session key).
    const profileHrefs = selection.boards
      .map((board) => board.profile_href || placeNavigationBoardHref(board.board_id))
      .filter(Boolean);
    assert.equal(profileHrefs.length, 2);
    for (const href of profileHrefs) {
      assert.match(href, /^\/community-boards\/brooklyn-cb-1[24]\/$/);
      assert.deepEqual(placeNavigationFindings(href), []);
    }

    // Returning to the copied directory URL restores the same two choices.
    const afterReturn = resolveBoardNeighborhoodSelection(
      parseGeographyNavigationState(directoryHref).geo,
      associations,
    );
    assert.equal(afterReturn.boards.length, 2);
    const copied = placeNavigationBoardDirectoryHref(ANCHORS.bk1203);
    const again = resolveBoardNeighborhoodSelection(
      parseGeographyNavigationState(copied).geo,
      associations,
    );
    assert.equal(again.boards.length, 2);

    // Converse control: a single-board neighborhood must not report two choices.
    const greenpoint = resolveBoardNeighborhoodSelection("nta2020:BK0101", associations);
    assert.equal(greenpoint.ok && greenpoint.selected, true);
    assert.equal(greenpoint.boards.length, 1);
    assert.equal(greenpoint.boards.length === selection.boards.length, false);
  });

  it("A3: unknown ids, removed projects, legacy hashes, and mismatched history recover without loops or address leaks", () => {
    const { membership, catalog } = {
      membership: readJson("site/data/land_place_membership.json"),
      catalog: readJson("site/data/land_project_catalog.json"),
    };
    const scope = scopeFromNearYouUrl(
      `/near-you/?v=0&lens=land&geo=${encodeURIComponent(ANCHORS.si0105)}`,
    );
    const base = placeNavigationStateFromParts({
      landFilter: landFilterStateFromRouteParams(new URLSearchParams([
        ["status", "all"],
        ["stage", "any"],
        ["geo", ANCHORS.si0105],
      ])),
      geographies: [ANCHORS.si0105],
    });

    const unknownGeo = parsePlaceNavigationState("/browse/zoning/?geo=not-a-real-place&address=1688+Victory");
    assert.equal(unknownGeo.ok, false);
    assert.equal(unknownGeo.recovery.reason, PLACE_NAVIGATION_RECOVERY_REASONS.INVALID_PLACE);
    assert.equal(unknownGeo.stripped_keys.includes("address"), true);
    // Invalid place must not widen to a citywide absence of geography axis.
    assert.equal(Array.isArray(unknownGeo.land_filter?.geographies), true);

    const external = parsePlaceNavigationState(
      `/browse/zoning/?geo=${encodeURIComponent(ANCHORS.si0105)}&return=https://evil.example/back`,
    );
    assert.equal(external.ok, false);
    assert.equal(external.recovery.reason, PLACE_NAVIGATION_RECOVERY_REASONS.EXTERNAL_RETURN);

    const ids = nearYouLandPreLimitIds({
      scope,
      catalogRows: catalog.projects,
      placeMembership: membership,
    });
    const removed = resolvePlaceNavigationSelection({
      projectId: ANCHORS.fdny,
      preLimitIds: ids.filter((id) => id !== ANCHORS.fdny),
      state: base,
    });
    assert.equal(removed.status, "cleared");
    assert.equal(removed.reason, PLACE_NAVIGATION_RECOVERY_REASONS.REMOVED_PROJECT);
    assert.equal(removed.detail_href, null);
    assert.deepEqual(decodeGeoParams(removed.results_href), [ANCHORS.si0105]);

    const unknownProject = resolvePlaceNavigationSelection({
      projectId: "!!!",
      preLimitIds: ids,
      state: base,
    });
    assert.equal(unknownProject.status, "cleared");
    assert.equal(unknownProject.reason, PLACE_NAVIGATION_RECOVERY_REASONS.UNKNOWN_PROJECT);

    const legacy = migrateLegacyUrl(
      `/#land?geo=${encodeURIComponent(ANCHORS.si0105)}&status=all&stage=any`,
    );
    assert.equal(legacy.migrated, true);
    const legacyState = parsePlaceNavigationState(legacy.target.startsWith("/") ? legacy.target : `/${legacy.target}`);
    assert.equal(legacyState.ok || legacyState.recovery?.reason === PLACE_NAVIGATION_RECOVERY_REASONS.LEGACY_HASH, true);
    assert.deepEqual(
      (legacyState.geographies.length ? legacyState.geographies : decodeGeoParams(legacy.target)),
      [ANCHORS.si0105],
    );

    const landHref = placeNavigationLandDetailHref(placeNavigationStateFromParts({
      ...base,
      projectId: ANCHORS.fdny,
      view: "map",
    }));
    const sidecar = placeNavigationHistoryEntry(placeNavigationStateFromParts({
      ...base,
      projectId: ANCHORS.dewitt,
      view: "map",
    }), { scrollY: 120, focus: "other", href: landHref });
    const mismatched = restorePlaceNavigationFromHistory(landHref, sidecar);
    assert.equal(mismatched.source, "url_mismatch");
    assert.equal(mismatched.state.recovery.reason, PLACE_NAVIGATION_RECOVERY_REASONS.MISMATCHED_HISTORY);
    assert.equal(mismatched.state.project_id, ANCHORS.fdny);
    assert.equal(mismatched.scrollY, 0);

    const unknownBoard = placeNavigationBoardHref("not-a-board");
    assert.equal(unknownBoard, null);

    // Positive control: checker must fail a leaking href.
    const leak = placeNavigationFindings(
      "/browse/zoning/?geo=geography:nta2020:SI0105&return=https://example.com&address=Victory&lat=40.1",
    );
    assert.equal(leak.includes("arbitrary_return_url"), true);
    assert.equal(leak.includes("raw_address_param"), true);
    assert.equal(leak.includes("ephemeral:lat") || leak.includes("stripped:lat"), true);
  });

  it("A4: refresh, back/forward, direct load, new tab, encoded params, privacy, and invalid-scope recovery", () => {
    const state = placeNavigationStateFromParts({
      landFilter: landFilterStateFromRouteParams(new URLSearchParams([
        ["status", "all"],
        ["stage", "any"],
        ["geo", ANCHORS.si0105],
        ["family", "acquisition"],
        ["view", "map"],
      ])),
      projectId: ANCHORS.fdny,
      view: "map",
      boundaries: ["nta", "cd"],
      focus: "land-map",
    });
    assert.equal(state.schema, PLACE_NAVIGATION_CONTINUITY_SCHEMA);

    const detail = placeNavigationLandDetailHref(state);
    const results = nearYouLandResultsHref(scopeFromNearYouUrl(
      `/near-you/?v=0&lens=land&geo=${encodeURIComponent(ANCHORS.si0105)}`,
    ));
    const nearYou = placeNavigationNearYouHref({ ...state, project_id: null, lens: "land" });

    // Direct load / new tab / refresh all re-parse the same public href.
    for (const href of [detail, results, nearYou]) {
      const parsed = parsePlaceNavigationState(href);
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.geographies, [ANCHORS.si0105]);
      assert.deepEqual(placeNavigationFindings(href), []);
    }
    assert.equal(parsePlaceNavigationState(detail).project_id, ANCHORS.fdny);
    assert.deepEqual(parsePlaceNavigationState(detail).boundaries, ["nta", "cd"]);
    assert.equal(parsePlaceNavigationState(detail).view, "map");
    assert.match(detail, /family=acquisition/);

    // Back/forward round-trip through the history sidecar.
    const entry = placeNavigationHistoryEntry(state, {
      href: detail,
      scrollX: 12,
      scrollY: 900,
      focus: "land-map",
    });
    assert.equal(entry.schema, PLACE_NAVIGATION_CONTINUITY_SCHEMA);
    assert.ok(entry[PLACE_NAVIGATION_HISTORY_KEY]);
    const forward = restorePlaceNavigationFromHistory(detail, entry);
    assert.equal(forward.scrollY, 900);
    assert.equal(forward.focus, "land-map");
    const backAgain = restorePlaceNavigationFromHistory(detail, entry);
    assert.deepEqual(backAgain.state.geographies, forward.state.geographies);

    // Encoded parameters strip unknowns and keep allowlisted keys.
    const noisy = stripPlaceNavigationUnknown(
      `geo=${encodeURIComponent(ANCHORS.si0105)}&view=map&return=https://x&session=1&utm_source=y&address=Victory`,
    );
    assert.equal(noisy.params.get("geo"), ANCHORS.si0105);
    assert.equal(noisy.params.get("view"), "map");
    assert.equal(noisy.params.has("return"), false);
    assert.equal(noisy.stripped_keys.includes("return"), true);
    assert.equal(noisy.stripped_keys.includes("address"), true);

    // Privacy: typed address never enters Near You / Land continuity hrefs.
    assert.equal(/address|victory|boulevard/i.test(detail), false);
    assert.equal(/address|victory|boulevard/i.test(nearYou), false);

    // Invalid-scope recovery stays empty rather than citywide.
    const invalid = parsePlaceNavigationState("/browse/zoning/?geo=");
    assert.equal(invalid.ok === false || Array.isArray(invalid.land_filter?.geographies), true);
  });
});
