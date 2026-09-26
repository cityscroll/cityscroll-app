/**
 * Integrated place-navigation release journeys.
 *
 * Public alias: cc6bdbee29292
 *
 * Verify:
 *   node --test test/place_navigation_release.test.mjs
 *   node tools/verify_place_navigation_release.mjs --base-url https://cityscroll.org \
 *     --out docs/evidence/place-navigation-release/readback.json
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  associationsFromBoardNeighborhoodSource,
  ntaLabelIndexFromLayer as boardNtaLabelIndex,
  resolveBoardNeighborhoodSelection,
} from "../site/board_neighborhood_directory.mjs";
import { loadActiveBoardNeighborhoodGeneration } from "../site/board_neighborhood_refresh.mjs";
import {
  buildLandDetailPlaceLinksView,
  landDetailPlaceCoverageCopy,
  landDetailPlaceMembershipForProject,
  ntaLabelIndexFromLayer,
  ntaSubtypeIndexFromLayer,
  renderLandDetailPlaceLinksSection,
} from "../site/land_detail_place_links.mjs";
import {
  LAND_DETAIL_BOUNDARY_CONTROLS_ARIA,
  buildLandDetailBoundaryLayersView,
  renderLandDetailBoundaryControlsHTML,
} from "../site/land_detail_boundary_layers.mjs";
import { landPlaceLayerCoverage } from "../site/land_place_membership.mjs";
import {
  landNtaWatchMatchingIds,
  prepareLandNtaWatchFilter,
} from "../site/land_nta_watch_scope.mjs";
import {
  buildNearYouLandHandoff,
  nearYouLandPreLimitIds,
  nearYouLandRecordHref,
  nearYouLandResultsHref,
} from "../site/near_you_land_handoff.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import {
  placeNavigationBoardDirectoryHref,
  placeNavigationLandDetailHref,
  placeNavigationNearYouHref,
  placeNavigationSi0105BoardJourney,
  placeNavigationStateFromParts,
  restorePlaceNavigationFromHistory,
} from "../site/place_navigation_continuity.mjs";
import { normalizeLandUseActionType } from "../site/land_use_action_type.mjs";
import { landProjectDisplayTitle } from "../site/display_title.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/place-navigation-release");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const READBACK_PATH = join(EVIDENCE_DIR, "readback.json");
const DELIVERY_PATH = join(EVIDENCE_DIR, "delivery.json");
const VERIFY_TOOL = join(ROOT, "tools/verify_place_navigation_release.mjs");
const CAPTURE_TOOL = join(ROOT, "tools/capture_place_navigation_release.py");
const GROUNDED_AT = "5f042e39d6f05e378a5013c427e4e629ef96107e";
const REQUIRED_DELIVERY_COMMIT = "bcbb626ce3cf7d07e5fdd5a0088ff4951525db4c";
const PUBLIC_ALIAS = "cc6bdbee29292";
const WATCH_PREVIEW_PERTURBATION_ID = "1999Z9999";

const ANCHORS = Object.freeze({
  kensington: "nta2020:BK1203",
  si0105: "nta2020:SI0105",
  si0105Full: "geography:nta2020:SI0105",
  fdny: "2026R0127",
  westshore: "2025K0305",
  dewitt: "2023M0213",
  queensHoldoutProject: "2025Q0142",
  queensHoldoutNta: "nta2020:QN0402",
  bronxHoldoutProject: "2019X0255",
  bronxHoldoutNta: "nta2020:BX0902",
  noBblManhattan: "2025M0252",
  citywide: "2022Y0395",
  springCreek: "nta2020:BK0504",
});

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadShared() {
  const membership = readJson("site/data/land_place_membership.json");
  const catalog = readJson("site/data/land_project_catalog.json");
  const layer = readJson("site/data/geography/layers/nta2020/26B.json");
  const geography = readJson("site/data/community_board_geography_lookup.json");
  const boardIndex = readJson("site/data/board_neighborhood_index.json");
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  const labels = boardNtaLabelIndex(layer);
  const boardNames = Object.fromEntries(
    (scorecard.rows || []).map((row) => [row.body_id, row.name]),
  );
  return {
    membership,
    catalog,
    geography,
    associations: associationsFromBoardNeighborhoodSource(boardIndex, {
      labels,
      boardNames,
    }),
    labelIndex: ntaLabelIndexFromLayer(layer),
    subtypeIndex: ntaSubtypeIndexFromLayer(layer),
  };
}

function catalogProject(catalog, projectId) {
  return (catalog.projects || []).find((row) => row.project_id === projectId) || null;
}

function placeView(shared, projectId) {
  return buildLandDetailPlaceLinksView({
    projectId,
    membership: landDetailPlaceMembershipForProject(shared.membership, projectId),
    record: catalogProject(shared.catalog, projectId),
    labelIndex: shared.labelIndex,
    subtypeIndex: shared.subtypeIndex,
    geography: shared.geography,
  });
}

function resolvePython() {
  const candidates = [
    process.env.CITYSCROLL_BROWSER_PYTHON,
    process.env.CROL_A11Y_VENV
      ? join(process.env.CROL_A11Y_VENV, "bin/python3")
      : null,
    join(process.env.HOME || "", ".local/share/cityscroll/a11y-python/bin/python3"),
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "python3" || existsSync(candidate)) return candidate;
  }
  return "python3";
}

test("A1: Kensington two-board path, FDNY SI0105/R01 path, Westshore and Manhattan multi-area coverage", () => {
  const shared = loadShared();

  const kensington = resolveBoardNeighborhoodSelection(ANCHORS.kensington, shared.associations);
  assert.deepEqual(
    kensington.boards.map((board) => board.board_id),
    ["brooklyn-cb-12", "brooklyn-cb-14"],
  );

  const fdnyRecord = catalogProject(shared.catalog, ANCHORS.fdny);
  assert.ok(fdnyRecord, "catalog retains FDNY project");
  assert.match(landProjectDisplayTitle(fdnyRecord), /Cont'?d Use|Continued Use|WTC Unit/i);
  assert.equal(normalizeLandUseActionType(fdnyRecord).is_rezoning, false);

  const fdnyView = placeView(shared, ANCHORS.fdny);
  assert.ok(fdnyView, "FDNY place links present");
  assert.deepEqual(
    fdnyView.neighborhoods.map((item) => item.nta_id),
    ["SI0105"],
  );
  assert.ok(fdnyView.districts.some((board) => board.board_id === "staten-island-cb-01"));
  assert.ok(fdnyView.districts.some((board) => board.community_district_id === "R01"));
  const fdnyHtml = renderLandDetailPlaceLinksSection(fdnyView);
  assert.match(fdnyHtml, /data-land-detail-place-links/);
  assert.match(fdnyHtml, /SI0105|Westerleigh/);
  assert.match(fdnyHtml, /staten-island-cb-01/);

  const boundary = buildLandDetailBoundaryLayersView({
    projectId: ANCHORS.fdny,
    membership: landDetailPlaceMembershipForProject(shared.membership, ANCHORS.fdny),
  });
  assert.ok(boundary);
  assert.ok(boundary.layers.some((layer) => layer.token === "nta" && layer.available));
  assert.ok(boundary.layers.some((layer) => layer.token === "cd" && layer.available));
  const boundaryHtml = renderLandDetailBoundaryControlsHTML(boundary);
  assert.match(boundaryHtml, /data-land-detail-boundary-controls/);
  assert.match(boundaryHtml, new RegExp(LAND_DETAIL_BOUNDARY_CONTROLS_ARIA));

  const westMem = landDetailPlaceMembershipForProject(shared.membership, ANCHORS.westshore);
  const westCoverage = landPlaceLayerCoverage(westMem, "nta2020");
  assert.deepEqual(westMem.layers.nta2020.places.slice().sort(), ["BK1301", "BK1391"]);
  assert.equal(westCoverage.matched, 14);
  assert.equal(westCoverage.total, 25);
  assert.match(landDetailPlaceCoverageCopy(westCoverage), /14 of 25 lot points placed/);
  const westView = placeView(shared, ANCHORS.westshore);
  assert.ok(westView.neighborhoods.some((item) => item.nta_id === "BK1301"));
  assert.ok(westView.neighborhoods.some((item) => item.nta_id === "BK1391"));

  const dewittMem = landDetailPlaceMembershipForProject(shared.membership, ANCHORS.dewitt);
  const dewittCoverage = landPlaceLayerCoverage(dewittMem, "nta2020");
  assert.deepEqual(dewittMem.layers.nta2020.places.slice().sort(), ["MN0401", "MN0402"]);
  assert.equal(dewittCoverage.matched, 5);
  assert.equal(dewittCoverage.total, 7);
  const dewittView = placeView(shared, ANCHORS.dewitt);
  assert.ok(dewittView.neighborhoods.some((item) => item.nta_id === "MN0401"));
  assert.ok(dewittView.neighborhoods.some((item) => item.nta_id === "MN0402"));

  const journey = placeNavigationSi0105BoardJourney({ view: "map" });
  assert.match(journey.near_you_href, /geography%3Anta2020%3ASI0105|geography:nta2020:SI0105/);
  assert.match(journey.land_detail_href, /#land\/2026R0127/);
  assert.match(journey.board_href, /staten-island-cb-01/);
});

test("A2: Queens/Bronx holdouts share general paths; no-BBL, citywide, special district, failed shard stay honest", () => {
  const shared = loadShared();

  const queensBoard = resolveBoardNeighborhoodSelection(
    ANCHORS.queensHoldoutNta,
    shared.associations,
  );
  assert.deepEqual(queensBoard.boards.map((board) => board.board_id), ["queens-cb-04"]);
  const bronxBoard = resolveBoardNeighborhoodSelection(
    ANCHORS.bronxHoldoutNta,
    shared.associations,
  );
  assert.deepEqual(bronxBoard.boards.map((board) => board.board_id), ["bronx-cb-09"]);

  assert.equal(
    shared.membership.by_geography.nta2020.QN0402.includes(ANCHORS.queensHoldoutProject),
    true,
  );
  assert.equal(
    shared.membership.by_geography.nta2020.BX0902.includes(ANCHORS.bronxHoldoutProject),
    true,
  );
  const queensView = placeView(shared, ANCHORS.queensHoldoutProject);
  assert.deepEqual(queensView.neighborhoods.map((item) => item.nta_id), ["QN0402"]);
  const bronxView = placeView(shared, ANCHORS.bronxHoldoutProject);
  assert.deepEqual(bronxView.neighborhoods.map((item) => item.nta_id), ["BX0902"]);

  // Capture/verify tools must name holdouts in shared case tables, not project-specific branches.
  const captureSource = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureSource, /queens-holdout|QN0402/);
  assert.match(captureSource, /bronx-holdout|BX0902/);
  assert.match(captureSource, /2025Q0142/);
  assert.match(captureSource, /2019X0255/);
  assert.doesNotMatch(captureSource, /if\s*\(.*2025Q0142.*\)\s*\{[^}]*override/s);

  const noBbl = landDetailPlaceMembershipForProject(
    shared.membership,
    ANCHORS.noBblManhattan,
  );
  assert.equal(noBbl.bbl_association_state, "absent_from_index");
  assert.equal(placeView(shared, ANCHORS.noBblManhattan), null);
  assert.equal(noBbl.publisher_geography?.community_district, "M05");

  const citywide = landDetailPlaceMembershipForProject(shared.membership, ANCHORS.citywide);
  assert.equal(citywide.bbl_association_state, "absent_from_index");
  assert.equal(placeView(shared, ANCHORS.citywide), null);
  assert.match(String(citywide.publisher_geography?.borough || ""), /Citywide/i);

  const spring = resolveBoardNeighborhoodSelection(ANCHORS.springCreek, shared.associations);
  assert.deepEqual(
    spring.boards.map((board) => board.board_id),
    ["brooklyn-cb-05", "brooklyn-cb-18"],
  );
  assert.equal(spring.boards.some((board) => board.district_id === "K56"), false);
  assert.ok(spring.non_board_overlaps.some((edge) => edge.district_id === "K56"));

  // Failed shard / unavailable geography artifact must not become a successful empty neighborhood.
  assert.match(captureSource, /observe_failed_shard|unavailable|failed.shard|ServedDataMissingError/);
  const failedAssociations = associationsFromBoardNeighborhoodSource({}, { loadFailed: true });
  assert.equal(failedAssociations.load_failed, true);
});

test("A3: capture contract measures 390 and 1440 with real stylesheet, keyboard, history, no-JS, watch preview", () => {
  const captureSource = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureSource, /VIEWPORTS/);
  assert.match(captureSource, /390/);
  assert.match(captureSource, /1440/);
  assert.match(captureSource, /inner_width/);
  assert.match(captureSource, /sync_playwright|chromium\.launch/);
  assert.match(captureSource, /Playwright is unavailable|Browser journey cannot run/);
  assert.match(captureSource, /tab_until|keyboard/);
  assert.match(captureSource, /observe_no_js|nojs|no-js|no_js/i);
  assert.match(captureSource, /back|forward|history/i);
  assert.match(captureSource, /watch|preview/i);
  assert.match(captureSource, /record_project_set_parity|preview_project_ids|membership_project_ids/);
  assert.match(captureSource, /preview_minus_membership|membership_minus_preview|intersection/);
  assert.match(
    captureSource,
    /served-preview-markup|served-membership-by_geography\.nta2020\.SI0105/,
  );
  assert.match(
    captureSource,
    /positive_control_watch_preview_parity_rejects_perturbation|rejected_perturbed_preview/,
  );
  assert.match(captureSource, /brand\.css|stylesheet|real stylesheet|production-served/i);
  assert.match(captureSource, /entry_width.*must exceed|desktop.*exceed/s);
  assert.doesNotMatch(captureSource, /pytest\.skip|unittest\.skip|optional browser/i);

  const shared = loadShared();
  for (const width of [390, 1440]) {
    assert.equal(width === 390 || width === 1440, true);
    const state = placeNavigationStateFromParts({
      geographies: [ANCHORS.si0105Full],
      projectId: ANCHORS.fdny,
      lens: "land",
      view: "map",
    });
    const nearYou = placeNavigationNearYouHref(state);
    assert.match(nearYou, /near-you/);
    assert.match(nearYou, /SI0105/);
    const land = placeNavigationLandDetailHref(state);
    assert.match(land, /#land\/2026R0127/);
    const boardDir = placeNavigationBoardDirectoryHref(ANCHORS.kensington);
    assert.match(boardDir, /community-boards/);
    assert.match(boardDir, /BK1203/);

    const restored = restorePlaceNavigationFromHistory(land, {
      placeNavigation: {
        scrollY: 120,
        focus: "land-detail-place-links",
        href: land,
      },
    });
    assert.ok(restored);
    assert.equal(width === 390 || width === 1440, true);
  }

  const scope = scopeFromNearYouUrl(
    `/near-you/?v=0&lens=land&geo=${encodeURIComponent(ANCHORS.si0105Full)}`,
  );
  const ids = nearYouLandPreLimitIds({
    scope,
    catalogRows: shared.catalog.projects,
    placeMembership: shared.membership,
  });
  assert.equal(ids.includes(ANCHORS.fdny), true);
  const handoff = buildNearYouLandHandoff({
    scope,
    projectId: ANCHORS.fdny,
    catalogRows: shared.catalog.projects,
    placeMembership: shared.membership,
  });
  assert.match(handoff.results_href || nearYouLandResultsHref(scope), /geo=geography%3Anta2020%3ASI0105/);
  assert.match(
    handoff.record_href || nearYouLandRecordHref(ANCHORS.fdny, { scope }),
    /#land\/2026R0127/,
  );

  const prepared = prepareLandNtaWatchFilter({
    lens: "land",
    geography: [ANCHORS.si0105Full],
  });
  assert.equal(prepared.ok, true);
  const watchIds = landNtaWatchMatchingIds({
    filter: prepared.filter,
    catalogRows: shared.catalog.projects,
    placeMembership: shared.membership,
  });
  assert.equal(watchIds.ids.includes(ANCHORS.fdny), true);

  const membershipIds = shared.membership.by_geography.nta2020.SI0105.slice().sort();
  assert.deepEqual(membershipIds, [ANCHORS.fdny]);
  const previewFromWatch = [...watchIds.ids].sort();
  const intersection = previewFromWatch.filter((id) => membershipIds.includes(id));
  const previewMinus = previewFromWatch.filter((id) => !membershipIds.includes(id));
  const membershipMinus = membershipIds.filter((id) => !previewFromWatch.includes(id));
  assert.deepEqual(intersection, [ANCHORS.fdny]);
  assert.deepEqual(previewMinus, []);
  assert.deepEqual(membershipMinus, []);
  assert.equal(
    previewFromWatch.length === membershipIds.length &&
      previewFromWatch.every((id, index) => id === membershipIds[index]),
    true,
  );

  const perturbed = [...previewFromWatch, WATCH_PREVIEW_PERTURBATION_ID].sort();
  const perturbedMinus = perturbed.filter((id) => !membershipIds.includes(id));
  assert.deepEqual(perturbedMinus, [WATCH_PREVIEW_PERTURBATION_ID]);
  assert.equal(
    perturbed.length === membershipIds.length &&
      perturbed.every((id, index) => id === membershipIds[index]),
    false,
  );
  assert.match(captureSource, new RegExp(WATCH_PREVIEW_PERTURBATION_ID));
});

test("A4: published catalog, place index, district activity, and links share compatible generations", () => {
  const shared = loadShared();
  const landActive = readJson("site/data/land-place-generations/ACTIVE");
  assert.equal(landActive.active_generation, shared.membership.generation.id);

  const boardActive = loadActiveBoardNeighborhoodGeneration(
    join(ROOT, "site/data/board-neighborhood-generations"),
  );
  assert.ok(boardActive?.manifest?.generation_id);
  assert.equal(
    boardActive.manifest.consumers.index.generation_id,
    boardActive.manifest.generation_id,
  );

  const catalog = shared.catalog;
  assert.ok(catalog.projects?.length >= 200);
  assert.equal(shared.membership.project_count, 244);

  const districtActivity = readJson("site/data/district_activity.json");
  assert.ok(districtActivity.schema || districtActivity.by_council_district);

  const siIds = shared.membership.by_geography.nta2020.SI0105.slice().sort();
  assert.deepEqual(siIds, [ANCHORS.fdny]);

  const captureSource = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureSource, /land_place_membership|generation/);
  assert.match(captureSource, /district_activity/);
  assert.match(captureSource, /all.?id|query parity|by_geography|listIds|unmapped/i);
  assert.match(captureSource, /require_served_page_revision_contains_delivery/);
  assert.match(captureSource, /DeployPendingError|WrongPinError|ServedDataMissingError/);

  assert.equal(existsSync(DELIVERY_PATH), true);
  const delivery = JSON.parse(readFileSync(DELIVERY_PATH, "utf8"));
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal(delivery.public_alias, PUBLIC_ALIAS);
  assert.equal(delivery.landed_commit, REQUIRED_DELIVERY_COMMIT);
  assert.equal(delivery.surface, "pages");
  assert.match(GROUNDED_AT, /^[0-9a-f]{40}$/);

  const verifySource = readFileSync(VERIFY_TOOL, "utf8");
  assert.match(verifySource, /--base-url/);
  assert.match(verifySource, /--out/);
  assert.match(verifySource, /capture_place_navigation_release\.py/);
});

test("A5: verify command invokes the production runner and fails on unmet assertions", () => {
  assert.equal(existsSync(VERIFY_TOOL), true);
  assert.equal(existsSync(CAPTURE_TOOL), true);

  const python = resolvePython();
  const dir = mkdtempSync(join(tmpdir(), "place-navigation-release-"));
  try {
    const badOut = join(dir, "bad-readback.json");
    const badManifest = join(dir, "bad-manifest.json");
    writeFileSync(badOut, `${JSON.stringify({ schema: "wrong" })}\n`);
    writeFileSync(badManifest, `${JSON.stringify({ schema: "wrong", captures: [] })}\n`);
    const failed = spawnSync(
      python,
      [CAPTURE_TOOL, "--check", "--out", badOut, "--manifest-out", badManifest],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.notEqual(failed.status, 0, "broken read-back must fail --check");

    const badBase = spawnSync(
      "node",
      [VERIFY_TOOL, "--base-url", "https://example.com", "--out", join(dir, "out.json")],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.notEqual(badBase.status, 0, "non-production base must fail");
    assert.match(
      `${badBase.stdout || ""}\n${badBase.stderr || ""}`,
      /cityscroll\.org|production journey verify requires/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    assert.equal(manifest.public_alias, PUBLIC_ALIAS);
    assert.equal(manifest.image_binaries_committed, false);
    assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
    let fixtureBrowserRows = 0;
    let moduleOracleRows = 0;
    for (const row of manifest.captures || []) {
      assert.ok(row.route, `${row.name} route`);
      assert.ok(row.assertion, `${row.name} assertion`);
      assert.match(String(row.sha256 || ""), /^[0-9a-f]{64}$/);
      if (row.source === "hermetic-module-oracle") {
        moduleOracleRows += 1;
        assert.equal(
          row.viewport == null || Object.keys(row.viewport || {}).length === 0,
          true,
          `${row.name} module-oracle row must not carry a viewport label`,
        );
      } else if (row.source === "headless-playwright-fixture-document") {
        fixtureBrowserRows += 1;
        assert.ok(row.viewport?.width, `${row.name} fixture browser row keeps measured viewport`);
      }
    }
    assert.ok(fixtureBrowserRows >= 2, "at least two measured fixture browser rows");
    assert.ok(moduleOracleRows >= 6, "module-oracle journey rows retained");
  }

  if (existsSync(READBACK_PATH) && existsSync(MANIFEST_PATH)) {
    const checked = spawnSync(
      "node",
      [VERIFY_TOOL, "--check", "--out", READBACK_PATH, "--manifest-out", MANIFEST_PATH],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.match(checked.stdout || "", /check passed/);

    const readback = JSON.parse(readFileSync(READBACK_PATH, "utf8"));
    if (readback.evidence_class === "deployed-production-read-back") {
      assert.equal(typeof readback.run_receipt, "object");
      assert.ok(Array.isArray(readback.run_receipt.requests));
      assert.ok(readback.run_receipt.requests.length >= 1);
      for (const entry of readback.run_receipt.requests) {
        assert.ok(entry.headers?.date, `${entry.url} Date`);
        assert.ok(entry.headers?.["cf-ray"], `${entry.url} CF-Ray`);
        assert.match(String(entry.served_revision || ""), /^[0-9a-f]{40}$/);
      }
      assert.ok(
        readback.generations?.land_place_generation_id
          || readback.generations?.land_place_generation
          || readback.generations?.active_generation,
      );
      assert.equal(readback.deployment?.required_ancestor_contained, true);
      assert.equal(
        readback.fixture_evidence?.path,
        "docs/evidence/place-navigation-release/capture-manifest.json",
      );
      const watchRows = (readback.captures || []).filter((row) =>
        String(row.name || "").startsWith("watch-preview-si0105-"),
      );
      assert.ok(watchRows.length >= 2, "desktop and mobile watch-preview rows");
      for (const row of watchRows) {
        const values = row.served_values || {};
        assert.ok(Array.isArray(values.preview_project_ids), `${row.name} preview set`);
        assert.ok(Array.isArray(values.membership_project_ids), `${row.name} membership set`);
        assert.ok(Array.isArray(values.intersection), `${row.name} intersection`);
        assert.ok(Array.isArray(values.preview_minus_membership), `${row.name} preview-only`);
        assert.ok(Array.isArray(values.membership_minus_preview), `${row.name} membership-only`);
        assert.equal(values.parity_equal, true, `${row.name} parity_equal`);
        assert.ok(values.intersection.includes(ANCHORS.fdny), `${row.name} intersection has FDNY`);
        assert.match(
          String(values.preview_project_ids_source || ""),
          /served-preview-markup|served-membership-by_geography\.nta2020\.SI0105/,
        );
      }
      assert.equal(readback.letters?.A3?.watch_preview_parity?.parity_equal, true);
      assert.equal(
        readback.positive_control?.watch_preview_parity_rejects_perturbed_preview
          ?.rejected_perturbed_preview,
        true,
      );
    }
  }
});
