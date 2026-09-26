/**
 * Exact-address board choice on the community-boards directory.
 *
 *   node --test test/board_exact_address.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOARD_EXACT_ADDRESS_RECOVERY,
  BOARD_EXACT_ADDRESS_SCHEMA,
  boardExactAddressPayloadLeaksEphemeral,
  boardExactAddressPublicProjection,
  createBoardExactAddressResolver,
  mountBoardExactAddress,
  renderBoardExactAddressPanelHtml,
  resolveExactBoardFromGeographyEntry,
} from "../site/board_exact_address.mjs";
import {
  associationsFromBoardNeighborhoodSource,
  mountBoardNeighborhoodDirectory,
  ntaLabelIndexFromLayer,
  renderBoardNeighborhoodDirectoryHtml,
  resolveBoardNeighborhoodSelection,
} from "../site/board_neighborhood_directory.mjs";
import {
  createPrecomputedAddressGeocoder,
} from "../site/precomputed_address_geocoder.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  geographyEntryRecoveryResult,
} from "../site/geography_navigation_entry.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../site/geography_navigation_capability.mjs";
import { loadCivicGeographyLayer } from "../site/civic_geography.mjs";
import { FakeEvent, mountDocument } from "./helpers/preview_dom.mjs";

const ROOT = process.cwd();
const MODULE_SOURCE = readFileSync(join(ROOT, "site/board_exact_address.mjs"), "utf8");
const DIRECTORY_SOURCE = readFileSync(join(ROOT, "site/board_neighborhood_directory.mjs"), "utf8");
const APP_SOURCE = readFileSync(join(ROOT, "site/app/community-board-scorecard.mjs"), "utf8");
const LAND_PROJECT_BBL = "5007087501";
const VICTORY_PAD_BBL = "5007081001";
const MIDWOOD_PAD_BBL = "3066990010";

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function localDataFetch(rootDir, urlPrefix) {
  const requested = [];
  async function fetchImpl(url) {
    const href = String(url);
    requested.push(href);
    assert.equal(/^https?:\/\//i.test(href), false, `external egress forbidden: ${href}`);
    let relative = href;
    if (relative.startsWith(urlPrefix)) relative = relative.slice(urlPrefix.length);
    relative = relative.replace(/^\.\//, "");
    const body = await readFileAsync(join(ROOT, rootDir, relative), "utf8");
    return {
      ok: true,
      json: async () => JSON.parse(body),
    };
  }
  return { fetchImpl, requested };
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

const LAYER_DATA = loadNavigationLayers();
const GEOGRAPHY_LOOKUP = readJson("site/data/community_board_geography_lookup.json");

function productionResolver() {
  const pad = localDataFetch("site/data/address-index", "/data/address-index/");
  const parcel = localDataFetch("site/data/parcel-geography", "/data/parcel-geography/");
  const geocode = createPrecomputedAddressGeocoder({
    fetchImpl: pad.fetchImpl,
    manifestUrl: "/data/address-index/manifest.json",
  });
  const resolve = createBoardExactAddressResolver({
    geocode,
    fetchImpl: parcel.fetchImpl,
    parcelManifestUrl: "/data/parcel-geography/manifest.json",
    geographyLookup: GEOGRAPHY_LOOKUP,
    layerData: LAYER_DATA,
  });
  return { resolve, geocode, pad, parcel };
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

function makeLocation(href = "https://cityscroll.org/community-boards/") {
  const url = new URL(href);
  return {
    get href() {
      return `${url.origin}${url.pathname}${url.search}${url.hash}`;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    set search(next) {
      url.search = next.startsWith("?") || next === "" ? next : `?${next}`;
    },
    get hash() {
      return url.hash;
    },
    set hash(next) {
      url.hash = next.startsWith("#") || next === "" ? next : `#${next}`;
    },
    get origin() {
      return url.origin;
    },
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
      <path data-board-id="brooklyn-cb-12"></path>
      <path data-board-id="brooklyn-cb-14"></path>
      <path data-board-id="brooklyn-cb-15"></path>
      <path data-board-id="brooklyn-cb-18"></path>
      <path data-board-id="staten-island-cb-01"></path>
      <path data-board-id="staten-island-cb-02"></path>
    </svg>
    <aside>
      <div data-board-detail="brooklyn-cb-14" hidden></div>
      <div data-board-detail="staten-island-cb-01" hidden></div>
      <div data-board-detail="staten-island-cb-02" hidden></div>
    </aside>
    <table><tbody>
      <tr id="board-brooklyn-cb-14"><th>Brooklyn Community Board 14</th></tr>
      <tr id="board-staten-island-cb-01"><th>Staten Island Community Board 1</th></tr>
      <tr id="board-staten-island-cb-02"><th>Staten Island Community Board 2</th></tr>
    </tbody></table>
  </main>`;
}

test("A1: Midwood address resolves to Brooklyn CB14; SI0105 area still offers boards 1 and 2", async () => {
  const { resolve, geocode } = productionResolver();
  const associations = loadAssociations();

  const pad = await geocode("810 East 16th Street Brooklyn");
  assert.equal(pad.status, "matched");
  assert.equal(pad.bbl, MIDWOOD_PAD_BBL);

  const midwood = await resolve("810 East 16th Street Brooklyn");
  assert.equal(midwood.ok, true);
  assert.equal(midwood.schema, BOARD_EXACT_ADDRESS_SCHEMA);
  assert.equal(midwood.district_id, "K14");
  assert.equal(midwood.nta_id, "BK1403");
  assert.equal(midwood.board_id, "brooklyn-cb-14");
  assert.match(midwood.board_name, /Brooklyn Community Board 14/);
  assert.equal(midwood.profile_href, "/community-boards/brooklyn-cb-14/");
  assert.equal(midwood.share.hash, "#board-brooklyn-cb-14");
  assert.equal(midwood.place_details.membership_method, "parcel_membership");

  // Area lookup remains independent of the exact parcel choice.
  const si = resolveBoardNeighborhoodSelection("nta2020:SI0105", associations);
  assert.equal(si.ok, true);
  assert.equal(si.selected, true);
  const siBoards = si.boards.map((board) => board.board_id).sort();
  assert.deepEqual(siBoards, ["staten-island-cb-01", "staten-island-cb-02"]);
});

test("A2: PAD ambiguity exposes a count only; unavailable parcel geography never chooses the leading NTA board", async () => {
  const { resolve, geocode } = productionResolver();
  const associations = loadAssociations();

  const broadway = await geocode("250 Broadway");
  assert.equal(broadway.status, "unknown");
  assert.equal(broadway.reason, "ambiguous");
  assert.ok(Number.isInteger(broadway.candidate_count) && broadway.candidate_count > 1);
  assert.equal(Object.hasOwn(broadway, "candidates"), false);
  assert.equal(Object.hasOwn(broadway, "candidate_identities"), false);
  assert.equal(Object.hasOwn(broadway, "bbls"), false);

  const ambiguous = await resolve("250 Broadway");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.AMBIGUOUS_ADDRESS);
  assert.equal(ambiguous.ambiguity_count, broadway.candidate_count);
  assert.match(ambiguous.recovery.message, /borough or ZIP/i);
  assert.equal(ambiguous.board_id, null);
  assert.equal(Object.hasOwn(ambiguous, "candidates"), false);
  assert.doesNotMatch(JSON.stringify(ambiguous), /candidate_identit|bbls|bbl"/i);

  // Kensington area still has multiple boards; exact path must not steal the leader.
  const kensington = resolveBoardNeighborhoodSelection("nta2020:BK1203", associations);
  assert.ok(kensington.boards.length > 1);
  const leading = kensington.boards[0].board_id;

  const missingParcel = createBoardExactAddressResolver({
    resolveAddressEntry: async () => ({
      entry: geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE, {
        source: "address",
      }),
    }),
    geographyLookup: GEOGRAPHY_LOOKUP,
  });
  const unavailable = await missingParcel("810 East 16th Street Brooklyn");
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE);
  assert.equal(unavailable.board_id, null);
  assert.notEqual(unavailable.board_id, leading);

  // Conflicting community-district memberships also refuse an NTA fallback.
  const conflicting = resolveExactBoardFromGeographyEntry({
    ok: true,
    source: "address",
    selected: { type: "nta2020", id: "BK1203", label: "Kensington", key: "geography:nta2020:BK1203" },
    bundle: {
      by_type: {
        community_district: [
          { id: "K12", label: "Brooklyn Community District 12" },
          { id: "K14", label: "Brooklyn Community District 14" },
        ],
        nta2020: [{ id: "BK1203", label: "Kensington" }],
      },
    },
  }, { geographyLookup: GEOGRAPHY_LOOKUP });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.CONFLICTING_DISTRICT);
  assert.equal(conflicting.board_id, null);
});

test("A3: address strings and coordinates stay out of share, watch, and analytics bags; denial leaves typed entry usable", async () => {
  const { resolve } = productionResolver();
  const midwood = await resolve("810 East 16th Street Brooklyn");
  assert.equal(midwood.ok, true);

  const share = midwood.share;
  assert.equal(share.hash, "#board-brooklyn-cb-14");
  assert.equal(boardExactAddressPayloadLeaksEphemeral(share), false);
  assert.equal(Object.hasOwn(share, "address"), false);
  assert.equal(Object.hasOwn(share, "lat"), false);

  const projection = boardExactAddressPublicProjection(midwood);
  assert.equal(boardExactAddressPayloadLeaksEphemeral(projection), false);
  assert.doesNotMatch(JSON.stringify(projection), /810|East 16th|11230|-73\.|40\./i);

  // Positive control: the checker must fail when ephemeral keys are present.
  assert.equal(boardExactAddressPayloadLeaksEphemeral({ address: "810 East 16th Street" }), true);
  assert.equal(boardExactAddressPayloadLeaksEphemeral({ lat: 40.63, lon: -73.96 }), true);
  assert.equal(boardExactAddressPayloadLeaksEphemeral({ bbl: MIDWOOD_PAD_BBL }), true);

  const associations = loadAssociations();
  const location = makeLocation("https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203");
  const history = makeHistory(location);
  const { doc, container } = mountDocument(scorecardShell(
    renderBoardNeighborhoodDirectoryHtml(associations, { selectedGeo: "nta2020:BK1203" }),
  ), { containerClass: "scorecard-host" });
  const root = container.querySelector("[data-community-board-root]");

  let denied = false;
  const fakeGeo = {
    getCurrentPosition(_success, error) {
      denied = true;
      error({ code: 1, message: "denied" });
    },
  };
  const binder = mountBoardExactAddress(root, {
    resolveAddress: resolve,
    geographyLookup: GEOGRAPHY_LOOKUP,
    location,
    history,
    geolocation: fakeGeo,
  });
  assert.ok(binder);
  const addressInput = root.querySelector("[data-board-exact-address-input]");
  assert.ok(addressInput);
  addressInput.value = "810 East 16th Street Brooklyn";
  assert.equal(addressInput.selectionStart, 0);
  assert.equal(addressInput.selectionEnd, 0);
  binder.open({ focus: true });
  assert.equal(doc.activeElement, addressInput);
  assert.equal(addressInput.selectionStart, 0);
  assert.equal(addressInput.selectionEnd, addressInput.value.length);
  root.querySelector("[data-board-exact-address-location]").dispatchEvent(new FakeEvent("click"));
  assert.equal(denied, true);
  const denial = binder.getResult();
  assert.equal(denial.ok, false);
  assert.equal(denial.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.GEOLOCATION_DENIED);

  // Typed address and neighborhood entry remain usable after denial.
  const neighborhoodSelect = root.querySelector("[data-board-neighborhood-select]");
  assert.ok(neighborhoodSelect);
  assert.equal(addressInput.hasAttribute("disabled"), false);
  assert.equal(neighborhoodSelect.hasAttribute("disabled"), false);
  assert.equal(addressInput.value, "810 East 16th Street Brooklyn");
  const neighborhood = mountBoardNeighborhoodDirectory(root, {
    associations,
    location,
    history,
  });
  const selection = neighborhood.getSelection();
  assert.equal(selection.ok, true);
  assert.ok(selection.boards.length >= 1);
});

test("A4: browser binder covers refinement focus, clear, denial, retry, and return to neighborhood results", async () => {
  const { resolve } = productionResolver();
  const associations = loadAssociations();
  const location = makeLocation("https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203");
  const history = makeHistory(location);
  const { doc, container } = mountDocument(scorecardShell(
    renderBoardNeighborhoodDirectoryHtml(associations, { selectedGeo: "nta2020:BK1203" }),
  ), { containerClass: "scorecard-host" });
  const root = container.querySelector("[data-community-board-root]");

  mountBoardNeighborhoodDirectory(root, { associations, location, history });
  const binder = mountBoardExactAddress(root, {
    resolveAddress: resolve,
    geographyLookup: GEOGRAPHY_LOOKUP,
    location,
    history,
    geolocation: {
      getCurrentPosition(_success, error) {
        error({ code: 1 });
      },
    },
  });
  assert.ok(binder);

  const panel = root.querySelector("[data-board-neighborhood-address]");
  assert.ok(panel);
  assert.equal(panel.hidden, true);
  root.querySelector("[data-board-address-action]").dispatchEvent(new FakeEvent("click", {
    bubbles: true,
  }));
  assert.equal(panel.hidden, false);

  const input = root.querySelector("[data-board-exact-address-input]");
  input.value = "250 Broadway";
  await binder.submitAddress(input.value);

  const ambiguous = binder.getResult();
  assert.equal(ambiguous?.recovery?.reason, BOARD_EXACT_ADDRESS_RECOVERY.AMBIGUOUS_ADDRESS);
  assert.equal(
    root.querySelector("[data-board-exact-address-status]")?.dataset.refine,
    "true",
  );

  // Retry with the Midwood success path.
  input.value = "810 East 16th Street Brooklyn";
  await binder.submitAddress(input.value);
  const success = binder.getResult();
  assert.equal(success?.ok, true);
  assert.equal(success.board_id, "brooklyn-cb-14");
  assert.match(location.hash, /#board-brooklyn-cb-14/);
  assert.equal(location.search.includes("address"), false);

  binder.clear({ close: false });
  assert.equal(binder.getResult(), null);
  assert.equal(input.value, "");

  // Return to neighborhood results closes the panel and keeps neighborhood chrome.
  // Focus-suppressed open must leave the address input unfocused so the polarity can fail.
  const heading = root.querySelector("#scorecard-neighborhood-heading");
  assert.ok(heading);
  heading.focus({ preventScroll: true });
  assert.equal(doc.activeElement, heading);
  input.value = "keep me unfocused";
  binder.open({ focus: false });
  assert.notEqual(doc.activeElement, input);
  assert.equal(doc.activeElement, heading);
  root.querySelector("[data-board-exact-address-back]").dispatchEvent(new FakeEvent("click"));
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, heading);
  assert.ok(root.querySelector("[data-board-neighborhood-results]"));
  assert.ok(root.querySelector("[data-board-neighborhood-select]"));

  // Markup wiring stays on the production paths.
  assert.match(DIRECTORY_SOURCE, /renderBoardExactAddressPanelHtml/);
  assert.match(APP_SOURCE, /mountBoardExactAddress/);
  assert.match(MODULE_SOURCE, /createGeographyAddressEntryResolver/);
  assert.match(MODULE_SOURCE, /communityBoardIdFromCommunityDistrict/);
  assert.doesNotMatch(MODULE_SOURCE, /boardsForNta\(/);
});

test("A5: Victory Boulevard PAD BBL stays unresolved; never substitute the Land project BBL", async () => {
  const { resolve, geocode, parcel } = productionResolver();

  const pad = await geocode("1688 Victory Boulevard Staten Island");
  assert.equal(pad.status, "matched");
  assert.equal(pad.bbl, VICTORY_PAD_BBL);
  assert.notEqual(pad.bbl, LAND_PROJECT_BBL);

  const victory = await resolve("1688 Victory Boulevard Staten Island");
  assert.equal(victory.ok, false);
  assert.equal(victory.recovery.reason, BOARD_EXACT_ADDRESS_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE);
  assert.equal(victory.board_id, null);
  assert.match(victory.recovery.message, /Refine the address|choose a neighborhood/i);
  assert.doesNotMatch(JSON.stringify(victory), new RegExp(LAND_PROJECT_BBL));
  assert.doesNotMatch(MODULE_SOURCE, new RegExp(LAND_PROJECT_BBL));

  // Shard 07 was consulted for the PAD BBL and does not invent the project lot.
  assert.ok(parcel.requested.some((url) => url.includes("/data/parcel-geography/")));
  const shard07 = readJson("site/data/parcel-geography/07.json");
  assert.equal(Object.hasOwn(shard07.parcels || {}, VICTORY_PAD_BBL), false);
  assert.equal(Object.hasOwn(shard07.parcels || {}, LAND_PROJECT_BBL), false);

  const panel = renderBoardExactAddressPanelHtml();
  assert.match(panel, /data-board-exact-address-input/);
  assert.match(panel, /data-board-exact-address-location/);
  assert.match(panel, /Asked only when you press the button/);
});
