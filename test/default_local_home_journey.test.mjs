/**
 * Default local home: the Near You shell is CityScroll's root entry.
 *
 * Public alias: c27355579ade0
 *
 * Verify: node --test test/default_local_home_journey.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createGeographyAddressEntryResolver } from "../site/geography_address_entry.mjs";
import {
  geographyEntrySelectionState,
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromPlaceLabel,
} from "../site/geography_navigation_entry.mjs";
import {
  geographyNavigationUrlWithFilters,
  parseGeographyNavigationState,
} from "../site/geography_navigation_state.mjs";
import {
  isNearYouDeferredPath,
  isNearYouDocumentPath,
  scopeFromNearYouUrl,
} from "../site/near_you_scope_runtime.mjs";
import {
  bindNearYouRecordInspection,
  nearYouRecordInspectionFacts,
} from "../site/near_you_record_inspection.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";
import { createPrecomputedAddressGeocoder } from "../site/precomputed_address_geocoder.mjs";
import { BROADER_DISTRICTS_KICKER } from "../site/near_you_broader_districts.mjs";
import { click, mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  broaderDistrictsFromCommittedArtifacts,
  buildLocalGeographyPublication,
  residentialPlacesFromNtaLayer,
} from "../tools/build_worker_route_read_models.mjs";
import { handleNearYou, READ_MODEL_VERSION_HEADER } from "../worker/src/near_you.mjs";
import edgeWorker from "../site/pages_edge.mjs";
import { BROWSE_GROUPS, browseGroupEntryRoute } from "../site/browse_view.mjs";
import { browseSurfaceContractForRoute } from "../site/browse_surface_contracts.mjs";
import { ASSETS as NEAR_YOU_CAPTURE_ASSETS } from "../tools/serve_near_you_capture.mjs";
import {
  MEETING_MANIFEST_KEY,
  NEAR_YOU_MANIFEST_KEY,
} from "../worker/src/lib/route_read_model_kv.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/default-local-home-journey");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const CAPTURE_TOOL = join(ROOT, "tools/capture_default_local_home_journey.py");
const DELIVERY_PATH = join(EVIDENCE_DIR, "delivery.json");
const PUBLIC_ALIAS = "c27355579ade0";
const REQUIRED_SERVED_ANCESTOR = "f59d912cebb080458052e156d188beb3ba0fa70c";

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const SEPT14_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const MIDWOOD_GEO = "nta2020:BK1403";
const KENSINGTON_GEO = "nta2020:BK1203";
const SUBJECT_GEO = "nta2020:BK1402";
const KENSINGTON_KEY = "geography:nta2020:BK1203";
const SEPT23_DETAIL =
  "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fhousing-and-land-use-committee-meeting-september-2026%2F";
const SEPT14_DETAIL =
  "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fseptember-2026-board-meeting%2F";

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);
const LAYER_DATA = [readJson("site/data/geography/layers/nta2020/26B.json")];

function localDataFetch(rootDir, urlPrefix) {
  async function fetchImpl(url) {
    const href = String(url);
    const relative = href.includes(urlPrefix)
      ? href.slice(href.indexOf(urlPrefix) + urlPrefix.length)
      : href.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "");
    const body = readFileSync(join(ROOT, rootDir, relative), "utf8");
    return {
      ok: true,
      status: 200,
      async json() {
        return JSON.parse(body);
      },
      async text() {
        return body;
      },
    };
  }
  return { fetchImpl };
}

function productionAddressResolver() {
  const pad = localDataFetch("site/data/address-index", "/data/address-index/");
  const parcel = localDataFetch("site/data/parcel-geography", "/data/parcel-geography/");
  const geocode = createPrecomputedAddressGeocoder({
    fetchImpl: pad.fetchImpl,
    manifestUrl: "/data/address-index/manifest.json",
  });
  return createGeographyAddressEntryResolver({
    geocode,
    fetchImpl: parcel.fetchImpl,
    parcelManifestUrl: "/data/parcel-geography/manifest.json",
  });
}

function kv(values) {
  return {
    async get(key) {
      return values.get(key) || null;
    },
  };
}

function storePublication(publication) {
  const values = new Map();
  for (const entry of publication.nearYou.entries) values.set(entry.key, entry.value);
  for (const entry of publication.meetings.entries) values.set(entry.key, entry.value);
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(publication.nearYou.manifest));
  values.set(MEETING_MANIFEST_KEY, JSON.stringify(publication.meetings.manifest));
  return values;
}

function publicationEnv() {
  const publication = buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings: readJson("site/data/shared_meeting_read_model.json"),
    version: "default-local-home",
    residentialPlaces,
    dependencies: {
      parcel_membership_generation: "parcel-default-local-home",
      parcel_coordinate_vintage: "pluto-default-local-home",
      assertion_generation: "assertion-default-local-home",
      source_generation: "2026-09-26",
    },
  });
  assert.equal(publication.activation.activate, true, publication.activation.reason);
  return { ALERT_STATE: kv(storePublication(publication)) };
}

function viewForGeo(geo, now, options = {}) {
  const route = `https://cityscroll.org/near-you/?geo=${encodeURIComponent(geo)}&surface=map&lens=meetings`;
  return withPinnedClock(now, () => {
    const view = buildNearYouViewModel(scopeFromNearYouUrl(route), activity, boundaries, {
      geographyState: parseGeographyNavigationState(new URL(route).search),
      broaderDistricts: options.broaderDistricts,
    });
    const parts = renderNearYouDeferredParts(view);
    return { view, html: parts.resultsHtml };
  });
}

function kensingtonBroader() {
  const relations = broaderDistrictsFromCommittedArtifacts()[KENSINGTON_KEY] || [];
  const slices = {};
  for (const relation of relations) {
    const memberIds = activity.district_items?.by_level?.community_district?.[relation.id]?.meetings || [];
    const meetings = {};
    for (const id of memberIds) {
      if (activity.records?.meetings?.[id]) meetings[id] = activity.records.meetings[id];
    }
    slices[`community-district:${relation.id}`] = {
      records: { meetings },
      district_items: {
        by_level: {
          community_district: {
            [relation.id]: { meetings: memberIds },
          },
        },
      },
    };
  }
  return { relations, slices };
}

function selectedGeoFromHtml(html) {
  const key = String(html).match(/data-geography-selected-key="([^"]+)"/);
  if (key?.[1]?.startsWith("geography:")) return key[1].slice("geography:".length);
  const geoAttr = String(html).match(/\bdata-geo="([^"]+)"/);
  if (geoAttr?.[1]) return geoAttr[1];
  const hrefGeo = String(html).match(/[?&]geo=([^"'&]+)/);
  if (hrefGeo?.[1]) return decodeURIComponent(hrefGeo[1]);
  return null;
}

function selectedGeosFromScope(url) {
  const scope = scopeFromNearYouUrl(url);
  return (scope.place?.geographies || [])
    .map((geo) => {
      const raw = typeof geo === "string" ? geo : (geo?.id || geo?.key || "");
      return String(raw).replace(/^geography:/, "");
    })
    .filter(Boolean);
}

test("path helpers: root and /near-you are document paths; deferred stays under /near-you", () => {
  assert.equal(isNearYouDocumentPath("/"), true);
  assert.equal(isNearYouDocumentPath("/near-you"), true);
  assert.equal(isNearYouDocumentPath("/near-you/"), true);
  assert.equal(isNearYouDocumentPath("/following/"), false);
  assert.equal(isNearYouDeferredPath("/near-you/deferred.json"), true);
  assert.equal(isNearYouDeferredPath("/"), false);
  assert.equal(isNearYouDeferredPath("/deferred.json"), false);
});

test("A1 [outcome] root shell + typed Midwood address reach September 23 in three actions; shared Midwood route reconstructs", async () => {
  const env = publicationEnv();

  // Action 1: open `/` — Worker serves the local discovery shell.
  const root = await handleNearYou(new Request("https://cityscroll.org/"), env);
  assert.equal(root.status, 200);
  const rootHtml = await root.text();
  assert.match(rootHtml, /data-near-you-root/);
  assert.match(rootHtml, /data-geography-search|near-geo-search/);
  assert.match(rootHtml, /Use my location|data-use-location/);

  // Action 2: resolve 810 East 16th Street the same way the shell submit path does.
  const resolve = productionAddressResolver();
  const midwood = await resolve("810 East 16th Street Brooklyn", { layerData: LAYER_DATA });
  assert.equal(midwood.entry.ok, true);
  assert.equal(midwood.entry.selection.geo, MIDWOOD_GEO);
  assert.equal(midwood.entry.selected.label, "Midwood");

  // Action 3: open the September 23 meeting from Midwood results.
  const midwoodView = await viewForGeo(MIDWOOD_GEO, "2026-09-23T14:00:00.000Z");
  const record = (midwoodView.view.results?.records || []).find((row) => row.id === SEPT23_ID);
  assert.ok(record, "September 23 meeting must appear for Midwood");
  assert.equal(record.venue_address, "810 East 16th Street, Brooklyn, NY, 11230");
  assert.match(midwoodView.html, /Held in Midwood/);
  assert.match(midwoodView.html, new RegExp(SEPT23_DETAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const { doc, container } = mountDocument(
    `<div data-near-you-root data-lens="meetings" data-geo="${MIDWOOD_GEO}">${midwoodView.html}</div>`,
    { containerClass: "near-you-host" },
  );
  const rootEl = container.querySelector("[data-near-you-root]") || container;
  bindNearYouRecordInspection(rootEl);
  const card = rootEl.querySelector(`[data-record-id="${SEPT23_ID}"]`);
  assert.ok(card);
  const open = card.querySelector("[data-near-you-record-inspection-open], a[href*='housing-and-land-use']");
  assert.ok(open, "open full detail control present");
  if (open.tagName === "A") {
    assert.match(open.getAttribute("href") || "", /housing-and-land-use-committee-meeting-september-2026/);
  } else {
    click(open);
    const dialog = doc.getElementById("near-you-record-inspection");
    assert.ok(dialog);
  }

  // Shared Midwood route reconstructs independently of the root journey.
  const sharedUrl =
    `https://cityscroll.org/near-you/?geo=${encodeURIComponent(MIDWOOD_GEO)}&surface=map&lens=meetings`;
  assert.deepEqual(selectedGeosFromScope(sharedUrl), [MIDWOOD_GEO]);
  const shared = await handleNearYou(new Request(sharedUrl), env);
  assert.equal(shared.status, 200);
  const sharedHtml = await shared.text();
  assert.match(sharedHtml, /BK1403|Midwood/);
  assert.equal(selectedGeoFromHtml(sharedHtml) === MIDWOOD_GEO || /BK1403/.test(sharedHtml), true);
  const sharedDeferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&surface=map&lens=meetings`,
  ), env);
  assert.equal(sharedDeferred.status, 200);
  const sharedPayload = await sharedDeferred.json();
  assert.match(sharedPayload.results_html, /Held in Midwood/);
  assert.match(sharedPayload.results_html, new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

const ENTRY_CLOCK = "2026-09-28T16:00:00.000Z";
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The destination a typed entry adopts, built the way the map island builds it.
function typedEntryDestination(entry) {
  const state = geographyEntrySelectionState(parseGeographyNavigationState(""), entry);
  return geographyNavigationUrlWithFilters(state, { base: "https://cityscroll.org/near-you/" });
}

function recordCard(html, id) {
  const start = html.indexOf(`data-record-id="${id}"`);
  if (start < 0) return "";
  const open = html.lastIndexOf("<li", start);
  const close = html.indexOf("</li>", start);
  return html.slice(open, close);
}

test("A1 [outcome] typed Midwood and subject addresses open their Records; September 23 is past at the pinned clock", async () => {
  const env = publicationEnv();
  const resolve = productionAddressResolver();
  await withPinnedClock(ENTRY_CLOCK, async () => {
    const midwood = await resolve("810 East 16th Street", { layerData: LAYER_DATA });
    assert.equal(midwood.entry.ok, true);
    assert.equal(midwood.entry.selection.geo, MIDWOOD_GEO);
    const href = typedEntryDestination(midwood.entry);
    const url = new URL(href);
    assert.equal(url.searchParams.get("surface"), "records");
    assert.equal(url.searchParams.has("drawer"), false);
    assert.doesNotMatch(href, /810|East|16th/i, "typed text stays out of the destination");

    const response = await handleNearYou(new Request(href), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-near-you-root[^>]*data-near-surface="records"/);
    assert.match(html, /<h1>Midwood<\/h1>/);
    assert.match(html, /data-lens="meetings"/);
    assert.match(html, /data-near-surface="map"[^>]*>Map<\/a>/);

    const deferredUrl = new URL(href);
    deferredUrl.pathname = "/near-you/deferred.json";
    const deferred = await (await handleNearYou(new Request(deferredUrl), env)).json();
    assert.match(deferred.results_html, /Meetings records/);
    const card = recordCard(deferred.results_html, SEPT23_ID);
    assert.ok(card, "September 23 meeting is in Midwood's Records");
    assert.match(card, /data-record-timing="past"/);
    assert.match(card, /810 East 16th Street, Brooklyn, NY, 11230/);
    assert.match(card, new RegExp(`href="[^"]*${escapeRegExp(SEPT23_DETAIL)}"`));

    const subject = await resolve("461 Coney Island Avenue", { layerData: LAYER_DATA });
    assert.equal(subject.entry.ok, true);
    assert.equal(subject.entry.selection.geo, SUBJECT_GEO);
    assert.equal(new URL(typedEntryDestination(subject.entry)).searchParams.get("surface"), "records");
  });
  // Converse control: the same row is upcoming before its date, so "past" is the clock's reading.
  const before = await viewForGeo(MIDWOOD_GEO, "2026-09-23T14:00:00.000Z");
  assert.match(recordCard(before.html, SEPT23_ID), /data-record-timing="upcoming"/);
});

// Each collection the unselected entry offers, from the canonical Browse
// taxonomy, with the server-built marker its own document carries.
function canonicalCollections() {
  return [
    ...BROWSE_GROUPS.map((group) => {
      const route = browseGroupEntryRoute(group);
      return {
        label: group.label,
        route,
        marker: group.primaryFacet
          ? `data-browse-facet="${group.primaryFacet}"`
          : `data-browse-surface="${browseSurfaceContractForRoute(route).surfaceId}"`,
      };
    }),
    { label: "Browse all NYC records", route: "/browse/", marker: 'data-build-rendered="browse-landing"' },
    { label: "Search all records", route: "/search/", marker: "data-search-document" },
  ];
}

function entryCollectionLinks(html) {
  const row = String(html).match(/<nav class="near-collection-entry"[\s\S]*?<\/nav>/)?.[0] || "";
  return [...row.matchAll(/<a href="([^"]*)" data-near-collection="[^"]*"(?: data-browse-family="[^"]*")?>([^<]*)<\/a>/g)]
    .map(([, href, label]) => ({ label, route: new URL(href, "https://cityscroll.org").pathname }));
}

// A followed link landed on its collection: a 200 answer (never a redirect
// home), the collection's own document marker, and not the Near You shell.
function landedOnCollection(status, body, collection) {
  return status === 200 && body.includes(collection.marker) && !body.includes("data-near-you-root");
}

test("A1/A5 [outcome] root collection links open each Browse collection through the Pages handler, not the home shell", async () => {
  const collections = canonicalCollections();
  assert.equal(collections.length, 8);
  const pages = { ASSETS: NEAR_YOU_CAPTURE_ASSETS };
  const env = publicationEnv();
  const roots = [
    ["Worker /", await (await handleNearYou(new Request("https://cityscroll.org/"), env)).text()],
    ["Worker /near-you/", await (await handleNearYou(new Request("https://cityscroll.org/near-you/"), env)).text()],
    ["Pages /", await (await edgeWorker.fetch(new Request("https://cityscroll.org/"), pages)).text()],
  ];
  for (const [label, html] of roots) {
    assert.match(html, /data-near-you-root/, `${label} is the Near You entry`);
    assert.deepEqual(
      entryCollectionLinks(html),
      collections.map(({ label: name, route }) => ({ label: name, route })),
      `${label} collection links`,
    );
  }
  for (const collection of collections) {
    const response = await edgeWorker.fetch(
      new Request(`https://cityscroll.org${collection.route}`, { redirect: "manual" }),
      pages,
    );
    const body = await response.text();
    assert.ok(
      landedOnCollection(response.status, body, collection),
      `${collection.label} (${collection.route}) answered ${response.status} without ${collection.marker}`,
    );
  }
  // Positive controls: the home shell and a redirect home cannot pass as a collection.
  assert.equal(landedOnCollection(200, roots[2][1], collections[0]), false);
  const home = Response.redirect("https://cityscroll.org/", 302);
  assert.equal(landedOnCollection(home.status, "", collections[0]), false);
});

test("A2 [outcome] Kensington wider-district + BK1402 subject from root; root and /near-you agree on place", async () => {
  const env = publicationEnv();
  const broader = kensingtonBroader();

  // From `/`, Kensington place label selects BK1203 (shell place-label path).
  const kensingtonEntry = resolveGeographyEntryFromPlaceLabel("Kensington", { layerData: LAYER_DATA });
  assert.equal(kensingtonEntry.ok, true);
  assert.equal(kensingtonEntry.selection.geo, KENSINGTON_GEO);

  const kenView = await viewForGeo(KENSINGTON_GEO, "2026-09-23T14:00:00.000Z", {
    broaderDistricts: broader,
  });
  assert.match(kenView.html + JSON.stringify(kenView.view.broader_districts || {}), new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(
    (kenView.view.broader_districts?.districts || []).some((district) =>
      (district.records || []).some((row) => row.id === SEPT23_ID)),
    "September 23 appears under Kensington wider-district activity",
  );
  assert.match(BROADER_DISTRICTS_KICKER, /wider|broader|district/i);

  // Direct BK1402 subject result for September 14.
  const subjectView = await viewForGeo(SUBJECT_GEO, "2026-09-15T14:00:00.000Z");
  const subject = (subjectView.view.results?.records || []).find((row) => row.id === SEPT14_ID);
  assert.ok(subject, "September 14 subject meeting in BK1402");
  assert.match(subjectView.html, /About 461 Coney Island Avenue|461 Coney Island/);
  assert.match(subjectView.html, new RegExp(SEPT14_DETAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Root and /near-you agree on selected-place behavior for the same query.
  const query = `?geo=${encodeURIComponent(KENSINGTON_GEO)}&surface=map&lens=meetings`;
  const rootUrl = `https://cityscroll.org/${query}`;
  const nearUrl = `https://cityscroll.org/near-you/${query}`;
  assert.deepEqual(selectedGeosFromScope(rootUrl), [KENSINGTON_GEO]);
  assert.deepEqual(selectedGeosFromScope(nearUrl), [KENSINGTON_GEO]);
  const fromRoot = await handleNearYou(new Request(rootUrl), env);
  const fromNearYou = await handleNearYou(new Request(nearUrl), env);
  assert.equal(fromRoot.status, 200);
  assert.equal(fromNearYou.status, 200);
  const rootHtml = await fromRoot.text();
  const nearHtml = await fromNearYou.text();
  assert.match(rootHtml, /BK1203|Kensington/);
  assert.match(nearHtml, /BK1203|Kensington/);
  assert.equal(selectedGeoFromHtml(rootHtml), selectedGeoFromHtml(nearHtml));
  // Converse control: a different geo must not collapse to Kensington.
  const midwoodUrl = `https://cityscroll.org/?geo=${encodeURIComponent(MIDWOOD_GEO)}&surface=map&lens=meetings`;
  assert.deepEqual(selectedGeosFromScope(midwoodUrl), [MIDWOOD_GEO]);
  const midwoodDoc = await handleNearYou(new Request(midwoodUrl), env);
  const midwoodHtml = await midwoodDoc.text();
  assert.match(midwoodHtml, /BK1403|Midwood/);
  assert.notEqual(selectedGeoFromHtml(midwoodHtml), KENSINGTON_GEO);
});

test("A3 [boundary] denied geolocation, unavailable map, failed broader feed keep place choice; Search/Following/geo URLs reachable", async () => {
  const env = publicationEnv();
  const denied = resolveGeographyEntryFromGeolocationError({ code: 1 });
  assert.equal(denied.ok, false);
  assert.match(denied.recovery?.message || "", /permission|location|choose|area|type/i);

  // Unavailable map geometry still renders the text shell and place search.
  const view = buildNearYouViewModel(
    scopeFromNearYouUrl("https://cityscroll.org/near-you/"),
    null,
    boundaries,
    { dataState: "error", geometryState: "unavailable", recoveryHref: "/near-you/" },
  );
  const html = renderNearYouDocument(view, { assetPrefix: "/" });
  assert.match(html, /data-near-you-root/);
  assert.match(html, /data-geography-search|near-geo-search|Browse the area list/);
  assert.match(html, /href="\/following\/"/);
  assert.match(html, /href="\/browse\/"/);
  assert.match(html, /href="\/near-you\/"/);

  // Failed optional broader feed leaves exact Kensington list intact.
  const exactOnly = await viewForGeo(KENSINGTON_GEO, "2026-09-23T14:00:00.000Z", {
    broaderDistricts: null,
  });
  assert.equal(exactOnly.view.broader_districts == null || exactOnly.view.broader_districts?.districts?.length === 0, true);
  assert.ok(Array.isArray(exactOnly.view.results?.records));

  // Shared geo URL remains a Worker document path.
  const shared = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/?geo=${encodeURIComponent(MIDWOOD_GEO)}&surface=map`,
  ), env);
  assert.equal(shared.status, 200);
  assert.match(await shared.text(), /data-near-you-root/);

  // Positive control: a non-document path still 404s from the Near You handler.
  const missing = await handleNearYou(new Request("https://cityscroll.org/stats"), env);
  assert.equal(missing.status, 404);
});

test("A4 [verification] production retake carries dual-width URL transitions, controls, receipts, and no image binaries", () => {
  assert.equal(existsSync(CAPTURE_TOOL), true, "capture tool must exist");
  const captureTool = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureTool, /1440/);
  assert.match(captureTool, /390/);
  assert.match(captureTool, /c27355579ade0/);
  assert.match(captureTool, /data-near-you-root/);
  assert.match(captureTool, /headless-playwright-production-served-site/);
  assert.match(captureTool, /require_served_page_revision_contains_delivery/);
  assert.match(captureTool, /require_stable_served_deployment/);
  assert.match(captureTool, /served JSON is not an object/);
  assert.match(captureTool, /lacks a 40-hex source_commit_sha/);
  assert.match(captureTool, /lacks a 64-hex artifact_hash/);
  assert.match(captureTool, /lacks a source-receipt digest/);
  assert.match(captureTool, /lacks source-receipt generated_at/);
  assert.match(captureTool, /origin\/main did not resolve to a full commit/);
  assert.match(captureTool, /served revision changed during capture/);
  assert.match(captureTool, /observed_url_before/);
  assert.match(captureTool, /observed_url_after/);
  assert.match(captureTool, /project-connections/);
  assert.match(captureTool, /image_binaries_committed|file.: null/);
  assert.match(captureTool, /root-midwood-meeting-detail/);
  assert.match(captureTool, /direct-bk1402-subject-result/);
  assert.match(captureTool, /shared-geo-map-feed-failure/);
  assert.match(captureTool, /require_served_journey_data/);

  assert.equal(existsSync(MANIFEST_PATH), true, "capture manifest must be present");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "default-local-home-journey");
  assert.equal(manifest.public_alias, PUBLIC_ALIAS);
  assert.equal(manifest.capture_mode, "headless-playwright-production-served-site");
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.revision_format, "served artifact-manifest source_commit_sha");
  assert.equal(manifest.required_ancestor, REQUIRED_SERVED_ANCESTOR);
  assert.equal(manifest.required_ancestor_contained, true);
  assert.match(manifest.revision || "", /^[0-9a-f]{40}$/);
  assert.match(manifest.grounded_at || "", /^[0-9a-f]{40}$/);
  assert.equal(manifest.deployment?.source_commit_sha, manifest.revision);
  assert.match(manifest.deployment?.artifact_hash || "", /^[0-9a-f]{64}$/);
  assert.match(manifest.data_vintage?.source_receipt_sha256 || "", /^[0-9a-f]{64}$/);
  assert.ok(manifest.capture_run_id);
  assert.ok(Array.isArray(manifest.captures) && manifest.captures.length >= 28);
  assert.equal(JSON.stringify(manifest).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(manifest).includes("localhost"), false);

  const requiredViewports = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const viewport of requiredViewports) {
    const rows = manifest.captures.filter(
      (row) => row.viewport?.width === viewport.width && row.viewport?.height === viewport.height,
    );
    assert.ok(rows.length >= 14, `need fourteen production cases at ${viewport.width}x${viewport.height}`);
    assert.ok(rows.some((row) => row.route === "/"), "root shell capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("midwood")), "Midwood capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("geolocation-denial")), "denial capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("failure-recovery")), "failure-recovery capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("registered-land-hash")), "registered hash capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("unknown-hash")), "unknown hash control required");
    assert.ok(rows.some((row) => String(row.name || "").includes("midwood-meeting-detail")), "A1 detail capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("shared-midwood-route")), "A1 shared route required");
    assert.ok(rows.some((row) => String(row.name || "").includes("kensington-wider-result")), "A2 wider result required");
    assert.ok(rows.some((row) => String(row.name || "").includes("kensington-wider-detail")), "A2 wider detail required");
    assert.ok(rows.some((row) => String(row.name || "").includes("kensington-agreement")), "A2 route agreement required");
    assert.ok(rows.some((row) => String(row.name || "").includes("bk1402-subject-result")), "A2 subject result required");
    assert.ok(rows.some((row) => String(row.name || "").includes("map-feed-failure")), "A3 fault capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("map-feed-recovery")), "A3 recovery capture required");
    for (const row of rows) {
      assert.ok(row.snapshot?.measured_css === true || row.snapshot?.stylesheet_hrefs?.length >= 1, row.name);
      assert.equal(row.snapshot?.viewport_width_px, viewport.width, row.name);
      assert.equal(row.snapshot?.viewport_height_px, viewport.height, row.name);
    }
  }
  for (const row of manifest.captures) {
    assert.ok(row.sha256 && /^[0-9a-f]{64}$/i.test(row.sha256), row.name);
    assert.equal(row.file, null);
    assert.match(row.screenshot_url || "", /^https:\/\//, row.name);
    assert.ok(row.assertion);
    assert.equal(row.source, "headless-playwright-production-served-site");
    assert.equal(row.capture_run_id, manifest.capture_run_id);
    assert.equal(row.revision, manifest.revision);
    assert.ok(Object.keys(row.assertions || {}).length > 0, row.name);
    assert.ok(Object.values(row.assertions).every((value) => value === true), row.name);
    assert.equal(row.data_vintage?.source_receipt_sha256, manifest.data_vintage.source_receipt_sha256);

    const receipt = row.run_receipt;
    assert.equal(receipt.capture_run_id, manifest.capture_run_id, row.name);
    assert.equal(receipt.served_revision, manifest.revision, row.name);
    assert.ok(Number.isFinite(Date.parse(receipt.captured_at)), row.name);
    assert.match(receipt.observed_url_before || "", /^https:\/\//, row.name);
    assert.match(receipt.observed_url_after || "", /^https:\/\//, row.name);
    assert.ok(Array.isArray(receipt.navigation_events) && receipt.navigation_events.length > 0, row.name);
    assert.equal(receipt.page_load?.http_status, 200, row.name);
    assert.equal(receipt.page_load?.served_revision, manifest.revision, row.name);
    assert.equal(receipt.upload?.http_status, 200, row.name);
    assert.equal(receipt.upload?.returned_url, row.screenshot_url, row.name);
  }

  const byName = Object.fromEntries(manifest.captures.map((row) => [row.name, row]));
  for (const suffix of ["desktop", "phone"]) {
    const bare = byName[`root-shell-initial-${suffix}`];
    assert.equal(bare.run_receipt.observed_url_before, "https://cityscroll.org/");
    assert.equal(bare.run_receipt.observed_url_after, "https://cityscroll.org/");
    assert.equal(bare.assertions.bare_root_remained_near_you, true);

    const land = byName[`root-registered-land-hash-${suffix}`];
    assert.equal(land.run_receipt.observed_url_before, "https://cityscroll.org/#land/2022M0258");
    assert.equal(land.run_receipt.observed_url_after, "https://cityscroll.org/app/#land/2022M0258");
    assert.equal(land.assertions.project_connections_present, true);

    const unknown = byName[`root-unknown-hash-${suffix}`];
    assert.equal(unknown.run_receipt.observed_url_before, "https://cityscroll.org/#not-a-cityscroll-route");
    assert.equal(unknown.run_receipt.observed_url_after, "https://cityscroll.org/#not-a-cityscroll-route");
    assert.equal(unknown.assertions.unknown_hash_remained_near_you, true);

    const midwood = byName[`root-midwood-result-${suffix}`];
    assert.equal(midwood.assertions.served_midwood_record_present, true);
    const midwoodDetail = byName[`root-midwood-meeting-detail-${suffix}`];
    assert.equal(midwoodDetail.assertions.detail_title_present, true);
    assert.equal(midwoodDetail.assertions.three_user_actions_at_most, true);
    assert.equal(midwoodDetail.journey_receipt.user_action_count, 3);
    assert.equal(midwoodDetail.journey_receipt.maximum_user_actions, 3);
    assert.equal(midwoodDetail.journey_receipt.starting_route, "/");

    const sharedMidwood = byName[`shared-midwood-route-${suffix}`];
    assert.equal(sharedMidwood.assertions.selected_midwood_geo, true);
    assert.equal(sharedMidwood.assertions.served_midwood_record_present, true);

    const recovery = byName[`root-failure-recovery-kensington-${suffix}`];
    assert.equal(recovery.assertions.selected_kensington_geo, true);

    const kensington = byName[`root-kensington-wider-result-${suffix}`];
    assert.equal(kensington.assertions.selected_kensington_geo, true);
    assert.equal(kensington.assertions.wider_named_row_present, true);
    assert.equal(kensington.assertions.wider_district_section_present, true);

    const kensingtonDetail = byName[`root-kensington-wider-detail-${suffix}`];
    assert.equal(kensingtonDetail.assertions.opened_from_wider_row, true);
    assert.equal(kensingtonDetail.journey_receipt.user_action_count, 3);
    assert.equal(kensingtonDetail.journey_receipt.starting_route, "/");

    const agreement = byName[`near-you-kensington-agreement-${suffix}`];
    assert.equal(agreement.assertions.selected_place_matches_root, true);
    assert.equal(agreement.assertions.named_records_match_root, true);

    const subject = byName[`direct-bk1402-subject-result-${suffix}`];
    assert.equal(subject.assertions.selected_bk1402_geo, true);
    assert.equal(subject.assertions.subject_record_present, true);
    assert.equal(subject.assertions.subject_address_present, true);

    const fault = byName[`shared-geo-map-feed-failure-${suffix}`];
    assert.equal(fault.assertions.map_rendering_failed, true);
    assert.equal(fault.assertions.deferred_feed_failed, true);
    assert.equal(fault.assertions.retry_link_visible, true);
    assert.equal(fault.assertions.following_reachable, true);

    const faultRecovery = byName[`shared-geo-map-feed-recovery-${suffix}`];
    assert.equal(faultRecovery.assertions.map_still_unavailable, true);
    assert.equal(faultRecovery.assertions.deferred_feed_recovered, true);
    assert.equal(faultRecovery.assertions.named_record_navigation_restored, true);
    assert.equal(faultRecovery.journey_receipt.bounded, true);
  }

  assert.ok((manifest.exact_links || []).includes("/"));
  assert.ok((manifest.exact_links || []).includes("/#land/2022M0258"));
  assert.ok((manifest.exact_links || []).includes("/app/#land/2022M0258"));
  assert.ok((manifest.exact_links || []).includes("/#not-a-cityscroll-route"));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("BK1403")));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("BK1203")));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("BK1402")));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("housing-and-land-use-committee-meeting-september-2026")));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("september-2026-board-meeting")));
  assert.equal(Object.values(manifest.served_data_preflight?.checks || {}).every(Boolean), true);

  const runStart = Date.parse(manifest.run_receipt?.run_started_at);
  const runEnd = Date.parse(manifest.run_receipt?.run_finished_at);
  assert.ok(Number.isFinite(runStart) && Number.isFinite(runEnd) && runEnd >= runStart);
  assert.equal(manifest.run_receipt.served_revision_before, manifest.revision);
  assert.equal(manifest.run_receipt.served_revision_after, manifest.revision);
  assert.equal(manifest.run_receipt.artifact_hash_before, manifest.run_receipt.artifact_hash_after);

  const firstByDigest = new Map();
  for (const row of manifest.captures) {
    const first = firstByDigest.get(row.sha256);
    if (!first) {
      firstByDigest.set(row.sha256, row.name);
      continue;
    }
    assert.equal(row.coincident_hash?.with_capture, first, row.name);
    assert.equal(row.coincident_hash?.independently_recaptured, true, row.name);
    assert.equal(row.coincident_hash?.independently_uploaded, true, row.name);
  }

  const wrangler = readFileSync(join(ROOT, "worker/wrangler.toml"), "utf8");
  assert.match(wrangler, /pattern = "cityscroll\.org"/);
  assert.match(wrangler, /near-you\*/);

  const workerSource = readFileSync(join(ROOT, "worker/src/worker.mjs"), "utf8");
  assert.match(workerSource, /isNearYouDocumentPath/);
  // Module-oracle: Worker startup must not gain a new static JSON import for this card.
  assert.equal(workerSource.includes("import boundaries from"), false);

  const delivery = JSON.parse(readFileSync(DELIVERY_PATH, "utf8"));
  assert.equal(delivery.public_alias, PUBLIC_ALIAS);
  assert.equal(delivery.landed_commit, REQUIRED_SERVED_ANCESTOR);
  assert.equal(delivery.surface, "pages");

  const digest = createHash("sha256").update(readFileSync(MANIFEST_PATH)).digest("hex");
  assert.equal(digest.length, 64);
});

function runCaptureFreshness(code) {
  return spawnSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
}

function captureFreshnessPrelude() {
  return `
import importlib.util
import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

ROOT = Path(${JSON.stringify(ROOT)})
CAPTURE = ROOT / "tools" / "capture_default_local_home_journey.py"
spec = importlib.util.spec_from_file_location("capture_default_local_home_journey", CAPTURE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

VALID_SHA = "a" * 40
VALID_HASH = "b" * 64
VALID_RECEIPT = "c" * 64
VALID = {
    "schema": "cityscroll.served-artifact-manifest.v1",
    "source_commit_sha": VALID_SHA,
    "artifact_hash": VALID_HASH,
    "generated_at": "2026-09-28T00:00:00Z",
    "deployment_at": "2026-09-28T00:00:00Z",
    "source_receipt": {
        "sha256": VALID_RECEIPT,
        "generated_at": "2026-09-28T00:00:00Z",
    },
}

def serve(body: bytes):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            return
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}/"
`;
}

test("A4 [freshness] refuses non-object served JSON payload", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
server, base = serve(b"[1, 2, 3]")
try:
    mod.deployment_manifest(base)
except SystemExit as error:
    message = str(error)
    assert "served JSON is not an object" in message, message
    print("refused")
else:
    raise SystemExit("expected non-object refusal")
finally:
    server.shutdown()
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] refuses missing or malformed source_commit_sha", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
payload = dict(VALID)
payload["source_commit_sha"] = "not-a-commit"
try:
    mod.deployment_manifest("https://example.test/", fetch_json_impl=lambda url: payload)
except SystemExit as error:
    message = str(error)
    assert "lacks a 40-hex source_commit_sha" in message, message
    print("refused")
else:
    raise SystemExit("expected source_commit_sha refusal")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] refuses missing or malformed artifact_hash", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
payload = dict(VALID)
payload["artifact_hash"] = "short"
try:
    mod.deployment_manifest("https://example.test/", fetch_json_impl=lambda url: payload)
except SystemExit as error:
    message = str(error)
    assert "lacks a 64-hex artifact_hash" in message, message
    print("refused")
else:
    raise SystemExit("expected artifact_hash refusal")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] refuses missing source-receipt digest", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
payload = dict(VALID)
payload["source_receipt"] = {"generated_at": "2026-09-28T00:00:00Z"}
try:
    mod.deployment_manifest("https://example.test/", fetch_json_impl=lambda url: payload)
except SystemExit as error:
    message = str(error)
    assert "lacks a source-receipt digest" in message, message
    print("refused")
else:
    raise SystemExit("expected source-receipt digest refusal")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] refuses missing source-receipt generated_at", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
payload = dict(VALID)
payload["source_receipt"] = {"sha256": VALID_RECEIPT}
try:
    mod.deployment_manifest("https://example.test/", fetch_json_impl=lambda url: payload)
except SystemExit as error:
    message = str(error)
    assert "lacks source-receipt generated_at" in message, message
    print("refused")
else:
    raise SystemExit("expected source-receipt generated_at refusal")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] refuses unresolvable origin/main", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
class Result:
    stdout = "not-a-full-commit\\n"
def fake_run(*_args, **_kwargs):
    return Result()
subprocess.run = fake_run
try:
    mod.grounded_origin_main()
except SystemExit as error:
    message = str(error)
    assert "origin/main did not resolve to a full commit" in message, message
    print("refused")
else:
    raise SystemExit("expected origin/main refusal")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] refuses served revision changing mid-run", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
before = dict(VALID)
after = dict(VALID)
after["source_commit_sha"] = "d" * 40
try:
    mod.require_stable_served_deployment(before=before, after=after, revision=VALID_SHA)
except SystemExit as error:
    message = str(error)
    assert "served revision changed during capture" in message, message
    assert VALID_SHA in message, message
    assert ("d" * 40) in message, message
    print("refused")
else:
    raise SystemExit("expected mid-run revision refusal")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /refused/);
});

test("A4 [freshness] accepting control: well-formed served manifest and stable revision proceed", () => {
  const result = runCaptureFreshness(`${captureFreshnessPrelude()}
accepted = mod.deployment_manifest(
    "https://example.test/",
    fetch_json_impl=lambda url: dict(VALID),
)
assert accepted["source_commit_sha"] == VALID_SHA
assert accepted["artifact_hash"] == VALID_HASH
assert accepted["source_receipt"]["sha256"] == VALID_RECEIPT
assert accepted["source_receipt"]["generated_at"] == "2026-09-28T00:00:00Z"
mod.require_stable_served_deployment(before=VALID, after=dict(VALID), revision=VALID_SHA)
real = mod.grounded_origin_main()
assert len(real) == 40 and all(ch in "0123456789abcdef" for ch in real)
# Attribution: correcting only the previously bad field lets each check pass.
for key, bad, good in (
    ("source_commit_sha", "short", VALID_SHA),
    ("artifact_hash", "short", VALID_HASH),
):
    broken = dict(VALID)
    broken[key] = bad
    try:
        mod.deployment_manifest("https://example.test/", fetch_json_impl=lambda url, p=broken: p)
    except SystemExit:
        pass
    else:
        raise SystemExit(f"expected refusal for broken {key}")
    fixed = dict(broken)
    fixed[key] = good
    mod.deployment_manifest("https://example.test/", fetch_json_impl=lambda url, p=fixed: p)
print("accepted")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /accepted/);
});

test("facts: September 23 Midwood view keeps venue address (positive control)", async () => {
  const midwoodView = await viewForGeo(MIDWOOD_GEO, "2026-09-23T14:00:00.000Z");
  const record = (midwoodView.view.results?.records || []).find((row) => row.id === SEPT23_ID);
  assert.ok(record);
  const facts = nearYouRecordInspectionFacts(record, { now: "2026-09-23T14:00:00.000Z" });
  assert.match(facts.venue_address || record.venue_address || "", /810 East 16th/);
  assert.match(midwoodView.html, /Held in Midwood/);
});

// --- Discovery-recovery scenario (public alias c94563a6bbaf3) ---------------

const DISCOVERY_DIR = join(ROOT, "docs/evidence/discovery-recovery-journey");
const DISCOVERY_LOCAL_MANIFEST = join(DISCOVERY_DIR, "local-capture-manifest.json");
const DISCOVERY_SERVED_MANIFEST = join(DISCOVERY_DIR, "capture-manifest.json");
const DISCOVERY_FAMILIES = [
  "root-category-record",
  "typed-place-record",
  "unsupported-place-escape",
  "citywide-bucket-record",
  "suggested-place-record",
];
const DISCOVERY_RECOVERY_CASES = [
  "location-denied",
  "location-timeout",
  "explicit-zero",
  "failed-section",
  "missing-coverage",
  "detail-failure",
];
const FROZEN_ACTIVITY_BLOB = "5deaa202fe578e09b58380d43755419dbb85ec60";

function runCapture(args, env = process.env) {
  return spawnSync("python3", [CAPTURE_TOOL, ...args], { cwd: ROOT, encoding: "utf8", env });
}

const labelCount = (text) => Number(String(text).match(/\((\d+) [^()]+\)\s*$/)?.[1]);

test("discovery-recovery [A5] the retained local proof passes --check as an ancestor with unchanged inputs", () => {
  const result = runCapture(["--scenario", "discovery-recovery", "--local", "--check"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^ok: discovery-recovery local evidence pass$/m);
  // The earlier default-home packet is untouched and still validates.
  const defaultCheck = runCapture(["--check"]);
  assert.equal(defaultCheck.status, 0, defaultCheck.stderr);
  assert.notEqual(DISCOVERY_LOCAL_MANIFEST, MANIFEST_PATH);
  assert.notEqual(DISCOVERY_SERVED_MANIFEST, MANIFEST_PATH);
});

test("discovery-recovery [A4/A5] the served --check reports explicit pending while no served capture exists", () => {
  // Served observation is the successor read-back's; until it is recorded the
  // check neither passes nor fails silently.
  assert.equal(existsSync(DISCOVERY_SERVED_MANIFEST), false);
  const result = runCapture(["--scenario", "discovery-recovery", "--check"]);
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stderr, /^pending: absent-served-capture: /m);
  assert.equal(result.stdout, "");
});

test("discovery-recovery [A1/A2] the local proof covers every journey at both widths, counts read from the page", () => {
  const manifest = JSON.parse(readFileSync(DISCOVERY_LOCAL_MANIFEST, "utf8"));
  assert.equal(manifest.capture_mode, "headless-playwright-local-fixture-server");
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.provenance.frozen_activity.blob, FROZEN_ACTIVITY_BLOB);
  assert.equal(JSON.stringify(manifest).includes("127.0.0.1"), false);
  const byName = new Map(manifest.captures.map((row) => [row.name, row]));
  for (const [viewport, width, height] of [["phone", 390, 844], ["desktop", 1440, 900]]) {
    for (const journey of [...DISCOVERY_FAMILIES, ...DISCOVERY_RECOVERY_CASES]) {
      const row = byName.get(`${journey}-${viewport}`);
      assert.ok(row, `${journey}-${viewport}`);
      assert.deepEqual(row.page.viewport, { width, height }, row.name);
      assert.ok(row.page.stylesheet_rules > 0, row.name);
      assert.match(row.render.sha256, /^[0-9a-f]{64}$/);
      assert.equal(row.render.committed, false);
      assert.equal(row.outcome, "pass", row.name);
    }
    // Independent reading of the frozen controls from the recorded page text,
    // not from the harness's own verdicts.
    const citywide = byName.get(`citywide-bucket-record-${viewport}`).observations;
    assert.equal(Number(citywide.total_text), 20);
    assert.equal(Number(citywide.bucket.results_count), Number(citywide.total_text));
    assert.ok(citywide.preview_ids.length >= 1 && citywide.preview_ids.length <= 3);
    assert.ok(citywide.preview_ids.every((id) => citywide.bucket.listed_ids.includes(id)));
    assert.equal(citywide.destination.record_id, citywide.record_id);

    const suggested = byName.get(`suggested-place-record-${viewport}`).observations;
    assert.deepEqual(suggested.links.map((link) => [link.id, labelCount(link.text)]), [
      ["MN0102", 26], ["MN0402", 12], ["MN0101", 9],
    ]);
    assert.deepEqual(suggested.destinations.map((place) => Number(place.results_count)), [26, 12, 9]);
    assert.equal(suggested.destination.record_id, suggested.record_id);

    const midwood = byName.get(`typed-place-record-${viewport}`).observations;
    assert.equal(midwood.listed_ids.length, 2);
    assert.equal(midwood.destination.record_id, SEPT23_ID);
    assert.equal(midwood.inspect.control_tag, "button");
    assert.equal(midwood.full_link.tag, "a");
    assert.equal(midwood.returned.focus_record_id, SEPT23_ID);
    assert.ok(Math.abs(midwood.returned.scroll_y - midwood.departure.scroll_y) <= 4);

    const unsupported = byName.get(`unsupported-place-escape-${viewport}`).observations;
    assert.equal(unsupported.results_count, null, "an unsupported place never shows a zero");
    assert.equal(new URL(unsupported.escape.href, "https://cityscroll.org").pathname, "/browse/meetings/");
    const zero = byName.get(`explicit-zero-${viewport}`).observations;
    assert.equal(zero.results_count, "0", "a published zero stays a zero");
  }
});

function runDiscoveryValidator(body) {
  return spawnSync("python3", ["-c", `
import copy, json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, "tools"))})
import discovery_recovery_journey as d
LOCAL = json.load(open(${JSON.stringify(DISCOVERY_LOCAL_MANIFEST)}, encoding="utf-8"))
PIN = "c" * 40

class Oracle:
    """Accepts everything except the pairs a case names."""
    def __init__(self, deny=(), changed=()):
        self.deny, self.changed = set(deny), set(changed)
    def resolve(self, ref):
        return "a" * 40 if ref in ("HEAD", d.DEFAULT_BRANCH_REF) else None
    def is_ancestor(self, ancestor, descendant):
        return (ancestor, descendant) not in self.deny
    def file_sha256(self, path):
        return "0" * 64 if path in self.changed else next(
            item["sha256"] for item in LOCAL["provenance"]["measured_inputs"] if item["path"] == path)

def rederive(manifest, mode):
    for row in manifest["captures"]:
        row["assertions"] = d.derive_assertions(row, mode)
        row["outcome"] = d.derive_outcome(row, mode)
    manifest["findings"] = d.derive_findings(manifest["captures"])
    manifest["result"] = d.derive_result(manifest["captures"], mode)
    return manifest

def served():
    manifest = copy.deepcopy(LOCAL)
    manifest["capture_mode"] = d.SERVED_MODE
    manifest.pop("provenance")
    manifest["required_ancestor"] = PIN
    manifest["captures"] = [row for row in manifest["captures"] if row["journey"] in d.FAMILIES]
    for row in manifest["captures"]:
        for response in row["responses"]:
            if response["worker"]:
                response["read_model_version"] = "served-generation"
    identity = {
        "pages_revision": "d" * 40, "worker_revision": "e" * 40, "pages_artifact_hash": "1" * 64,
        "pages_data_receipt_sha256": "2" * 64, "data_generation": "served-generation",
    }
    manifest["identity"] = {"before": dict(identity), "after": dict(identity)}
    return rederive(manifest, d.SERVED_MODE)

DELIVERY = {"landed_commit": PIN}

def refused(code, fn):
    try:
        fn()
    except d.JourneyEvidenceError as error:
        assert error.code == code, (code, str(error))
        return error
    raise SystemExit(f"expected {code} refusal")
${body}
print("checked")
`], { cwd: ROOT, encoding: "utf8" });
}

test("discovery-recovery [A4] the validator accepts the retained proof and refuses each weak shape specifically", () => {
  const result = runDiscoveryValidator(`
local = lambda m, oracle=None: d.validate_manifest(m, mode=d.LOCAL_MODE, git=oracle or Oracle())
# Positive control: the unmodified local proof and a well-formed served manifest pass.
assert local(copy.deepcopy(LOCAL)) == "pass"
assert d.validate_manifest(served(), mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY) == "pass"

# Wrong or pre-squash pins.
m = copy.deepcopy(LOCAL)
refused("wrong-pin", lambda: local(m, Oracle(deny={(m["provenance"]["capture_revision"], "a" * 40)})))
refused("wrong-pin", lambda: d.validate_manifest(served(), mode=d.SERVED_MODE, git=Oracle(deny={(PIN, "a" * 40)}), delivery=DELIVERY))
refused("wrong-pin", lambda: d.validate_manifest(served(), mode=d.SERVED_MODE, git=Oracle(), delivery={"landed_commit": "f" * 40}))
# Pending deployment: a served surface does not contain the landed commit.
error = refused("deploy-pending", lambda: d.validate_manifest(served(), mode=d.SERVED_MODE, git=Oracle(deny={(PIN, "e" * 40)}), delivery=DELIVERY))
assert error.pending
# Missing data: no observations, or a served identity without its data receipt.
m = copy.deepcopy(LOCAL); m["captures"] = []
refused("missing-data", lambda: local(m))
m = served(); del m["identity"]["before"]["pages_data_receipt_sha256"]; m["identity"]["after"] = dict(m["identity"]["before"])
refused("missing-data", lambda: d.validate_manifest(m, mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY))
m = served(); m["captures"] = []
refused("missing-data", lambda: d.validate_manifest(m, mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY))
# Mixed generation: one Worker response from another generation, or identity moved mid-run.
m = copy.deepcopy(LOCAL)
next(r for row in m["captures"] for r in row["responses"] if r["worker"])["read_model_version"] = "capture-other"
refused("mixed-generation", lambda: local(m))
m = served(); m["identity"]["after"]["worker_revision"] = "9" * 40
refused("mixed-generation", lambda: d.validate_manifest(m, mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY))
# A served Worker that names no generation is pending, not a pass.
m = served()
for row in m["captures"]:
    for r in row["responses"]:
        r["read_model_version"] = None
error = refused("deploy-pending", lambda: d.validate_manifest(m, mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY))
assert error.pending
# Missing viewport: a journey absent at one width, or a width not actually applied.
m = copy.deepcopy(LOCAL); m["captures"] = [r for r in m["captures"] if r["name"] != "citywide-bucket-record-phone"]
refused("missing-viewport", lambda: local(m))
m = copy.deepcopy(LOCAL); m["captures"][0]["page"]["viewport"]["width"] = 980
e = refused("assertion-mismatch", lambda: local(m))
e = refused("assertion-failed", lambda: local(rederive(m, d.LOCAL_MODE)))
assert "viewport_applied" in str(e), e
# Nonexistent record, and a subject anchor missing from its destination.
m = copy.deepcopy(LOCAL); row = next(r for r in m["captures"] if r["name"] == "typed-place-record-desktop")
row["observations"]["destination"]["record_id"] = "meeting:not-a-record"
refused("nonexistent-record", lambda: local(rederive(m, d.LOCAL_MODE)))
m = copy.deepcopy(LOCAL); row = next(r for r in m["captures"] if r["name"] == "typed-place-record-desktop")
row["observations"]["destination"].update({"fragment": "agenda-subject", "anchor_present": False})
refused("missing-anchor", lambda: local(rederive(m, d.LOCAL_MODE)))
# Absent capture files: no render hash; no retained proof; no served capture.
m = copy.deepcopy(LOCAL); m["captures"][3]["render"]["sha256"] = None
refused("absent-capture-file", lambda: local(m))
d.LOCAL_MANIFEST_PATH = d.EVIDENCE_DIR / "absent-local-proof.json"
d.SERVED_MANIFEST_PATH = d.EVIDENCE_DIR / "absent-served-capture.json"
refused("absent-capture-file", lambda: d.check(local=True, git=Oracle()))
assert refused("absent-served-capture", lambda: d.check(local=False, git=Oracle())).pending
# Stale inputs after capture.
refused("stale-inputs", lambda: local(copy.deepcopy(LOCAL), Oracle(changed={"site/near_you_view.mjs"})))
# No expected-constant verdicts: stored values must re-derive from observations.
m = copy.deepcopy(LOCAL); row = next(r for r in m["captures"] if r["name"] == "explicit-zero-phone")
row["observations"]["results_count"] = None
refused("assertion-mismatch", lambda: local(m))
m = copy.deepcopy(LOCAL); m["result"] = "pending"
refused("result-mismatch", lambda: local(m))
m = copy.deepcopy(LOCAL); m["findings"] = []
refused("findings-mismatch", lambda: local(m))
# Pending is legitimate only in served mode and only with its evidence.
m = served(); row = next(r for r in m["captures"] if r["name"] == "suggested-place-record-phone")
row["observations"] = {"links": []}; row["pending_obligation"] = "no-suggested-place"
m = rederive(m, d.SERVED_MODE)
assert d.validate_manifest(m, mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY) == "pending"
row["observations"] = {"links": [{"id": "MN0102"}]}
refused("assertion-failed", lambda: d.validate_manifest(rederive(m, d.SERVED_MODE), mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY))
m = copy.deepcopy(LOCAL); row = next(r for r in m["captures"] if r["name"] == "suggested-place-record-phone")
row["observations"] = {"links": []}; row["pending_obligation"] = "no-suggested-place"
refused("assertion-failed", lambda: local(rederive(m, d.LOCAL_MODE)))
# The served manifest refuses loopback observations.
m = served(); m["captures"][0]["page"]["url"] = "http://127.0.0.1:9/"
refused("wrong-surface", lambda: d.validate_manifest(rederive(m, d.SERVED_MODE), mode=d.SERVED_MODE, git=Oracle(), delivery=DELIVERY))
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /checked/);
});

test("discovery-recovery [A4] the served pin is the recorded landed commit on the default branch", () => {
  const delivery = JSON.parse(readFileSync(join(DISCOVERY_DIR, "delivery.json"), "utf8"));
  assert.deepEqual([...delivery.surfaces].sort(), ["pages", "worker"]);
  assert.match(delivery.landed_commit, /^[0-9a-f]{40}$/);
  // Landed means reachable from the checked tree, never a branch-only commit.
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", delivery.landed_commit, "HEAD"], { cwd: ROOT });
  assert.equal(ancestor.status, 0);
  // Converse: an object absent from history is refused as a wrong pin, not a wait.
  const result = runDiscoveryValidator(`
error = refused("wrong-pin", lambda: d.require_landed("0" * 40, d.GitOracle()))
assert "not on the default branch" in error.message or "unavailable" in error.message, error.message
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("discovery-recovery [A5] CLI keeps the scenarios and their modes apart", () => {
  const cases = [
    [["--scenario", "discovery-recovery", "--host-images"], /--host-images applies to the default scenario/],
    [["--local", "--check"], /--local applies to --scenario discovery-recovery/],
    [["--scenario", "discovery-recovery", "--local", "--base", "https://example.test/"], /--local serves the checkout itself/],
    [["--scenario", "other"], /invalid choice/],
  ];
  for (const [args, message] of cases) {
    const result = runCapture(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, message);
  }
  // A served capture refuses any base other than the production site before touching the network.
  const local = runCapture(["--scenario", "discovery-recovery", "--base", "http://127.0.0.1:9/"]);
  assert.equal(local.status, 1);
  assert.match(local.stderr, /refused: wrong-surface: served capture requires the production site/);
});

test("discovery-recovery [A1] every Near You response names the read-model generation it was rendered from", async () => {
  const env = publicationEnv();
  for (const path of ["/", "/near-you/deferred.json?geo=nta2020%3ABK1403&lens=meetings"]) {
    const response = await handleNearYou(new Request(`https://cityscroll.org${path}`), env);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get(READ_MODEL_VERSION_HEADER), "default-local-home", path);
  }
  // Converse: with no published manifest there is no generation to name.
  const unavailable = await handleNearYou(
    new Request("https://cityscroll.org/near-you/?geo=nta2020%3ABK1403"),
    { ALERT_STATE: kv(new Map()) },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get(READ_MODEL_VERSION_HEADER), null);
  const floor = await handleNearYou(new Request("https://cityscroll.org/"), {});
  assert.equal(floor.headers.get(READ_MODEL_VERSION_HEADER), null);
});

async function readCaptureServer(env, path) {
  const server = spawn("node", ["tools/serve_near_you_capture.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      server.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) resolve(out.trim());
      });
      server.stderr.on("data", (chunk) => { err += chunk; });
      server.on("exit", (code) => reject(new Error(`capture server exited ${code}: ${err.slice(0, 300)}`)));
    });
    const response = await fetch(`${base}${path}`);
    return { status: response.status, generation: response.headers.get(READ_MODEL_VERSION_HEADER), body: await response.json() };
  } finally {
    server.kill();
  }
}

test("discovery-recovery [A1] the capture server serves the pinned frozen blob and names it as its generation", async () => {
  const pinned = await readCaptureServer(
    { ...process.env, NEAR_YOU_CAPTURE_ACTIVITY_BLOB: FROZEN_ACTIVITY_BLOB },
    "/near-you/deferred.json?lens=meetings",
  );
  assert.equal(pinned.status, 200);
  assert.equal(pinned.generation, `capture-${FROZEN_ACTIVITY_BLOB.slice(0, 12)}`);
  assert.equal(pinned.body.sections.citywide.count, 20, "the frozen citywide bucket");
  // Converse: without a pin the server keeps reading the working tree, as before.
  const unpinned = await readCaptureServer({ ...process.env, NEAR_YOU_CAPTURE_ACTIVITY_BLOB: "" }, "/near-you/deferred.json?lens=meetings");
  assert.equal(unpinned.generation, "capture");
  await assert.rejects(
    readCaptureServer({ ...process.env, NEAR_YOU_CAPTURE_ACTIVITY_BLOB: "not-a-blob" }, "/near-you/deferred.json"),
    /must be a 40-hex blob id/,
  );
});
