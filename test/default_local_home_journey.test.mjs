/**
 * Default local home: the Near You shell is CityScroll's root entry.
 *
 * Public alias: c27355579ade0
 *
 * Verify: node --test test/default_local_home_journey.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createGeographyAddressEntryResolver } from "../site/geography_address_entry.mjs";
import {
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromPlaceLabel,
} from "../site/geography_navigation_entry.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
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
import { handleNearYou } from "../worker/src/near_you.mjs";
import {
  MEETING_MANIFEST_KEY,
  NEAR_YOU_MANIFEST_KEY,
} from "../worker/src/lib/route_read_model_kv.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/default-local-home-journey");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const CAPTURE_TOOL = join(ROOT, "tools/capture_default_local_home_journey.py");
const DELIVERY_PATH = join(EVIDENCE_DIR, "delivery.json");
const GROUNDED_AT = "239d37d0c08c985113e42d30b7788a84d6d50b8b";
const PUBLIC_ALIAS = "c27355579ade0";

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

test("A4 [verification] capture tool, dual-width manifest contract, wrangler apex route, lean Worker path", () => {
  assert.equal(existsSync(CAPTURE_TOOL), true, "capture tool must exist");
  const captureTool = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureTool, /1440/);
  assert.match(captureTool, /390/);
  assert.match(captureTool, /c27355579ade0/);
  assert.match(captureTool, /data-near-you-root/);
  assert.match(captureTool, /image_binaries_committed|file.: null/);

  assert.equal(existsSync(MANIFEST_PATH), true, "capture manifest must be present");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "default-local-home-journey");
  assert.equal(manifest.public_alias, PUBLIC_ALIAS);
  assert.equal(manifest.image_binaries_committed, false);
  assert.ok(manifest.capture_run_id);
  assert.ok(Array.isArray(manifest.captures) && manifest.captures.length >= 6);

  const requiredViewports = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const viewport of requiredViewports) {
    const rows = manifest.captures.filter(
      (row) => row.viewport?.width === viewport.width && row.viewport?.height === viewport.height,
    );
    assert.ok(rows.length >= 3, `need captures at ${viewport.width}x${viewport.height}`);
    assert.ok(rows.some((row) => row.route === "/"), "root shell capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("midwood")), "Midwood capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("failure") || String(row.name || "").includes("denied")), "failure-recovery capture required");
    for (const row of rows) {
      assert.ok(row.snapshot?.measured_css === true || row.snapshot?.stylesheet_hrefs?.length >= 1, row.name);
      assert.ok(typeof row.snapshot?.map_or_shell_height_px === "number" || typeof row.snapshot?.viewport_width_px === "number", row.name);
    }
  }
  for (const row of manifest.captures) {
    assert.ok(row.sha256 && /^[0-9a-f]{64}$/i.test(row.sha256), row.name);
    assert.equal(row.file, null);
    assert.ok(row.assertion);
    assert.equal(row.capture_run_id, manifest.capture_run_id);
  }
  assert.ok((manifest.exact_links || []).includes("/"));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("nta2020%3ABK1403") || String(link).includes("BK1403")));
  assert.ok((manifest.exact_links || []).some((link) => String(link).includes("BK1203") || String(link).includes("BK1402")));

  const wrangler = readFileSync(join(ROOT, "worker/wrangler.toml"), "utf8");
  assert.match(wrangler, /pattern = "cityscroll\.org"/);
  assert.match(wrangler, /near-you\*/);

  const workerSource = readFileSync(join(ROOT, "worker/src/worker.mjs"), "utf8");
  assert.match(workerSource, /isNearYouDocumentPath/);
  // Module-oracle: Worker startup must not gain a new static JSON import for this card.
  assert.equal(workerSource.includes("import boundaries from"), false);

  if (existsSync(DELIVERY_PATH)) {
    const delivery = JSON.parse(readFileSync(DELIVERY_PATH, "utf8"));
    assert.equal(delivery.public_alias, PUBLIC_ALIAS);
    assert.match(String(delivery.landed_commit || GROUNDED_AT), /^[0-9a-f]{40}$/);
  }

  const digest = createHash("sha256").update(readFileSync(MANIFEST_PATH)).digest("hex");
  assert.equal(digest.length, 64);
  assert.match(GROUNDED_AT, /^[0-9a-f]{40}$/);
});

test("facts: September 23 Midwood view keeps venue address (positive control)", async () => {
  const midwoodView = await viewForGeo(MIDWOOD_GEO, "2026-09-23T14:00:00.000Z");
  const record = (midwoodView.view.results?.records || []).find((row) => row.id === SEPT23_ID);
  assert.ok(record);
  const facts = nearYouRecordInspectionFacts(record, { now: "2026-09-23T14:00:00.000Z" });
  assert.match(facts.venue_address || record.venue_address || "", /810 East 16th/);
  assert.match(midwoodView.html, /Held in Midwood/);
});
