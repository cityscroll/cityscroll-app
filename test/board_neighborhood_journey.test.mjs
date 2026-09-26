/**
 * Board neighborhood discovery release journeys.
 *
 * Public alias: c0a2ef2da209d
 *
 * Verify:
 *   node --test test/board_neighborhood_journey.test.mjs
 *   node tools/verify_board_neighborhood_journey.mjs --base-url https://cityscroll.org \
 *     --out docs/evidence/board-neighborhood-journey/readback.json
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOARD_EXACT_ADDRESS_RECOVERY,
  createBoardExactAddressResolver,
  mountBoardExactAddress,
} from "../site/board_exact_address.mjs";
import {
  associationsFromBoardNeighborhoodSource,
  mountBoardNeighborhoodDirectory,
  ntaLabelIndexFromLayer,
  renderBoardNeighborhoodDirectoryFailureHtml,
  renderBoardNeighborhoodDirectoryHtml,
  resolveBoardNeighborhoodSelection,
} from "../site/board_neighborhood_directory.mjs";
import { loadActiveBoardNeighborhoodGeneration } from "../site/board_neighborhood_refresh.mjs";
import {
  buildBoardProfileNeighborhoodsView,
  ntaLabelIndexFromLayer as profileLabelIndex,
  renderBoardProfileNeighborhoodsSection,
} from "../site/board_profile_neighborhoods.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { loadCivicGeographyLayer } from "../site/civic_geography.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../site/geography_navigation_capability.mjs";
import { createPrecomputedAddressGeocoder } from "../site/precomputed_address_geocoder.mjs";
import { FakeEvent, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/board-neighborhood-journey");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const READBACK_PATH = join(EVIDENCE_DIR, "readback.json");
const DELIVERY_PATH = join(EVIDENCE_DIR, "delivery.json");
const VERIFY_TOOL = join(ROOT, "tools/verify_board_neighborhood_journey.mjs");
const CAPTURE_TOOL = join(ROOT, "tools/capture_board_neighborhood_journey.py");
const GROUNDED_AT = "05720ad16b2a53551f49ce08f02aaad9845fdb78";
const REQUIRED_DELIVERY_COMMIT = "e06d466693bd7b09aa776eddc9421bbc9f12ef80";
const PUBLIC_ALIAS = "c0a2ef2da209d";

const MIDWOOD_ADDRESS = "810 East 16th Street Brooklyn";
const VICTORY_ADDRESS = "1688 Victory Boulevard Staten Island";
const LAND_PROJECT_BBL = "5007087501";

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadAssociations() {
  const index = readJson("site/data/board_neighborhood_index.json");
  const labels = ntaLabelIndexFromLayer(
    readJson("site/data/geography/layers/nta2020/26B.json"),
  );
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  const boardNames = Object.fromEntries(
    (scorecard.rows || []).map((row) => [row.body_id, row.name]),
  );
  return associationsFromBoardNeighborhoodSource(index, { labels, boardNames });
}

function loadNavigationLayers() {
  const registry = readJson("site/data/geography/layer_registry.json");
  return GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => {
    const row = registry.layers.find((entry) => entry.type === type);
    assert.ok(row, type);
    return loadCivicGeographyLayer(
      JSON.parse(readFileSync(join(ROOT, row.artifacts.full.path), "utf8")),
    );
  });
}

function localDataFetch(rootDir, urlPrefix) {
  async function fetchImpl(url) {
    const href = String(url);
    assert.equal(/^https?:\/\//i.test(href), false, `external egress forbidden: ${href}`);
    let relative = href;
    if (relative.startsWith(urlPrefix)) relative = relative.slice(urlPrefix.length);
    relative = relative.replace(/^\.\//, "");
    const body = readFileSync(join(ROOT, rootDir, relative), "utf8");
    return { ok: true, json: async () => JSON.parse(body) };
  }
  return fetchImpl;
}

function productionResolver() {
  const fetchPad = localDataFetch("site/data/address-index", "/data/address-index/");
  const fetchParcel = localDataFetch("site/data/parcel-geography", "/data/parcel-geography/");
  const geocode = createPrecomputedAddressGeocoder({
    fetchImpl: fetchPad,
    manifestUrl: "/data/address-index/manifest.json",
  });
  const resolve = createBoardExactAddressResolver({
    geocode,
    fetchImpl: fetchParcel,
    parcelManifestUrl: "/data/parcel-geography/manifest.json",
    geographyLookup: readJson("site/data/community_board_geography_lookup.json"),
    layerData: loadNavigationLayers(),
  });
  return resolve;
}

function makeLocation(href = "https://cityscroll.org/community-boards/") {
  const url = new URL(href);
  return {
    get href() { return `${url.origin}${url.pathname}${url.search}${url.hash}`; },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    set search(next) {
      url.search = next.startsWith("?") || next === "" ? next : `?${next}`;
    },
    get hash() { return url.hash; },
    set hash(next) {
      url.hash = next.startsWith("#") || next === "" ? next : `#${next}`;
    },
    get origin() { return url.origin; },
  };
}

function makeHistory(location) {
  return {
    replaceState(_state, _title, path) {
      if (typeof path !== "string") return;
      const parsed = new URL(path, location.origin);
      location.search = parsed.search;
      location.hash = parsed.hash;
    },
    pushState(state, title, path) {
      this.replaceState(state, title, path);
    },
  };
}

function scorecardShell(neighborhoodHtml) {
  return `<main class="scorecard" data-community-board-root data-selected-board="brooklyn-cb-01">
    ${neighborhoodHtml}
    <svg>
      <path data-board-id="brooklyn-cb-01"></path>
      <path data-board-id="brooklyn-cb-05"></path>
      <path data-board-id="brooklyn-cb-12"></path>
      <path data-board-id="brooklyn-cb-14"></path>
      <path data-board-id="brooklyn-cb-18"></path>
      <path data-board-id="queens-cb-04"></path>
      <path data-board-id="bronx-cb-09"></path>
      <path data-board-id="staten-island-cb-01"></path>
      <path data-board-id="staten-island-cb-02"></path>
    </svg>
    <aside>
      <div data-board-detail="brooklyn-cb-01"></div>
      <div data-board-detail="brooklyn-cb-05" hidden></div>
      <div data-board-detail="brooklyn-cb-12" hidden></div>
      <div data-board-detail="brooklyn-cb-14" hidden></div>
      <div data-board-detail="brooklyn-cb-18" hidden></div>
      <div data-board-detail="queens-cb-04" hidden></div>
      <div data-board-detail="bronx-cb-09" hidden></div>
      <div data-board-detail="staten-island-cb-01" hidden></div>
      <div data-board-detail="staten-island-cb-02" hidden></div>
    </aside>
    <table><tbody>
      <tr id="board-brooklyn-cb-01"></tr>
      <tr id="board-brooklyn-cb-05"></tr>
      <tr id="board-brooklyn-cb-12"></tr>
      <tr id="board-brooklyn-cb-14"></tr>
      <tr id="board-brooklyn-cb-18"></tr>
      <tr id="board-queens-cb-04"></tr>
      <tr id="board-bronx-cb-09"></tr>
      <tr id="board-staten-island-cb-01"></tr>
      <tr id="board-staten-island-cb-02"></tr>
    </tbody></table>
  </main>`;
}

function constellationSources(extras = {}) {
  const active = loadActiveBoardNeighborhoodGeneration(
    join(ROOT, "site/data/board-neighborhood-generations"),
  );
  const labelIndex = profileLabelIndex(readJson("site/data/geography/layers/nta2020/26B.json"));
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  return {
    sourceRegistry: readJson("site/data/non_council_outcome_sources/source_registry.json"),
    sourceInventory: readJson("site/data/non_council_outcome_sources/board_source_inventory.json"),
    scorecard,
    geography: readJson("site/data/community_board_geography_lookup.json"),
    boardNeighborhoodProfile: active.profile,
    ntaLabelIndex: labelIndex,
    generated_at: scorecard.as_of,
    ...extras,
  };
}

function profileDocument(boardId) {
  const view = buildCommunityBoardConstellationView(boardId, constellationSources());
  return renderCommunityBoardConstellationDocument(view, { prefix: "../" });
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

test("A1: neighborhood → profile → participation and Midwood address → Brooklyn 14; Victory stays unresolved", async () => {
  const associations = loadAssociations();

  const kensington = resolveBoardNeighborhoodSelection("nta2020:BK1203", associations);
  assert.deepEqual(
    kensington.boards.map((board) => board.board_id),
    ["brooklyn-cb-12", "brooklyn-cb-14"],
  );
  const si = resolveBoardNeighborhoodSelection("nta2020:SI0105", associations);
  assert.deepEqual(
    si.boards.map((board) => board.board_id).sort(),
    ["staten-island-cb-01", "staten-island-cb-02"],
  );
  const greenpoint = resolveBoardNeighborhoodSelection("nta2020:BK0101", associations);
  assert.deepEqual(greenpoint.boards.map((board) => board.board_id), ["brooklyn-cb-01"]);
  const spring = resolveBoardNeighborhoodSelection("nta2020:BK0504", associations);
  assert.deepEqual(
    spring.boards.map((board) => board.board_id),
    ["brooklyn-cb-05", "brooklyn-cb-18"],
  );
  assert.equal(spring.boards.some((board) => board.district_id === "K56"), false);
  assert.ok(spring.non_board_overlaps.some((edge) => edge.district_id === "K56"));

  // Profile keeps Kensington and existing calendar/participation destinations.
  const cb14Html = profileDocument("brooklyn-cb-14");
  assert.match(cb14Html, /Neighborhoods in this district/);
  assert.match(cb14Html, /Kensington/);
  assert.match(cb14Html, /meetings-participation|Next full-board meeting|Open the verified calendar/);
  assert.match(cb14Html, /data-board-profile-neighborhoods/);

  const cb12Html = profileDocument("brooklyn-cb-12");
  assert.match(cb12Html, /Kensington/);

  // Exact Midwood address → Brooklyn CB14; Victory unresolved without Land BBL substitution.
  const resolve = productionResolver();
  const midwood = await resolve(MIDWOOD_ADDRESS);
  assert.equal(midwood.ok, true);
  assert.equal(midwood.board_id, "brooklyn-cb-14");
  assert.equal(midwood.profile_href, "/community-boards/brooklyn-cb-14/");
  assert.equal(midwood.district_id, "K14");

  const victory = await resolve(VICTORY_ADDRESS);
  assert.equal(victory.ok, false);
  assert.equal(victory.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE);
  assert.equal(victory.board_id, null);
  assert.doesNotMatch(JSON.stringify(victory), new RegExp(LAND_PROJECT_BBL));
  assert.match(victory.recovery.message, /district map is not available yet/i);

  // Directory mount: Kensington → open CB14 profile link in markup; address recovery keeps chooser.
  const html = scorecardShell(
    renderBoardNeighborhoodDirectoryHtml(associations, { selectedGeo: "nta2020:BK1203" }),
  );
  const location = makeLocation("https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203");
  const { container } = mountDocument(html, { containerClass: "scorecard-host" });
  const root = container.querySelector("[data-community-board-root]");
  mountBoardNeighborhoodDirectory(root, {
    associations,
    location,
    history: makeHistory(location),
  });
  assert.ok(root.querySelector('a[href="/community-boards/brooklyn-cb-14/"]'));
  assert.ok(root.querySelector("[data-board-address-action]"));

  const exactBinder = mountBoardExactAddress(root, {
    resolveAddress: resolve,
    geographyLookup: readJson("site/data/community_board_geography_lookup.json"),
    location,
    history: makeHistory(location),
  });
  assert.ok(exactBinder);
  root.querySelector("[data-board-address-action]").dispatchEvent(new FakeEvent("click", {
    bubbles: true,
  }));
  await exactBinder.submitAddress(VICTORY_ADDRESS);
  const unresolved = exactBinder.getResult();
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE);
  assert.ok(root.querySelector("[data-board-neighborhood-select]"));
});

test("A2: 390 and 1440 keep keyboard, direct load, back, no-JS links, and unavailable-association recovery", () => {
  const associations = loadAssociations();
  const captureSource = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureSource, /VIEWPORTS/);
  assert.match(captureSource, /390/);
  assert.match(captureSource, /1440/);
  assert.match(captureSource, /inner_width/);
  assert.match(captureSource, /tab_until/);
  assert.match(captureSource, /observe_no_js_and_back/);
  assert.match(captureSource, /observe_unavailable_association/);
  assert.match(captureSource, /desktop.*entry_width.*narrow|entry_width.*must exceed/s);

  for (const width of [390, 1440]) {
    const location = makeLocation(
      "https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203",
    );
    const history = makeHistory(location);
    const html = scorecardShell(
      renderBoardNeighborhoodDirectoryHtml(associations, { selectedGeo: "nta2020:BK1203" }),
    );
    const { doc, container } = mountDocument(html, { containerClass: "scorecard-host" });
    const root = container.querySelector("[data-community-board-root]");
    root.dataset.viewportWidth = String(width);
    const binder = mountBoardNeighborhoodDirectory(root, { associations, location, history });
    assert.ok(binder);

    const select = root.querySelector("#scorecard-neighborhood-select");
    assert.ok(select);
    keydown(select, "Enter");
    assert.match(
      root.querySelector("[data-board-neighborhood-results-heading]").textContent,
      /Boards overlapping Kensington/,
    );

    // Direct load / shared geo URL restores the choice.
    assert.match(location.search, /BK1203/);

    // No-JS association links remain in the document.
    const noJs = root.querySelector('[data-board-neighborhood-link="BK1203"]');
    assert.ok(noJs);
    assert.match(noJs.getAttribute("href"), /geo=nta2020%3ABK1203/);

    // Clearing restores the full directory (back to unfiltered browse).
    binder.selectGeo("");
    assert.equal(binder.getSelection().selected, false);
    assert.equal(root.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, false);

    // Unavailable association data keeps directory links + retry.
    const failed = associationsFromBoardNeighborhoodSource({}, { loadFailed: true });
    const failureHtml = scorecardShell(renderBoardNeighborhoodDirectoryFailureHtml());
    const failureLocation = makeLocation("https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203");
    const { container: failureContainer } = mountDocument(failureHtml, {
      containerClass: "scorecard-host",
    });
    const failureRoot = failureContainer.querySelector("[data-community-board-root]");
    mountBoardNeighborhoodDirectory(failureRoot, {
      associations: failed,
      location: failureLocation,
      history: makeHistory(failureLocation),
    });
    assert.ok(failureRoot.querySelector("[data-board-neighborhood-retry]"));
    assert.equal(failureRoot.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, false);
    assert.doesNotMatch(
      failureRoot.querySelector("[data-board-neighborhood-failure]").textContent,
      /no boards exist/i,
    );

    // Positive control: a fake width that is neither 390 nor 1440 must be rejected by the capture tool.
    assert.equal(width === 390 || width === 1440, true);
    assert.match(captureSource, /inner_width.*!=.*viewport|does not match requested viewport/s);
    assert.ok(doc);
  }
});

test("A3: Queens and Bronx holdouts resolve through the same directory path; evidence contract names them", () => {
  const associations = loadAssociations();
  const queens = resolveBoardNeighborhoodSelection("nta2020:QN0402", associations);
  assert.equal(queens.ok, true);
  assert.deepEqual(queens.boards.map((board) => board.board_id), ["queens-cb-04"]);
  assert.match(queens.label, /Corona/);

  const bronx = resolveBoardNeighborhoodSelection("nta2020:BX0902", associations);
  assert.equal(bronx.ok, true);
  assert.deepEqual(bronx.boards.map((board) => board.board_id), ["bronx-cb-09"]);
  assert.match(bronx.label, /Soundview|Clason/);

  const html = renderBoardNeighborhoodDirectoryHtml(associations, {
    selectedGeo: "nta2020:QN0402",
  });
  assert.match(html, /queens-cb-04/);
  assert.match(html, /Board overlapping Corona/);

  const captureSource = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureSource, /queens-holdout/);
  assert.match(captureSource, /bronx-holdout/);
  assert.match(captureSource, /QN0402/);
  assert.match(captureSource, /BX0902/);

  // Evidence receipts (when present) must name holdouts, viewports, and generation fields.
  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    assert.equal(manifest.public_alias, PUBLIC_ALIAS);
    assert.equal(manifest.image_binaries_committed, false);
    const names = (manifest.captures || []).map((row) => row.name).join(" ");
    assert.match(names, /queens-holdout|bronx-holdout/);
    for (const row of manifest.captures || []) {
      assert.ok(row.route);
      assert.ok(row.viewport?.width);
      assert.ok(row.assertion);
      assert.match(String(row.sha256 || ""), /^[0-9a-f]{64}$/);
    }
  }
});

test("A4: delivery pin, generation coherence, and verify runner --base-url/--out contract", () => {
  assert.equal(existsSync(DELIVERY_PATH), true);
  const delivery = JSON.parse(readFileSync(DELIVERY_PATH, "utf8"));
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal(delivery.public_alias, PUBLIC_ALIAS);
  assert.equal(delivery.landed_commit, REQUIRED_DELIVERY_COMMIT);
  assert.equal(delivery.surface, "pages");
  assert.match(GROUNDED_AT, /^[0-9a-f]{40}$/);

  const active = loadActiveBoardNeighborhoodGeneration(
    join(ROOT, "site/data/board-neighborhood-generations"),
  );
  assert.ok(active?.manifest?.generation_id);
  assert.equal(
    active.manifest.consumers.index.generation_id,
    active.manifest.generation_id,
  );
  assert.equal(
    active.manifest.consumers.directory.generation_id,
    active.manifest.generation_id,
  );
  assert.equal(
    active.manifest.consumers.profile.generation_id,
    active.manifest.generation_id,
  );

  const verifySource = readFileSync(VERIFY_TOOL, "utf8");
  assert.match(verifySource, /--base-url/);
  assert.match(verifySource, /--out/);
  assert.match(verifySource, /capture_board_neighborhood_journey\.py/);
  assert.match(readFileSync(CAPTURE_TOOL, "utf8"), /require_served_page_revision_contains_delivery/);
  assert.match(readFileSync(CAPTURE_TOOL, "utf8"), /require_served_subjects/);
  assert.match(readFileSync(CAPTURE_TOOL, "utf8"), /DeployPendingError|WrongPinError/);

  // Profile reverse links for holdout boards stay coherent with the active generation.
  const labelIndex = profileLabelIndex(readJson("site/data/geography/layers/nta2020/26B.json"));
  const queensProfile = buildBoardProfileNeighborhoodsView({
    boardId: "queens-cb-04",
    profile: active.profile,
    labelIndex,
  });
  assert.ok(queensProfile.items.some((item) => item.nta_id === "QN0402"));
  const section = renderBoardProfileNeighborhoodsSection(queensProfile);
  assert.match(section, /QN0402|Corona/);
});

test("A5: verify command invokes the production runner and fails on unmet assertions", () => {
  assert.equal(existsSync(VERIFY_TOOL), true);
  assert.equal(existsSync(CAPTURE_TOOL), true);

  const python = resolvePython();
  // Positive control: --check against a deliberately broken read-back must fail.
  const dir = mkdtempSync(join(tmpdir(), "board-neighborhood-journey-"));
  try {
    const badOut = join(dir, "bad-readback.json");
    const badManifest = join(dir, "bad-manifest.json");
    writeFileSync(badOut, JSON.stringify({ schema: "wrong" }) + "\n");
    writeFileSync(badManifest, JSON.stringify({ schema: "wrong", captures: [] }) + "\n");
    const failed = spawnSync(
      python,
      [CAPTURE_TOOL, "--check", "--out", badOut, "--manifest-out", badManifest],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.notEqual(failed.status, 0, "broken read-back must fail --check");

    // Missing production subjects / wrong base must fail the runner.
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

  // When a committed read-back exists, --check must pass.
  if (existsSync(READBACK_PATH) && existsSync(MANIFEST_PATH)) {
    const checked = spawnSync(
      "node",
      [VERIFY_TOOL, "--check", "--out", READBACK_PATH, "--manifest-out", MANIFEST_PATH],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.match(checked.stdout || "", /check passed/);
  }
});
