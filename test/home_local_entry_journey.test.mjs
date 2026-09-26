/**
 * Homepage place entry into working Near You meeting journeys.
 *
 * Public alias: c0b9b1f319b51
 *
 * Verify: node --test test/home_local_entry_journey.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createGeographyAddressEntryResolver,
} from "../site/geography_address_entry.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_SOURCES,
  resolveGeographyEntryFromGeolocation,
} from "../site/geography_navigation_entry.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../site/geography_navigation_capability.mjs";
import { loadCivicGeographyLayer } from "../site/civic_geography.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  serializeGeographyNavigationState,
} from "../site/geography_navigation_state.mjs";
import {
  HOME_LOCAL_ENTRY_HEADING,
  HOME_LOCAL_ENTRY_SCHEMA,
  homeLocalEntryNearYouHref,
  homeLocalEntryPayloadLeaksEphemeral,
  homeLocalEntryPublicProjection,
  mountHomeLocalEntry,
  renderHomeLocalEntryHtml,
  resolveHomeLocalEntryQuery,
} from "../site/home_local_entry.mjs";
import {
  GEOGRAPHY_SHELL_USE_LOCATION_LABEL,
} from "../site/geography_navigation_shell.mjs";
import {
  BROADER_DISTRICTS_KICKER,
} from "../site/near_you_broader_districts.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
} from "../site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import { createPrecomputedAddressGeocoder } from "../site/precomputed_address_geocoder.mjs";
import { broaderDistrictsFromCommittedArtifacts } from "../tools/build_worker_route_read_models.mjs";
import { FakeEvent, mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/home-local-entry-journey");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const DELIVERY_PATH = join(EVIDENCE_DIR, "delivery.json");
const REQUIRED_SERVED_ANCESTOR = "239d37d0c08c985113e42d30b7788a84d6d50b8b";
const MODULE_SOURCE = readFileSync(join(ROOT, "site/home_local_entry.mjs"), "utf8");
const HOME_ENTRY_SOURCE = readFileSync(join(ROOT, "site/home_entry.mjs"), "utf8");
const INDEX_SOURCE = SITE_SOURCE;

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const MIDWOOD_GEO = "nta2020:BK1403";
const KENSINGTON_GEO = "nta2020:BK1203";
const KENSINGTON_KEY = "geography:nta2020:BK1203";
const MIDWOOD_POINT = Object.freeze({ latitude: 40.6297346, longitude: -73.9615272 });

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");

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

function productionHelpers() {
  const pad = localDataFetch("site/data/address-index", "/data/address-index/");
  const parcel = localDataFetch("site/data/parcel-geography", "/data/parcel-geography/");
  const geocode = createPrecomputedAddressGeocoder({
    fetchImpl: pad.fetchImpl,
    manifestUrl: "/data/address-index/manifest.json",
  });
  const resolve = createGeographyAddressEntryResolver({
    geocode,
    fetchImpl: parcel.fetchImpl,
    parcelManifestUrl: "/data/parcel-geography/manifest.json",
  });
  return { resolve, geocode, pad, parcel };
}

function broaderSlicesFromActivity(relations) {
  const slices = {};
  for (const relation of relations || []) {
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
  return slices;
}

function nearYouForHref(href, now = "2026-09-23T14:00:00.000Z") {
  const absolute = new URL(href, "https://cityscroll.org").toString();
  return withPinnedClock(now, () => {
    const scope = scopeFromNearYouUrl(absolute);
    const geographyState = parseGeographyNavigationState(new URL(absolute).search);
    const broaderDistricts = geographyState.geo === KENSINGTON_GEO
      ? {
        relations: broaderDistrictsFromCommittedArtifacts()[KENSINGTON_KEY] || [],
        slices: broaderSlicesFromActivity(
          broaderDistrictsFromCommittedArtifacts()[KENSINGTON_KEY] || [],
        ),
      }
      : null;
    const view = buildNearYouViewModel(scope, activity, boundaries, {
      geographyState,
      broaderDistricts,
    });
    const parts = renderNearYouDeferredParts(view);
    return { view, html: parts.resultsHtml, href: absolute };
  });
}

function assertNoEphemeralLeak(entry, queryText = "") {
  assert.equal(homeLocalEntryPayloadLeaksEphemeral(entry), false);
  const serialized = JSON.stringify(entry);
  // Street addresses stay ephemeral. Canonical place labels may appear as the
  // selected geography label and are durable resident copy.
  const query = String(queryText || "").trim();
  if (query && /\d/.test(query)) {
    assert.doesNotMatch(serialized, new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    assert.equal(Object.hasOwn(entry, key), false, key);
  }
  const projection = homeLocalEntryPublicProjection(entry);
  assert.equal(homeLocalEntryPayloadLeaksEphemeral(projection), false);
  if (!entry?.ok) return;
  const historyBag = serializeGeographyNavigationState({
    ok: true,
    geo: entry.selection?.geo,
    key: entry.selection?.key,
    type: entry.selection?.type,
    id: entry.selection?.id,
    surface: "map",
    lens: "meetings",
  });
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    assert.equal(historyBag.has(key), false, key);
  }
  assert.equal(historyBag.has("address"), false);
  assert.equal(historyBag.has("neighborhood"), false);
}

function fakeGeolocation({ grant = null, error = null } = {}) {
  const calls = [];
  return {
    calls,
    getCurrentPosition(success, failure) {
      calls.push({ success: typeof success === "function", failure: typeof failure === "function" });
      if (error) {
        failure?.(error);
        return;
      }
      success?.({
        coords: {
          latitude: grant.latitude,
          longitude: grant.longitude,
          accuracy: 12,
        },
      });
    },
  };
}

function mountHomePanel(options = {}) {
  const html = `<div id="home-host">${renderHomeLocalEntryHtml()}</div>`;
  const { doc, container } = mountDocument(html, { containerClass: "home-host" });
  const root = container.querySelector("[data-home-local-entry]");
  const assigned = [];
  const binder = mountHomeLocalEntry(root, {
    layerData: LAYER_DATA,
    resolveAddress: options.resolveAddress || productionHelpers().resolve,
    geolocation: options.geolocation || null,
    assign: (href) => { assigned.push(href); },
    onResolved: options.onResolved || null,
  });
  return { doc, root, binder, assigned, input: root.querySelector("[data-home-local-input]") };
}

test("homepage markup leads with place entry and keeps Search reachable", () => {
  const local = INDEX_SOURCE.indexOf("data-home-local-entry");
  const topic = INDEX_SOURCE.indexOf("data-home-topic-entry");
  const following = INDEX_SOURCE.indexOf('href="/following/"');
  assert.ok(local > 0 && topic > local, "place entry precedes topic search");
  assert.ok(following > 0, "Following remains reachable");
  assert.match(INDEX_SOURCE, /data-home-local-location/);
  assert.match(INDEX_SOURCE, new RegExp(GEOGRAPHY_SHELL_USE_LOCATION_LABEL));
  assert.match(INDEX_SOURCE, /data-home-local-input/);
  assert.match(INDEX_SOURCE, /data-home-local-browse/);
  assert.match(HOME_ENTRY_SOURCE, /home_local_entry\.mjs/);
  assert.match(HOME_ENTRY_SOURCE, /mountHomeLocalEntry/);
  assert.match(MODULE_SOURCE, /resolveGeographyAddressEntry|geography_address_entry/);
  assert.equal(HOME_LOCAL_ENTRY_SCHEMA, "cityscroll.home_local_entry.v1");
  assert.equal(HOME_LOCAL_ENTRY_HEADING, "What's near you?");
});

test("A1 [outcome] typed Midwood address and Kensington neighborhood from home reach named Near You meetings", async () => {
  const { resolve } = productionHelpers();
  const midwoodResolved = await resolveHomeLocalEntryQuery("810 East 16th Street Brooklyn", {
    layerData: LAYER_DATA,
    resolveAddress: resolve,
  });
  assert.equal(midwoodResolved.entry.ok, true);
  assert.equal(midwoodResolved.entry.selected.id, "BK1403");
  assert.equal(midwoodResolved.entry.selected.label, "Midwood");
  assert.equal(midwoodResolved.entry.selection.geo, MIDWOOD_GEO);
  assert.equal(midwoodResolved.entry.source, GEOGRAPHY_ENTRY_SOURCES.ADDRESS);
  const midwoodHref = homeLocalEntryNearYouHref(midwoodResolved.entry);
  assert.match(midwoodHref, /geo=nta2020%3ABK1403|geo=nta2020:BK1403/);
  assert.match(midwoodHref, /lens=meetings/);
  assertNoEphemeralLeak(midwoodResolved.entry, "810 East 16th Street");

  const midwoodNearYou = await nearYouForHref(midwoodHref);
  const midwoodRecord = (midwoodNearYou.view.results?.records || []).find((row) => row.id === SEPT23_ID);
  assert.ok(midwoodRecord, "September 23 meeting must appear for Midwood");
  assert.equal(midwoodRecord.venue_address, "810 East 16th Street, Brooklyn, NY, 11230");
  assert.match(midwoodNearYou.html, /Held in Midwood/);
  assert.match(midwoodNearYou.html, /810 East 16th Street/);

  const { binder, assigned, input } = mountHomePanel({ resolveAddress: resolve });
  input.value = "810 East 16th Street Brooklyn";
  await binder.submitQuery(input.value);
  assert.equal(assigned.length, 1);
  assert.match(assigned[0], /geo=nta2020%3ABK1403|geo=nta2020:BK1403/);

  const kensingtonResolved = await resolveHomeLocalEntryQuery("Kensington", {
    layerData: LAYER_DATA,
    resolveAddress: resolve,
  });
  assert.equal(kensingtonResolved.entry.ok, true);
  assert.equal(kensingtonResolved.entry.selected.id, "BK1203");
  assert.equal(kensingtonResolved.entry.selected.label, "Kensington");
  assert.equal(kensingtonResolved.entry.source, GEOGRAPHY_ENTRY_SOURCES.PLACE_LABEL);
  const kensingtonHref = homeLocalEntryNearYouHref(kensingtonResolved.entry);
  assert.match(kensingtonHref, /geo=nta2020%3ABK1203|geo=nta2020:BK1203/);
  assertNoEphemeralLeak(kensingtonResolved.entry, "Kensington");

  const kensingtonNearYou = await nearYouForHref(kensingtonHref);
  assert.match(kensingtonNearYou.html, new RegExp(BROADER_DISTRICTS_KICKER));
  assert.match(kensingtonNearYou.html, /data-broader-district="K14"/);
  assert.match(kensingtonNearYou.html, /810 East 16th Street/);
  assert.equal((kensingtonNearYou.view.results?.ids || []).includes(SEPT23_ID), false);
});

test("A2 [outcome] Midwood geolocation grant selects BK1403; denial still allows typing Kensington", async () => {
  const { resolve } = productionHelpers();
  const grantGeo = fakeGeolocation({ grant: MIDWOOD_POINT });
  const granted = [];
  const { binder: grantBinder, assigned: grantAssigned, root: grantRoot } = mountHomePanel({
    resolveAddress: resolve,
    geolocation: grantGeo,
    onResolved: (payload) => granted.push(payload),
  });
  assert.equal(grantGeo.calls.length, 0, "mount must not request geolocation");
  const locationBtn = grantRoot.querySelector("[data-home-local-location]");
  assert.ok(locationBtn);
  locationBtn.dispatchEvent(new FakeEvent("click", { bubbles: true }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(grantGeo.calls.length, 1);
  assert.equal(grantAssigned.length, 1);
  assert.match(grantAssigned[0], /geo=nta2020%3ABK1403|geo=nta2020:BK1403/);
  assert.equal(granted[0]?.entry?.selected?.id, "BK1403");

  const direct = resolveGeographyEntryFromGeolocation(
    MIDWOOD_POINT.longitude,
    MIDWOOD_POINT.latitude,
    { layerData: LAYER_DATA },
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.selected.id, "BK1403");

  const denyGeo = fakeGeolocation({ error: { code: 1, message: "denied" } });
  const { binder: denyBinder, assigned: denyAssigned, root: denyRoot, input } = mountHomePanel({
    resolveAddress: resolve,
    geolocation: denyGeo,
  });
  denyRoot.querySelector("[data-home-local-location]").dispatchEvent(new FakeEvent("click", { bubbles: true }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(denyAssigned.length, 0);
  assert.match(
    denyRoot.querySelector("[data-home-local-status]")?.textContent || "",
    /permission was not granted|Choose an area/i,
  );
  input.value = "Kensington";
  await denyBinder.submitQuery("Kensington");
  assert.equal(denyAssigned.length, 1);
  assert.match(denyAssigned[0], /geo=nta2020%3ABK1203|geo=nta2020:BK1203/);
  assert.equal(denyBinder.panel.isConnected, true);
});

test("A3 [boundary] load issues no geolocation; ephemeral values stay out of URLs; ambiguous Broadway stays usable", async () => {
  const { resolve } = productionHelpers();
  const geo = fakeGeolocation({ grant: MIDWOOD_POINT });
  const { root, binder, assigned, input } = mountHomePanel({
    resolveAddress: resolve,
    geolocation: geo,
  });
  assert.equal(geo.calls.length, 0);
  assert.doesNotMatch(MODULE_SOURCE.slice(0, MODULE_SOURCE.indexOf('locationBtn.addEventListener("click"')), /getCurrentPosition/);

  const ambiguous = await resolveHomeLocalEntryQuery("250 Broadway", {
    layerData: LAYER_DATA,
    resolveAddress: resolve,
  });
  assert.equal(ambiguous.entry.ok, false);
  assert.equal(ambiguous.entry.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_ADDRESS);
  assert.match(ambiguous.entry.recovery.message, /borough or ZIP|choose an area/i);
  assert.equal(homeLocalEntryNearYouHref(ambiguous.entry), null);
  assertNoEphemeralLeak(ambiguous.entry, "250 Broadway");

  input.value = "250 Broadway";
  await binder.submitQuery("250 Broadway");
  assert.equal(assigned.length, 0);
  const status = root.querySelector("[data-home-local-status]");
  assert.match(status?.textContent || "", /borough or ZIP|choose an area/i);
  assert.equal(status?.dataset.refine, "true");
  assert.equal(input.isConnected, true);
  assert.equal(Boolean(root.querySelector("[data-home-local-location]")?.disabled), false);
  assert.equal(root.querySelector("[data-home-local-browse]")?.getAttribute("href"), "/near-you/");

  // Successful destination never carries address or coordinates.
  const ok = await resolveHomeLocalEntryQuery("Midwood", {
    layerData: LAYER_DATA,
    resolveAddress: resolve,
  });
  const href = homeLocalEntryNearYouHref(ok.entry);
  const params = new URL(href, "https://cityscroll.org").searchParams;
  for (const key of [...GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS, "address", "neighborhood", "lat", "lon"]) {
    assert.equal(params.has(key), false, key);
  }
});

test("A4 [verification] capture tool pins served delivery and records run-receipt helpers", () => {
  assert.match(HOME_ENTRY_SOURCE, /import\("\.\/home_local_entry\.mjs"\)/);
  assert.match(MODULE_SOURCE, /resolveGeographyEntryFromPlaceLabel/);
  assert.match(MODULE_SOURCE, /resolveGeographyEntryFromGeolocation/);
  assert.match(MODULE_SOURCE, /geography_address_entry/);
  assert.equal(
    existsSync(join(ROOT, "tools/capture_home_local_entry_journey.py")),
    true,
    "capture tool must exist",
  );

  const captureTool = readFileSync(
    join(ROOT, "tools/capture_home_local_entry_journey.py"),
    "utf8",
  );
  assert.match(captureTool, /def revision_contains_required_ancestor/);
  assert.match(captureTool, /require_served_page_revision_contains_delivery|does not contain required ancestor/);
  assert.match(captureTool, /REQUIRED_ANCESTOR/);
  assert.match(captureTool, /load_recorded_delivery|delivery\.json/);
  assert.match(captureTool, /home-local-entry-journey/);
  assert.match(captureTool, /geolocation-denial/);
  assert.match(captureTool, /deny_geolocation_permission|setting.: .denied/);
  assert.match(captureTool, /capture_run_id/);
  assert.match(captureTool, /validate_run_receipt/);
  assert.match(captureTool, /demonstrate_host_dedup/);
  assert.match(captureTool, /page_load_receipt/);
  assert.match(captureTool, /cf-ray/i);
  assert.match(captureTool, /catbox\.moe/);

  assert.equal(existsSync(DELIVERY_PATH), true, "delivery.json must record the landed Pages pin");
  const delivery = JSON.parse(readFileSync(DELIVERY_PATH, "utf8"));
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal(delivery.public_alias, "c0b9b1f319b51");
  assert.equal(delivery.landed_commit, REQUIRED_SERVED_ANCESTOR);
  assert.equal(delivery.surface, "pages");
});

test("A4 [verification] production capture manifest records hosted dual-width journeys including denial", (t) => {
  if (!existsSync(MANIFEST_PATH)) {
    t.skip("production capture pending after Pages serves the homepage place-entry delivery");
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (manifest.capture_mode !== "headless-playwright-production-served-site") {
    t.skip("production capture pending after Pages serves the homepage place-entry delivery");
    return;
  }
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "home-local-entry-journey");
  assert.equal(manifest.public_alias, "c0b9b1f319b51");
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.capture_mode, "headless-playwright-production-served-site");
  assert.equal(manifest.revision_format, "served artifact-manifest source_commit_sha");
  assert.match(manifest.revision || "", /^[0-9a-f]{40}$/);
  assert.equal(manifest.required_ancestor, REQUIRED_SERVED_ANCESTOR);
  assert.equal(manifest.required_ancestor_contained, true);
  assert.match(String(manifest.capture_run_id || ""), /\S/);
  assert.ok(Array.isArray(manifest.captures) && manifest.captures.length >= 10);

  const requiredViewports = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const viewport of requiredViewports) {
    const rows = manifest.captures.filter(
      (row) => row.viewport?.width === viewport.width && row.viewport?.height === viewport.height,
    );
    assert.ok(rows.length >= 5, `need initial + four journeys at ${viewport.width}x${viewport.height}`);
    assert.ok(rows.some((row) => row.route === "/"), "initial homepage capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("midwood")), "Midwood result capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("kensington-result")), "Kensington result capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("geolocation-grant")), "geolocation grant capture required");
    assert.ok(rows.some((row) => String(row.name || "").includes("geolocation-denial-")), "geolocation denial capture required");
    assert.ok(
      rows.some((row) => String(row.name || "").includes("geolocation-denial-recovery")),
      "geolocation denial recovery capture required",
    );
  }

  const byName = Object.fromEntries(manifest.captures.map((row) => [row.name, row]));
  const digests = new Set();
  for (const row of manifest.captures) {
    assert.ok(row.sha256 && /^[0-9a-f]{64}$/i.test(row.sha256), row.name);
    assert.equal(row.file, null);
    assert.ok(row.assertion);
    assert.equal(row.capture_run_id, manifest.capture_run_id);
    assert.match(row.screenshot_url || "", /^https:\/\//, row.name);
    assert.ok(row.route === "/" || String(row.route || "").startsWith("/near-you/"));
    assert.equal(digests.has(row.sha256), false, `${row.name} must be unique within this packet`);
    digests.add(row.sha256);
  }

  assert.deepEqual(
    (manifest.exact_links || []).slice().sort(),
    [
      "/",
      "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
      "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
    ].sort(),
  );

  for (const suffix of ["desktop", "phone"]) {
    const denial = byName[`home-geolocation-denial-${suffix}`];
    assert.ok(denial, `missing denial capture for ${suffix}`);
    assert.equal(denial.route, "/");
    assert.equal(denial.navigation, "geolocation-denial");
    assert.equal(denial.served_values?.still_on_home, true);
    assert.match(String(denial.served_values?.status_text || ""), /permission was not granted|Choose an area/i);
    assert.equal(denial.served_values?.input_usable, true);

    const recovery = byName[`home-geolocation-denial-recovery-${suffix}`];
    assert.ok(recovery, `missing denial recovery capture for ${suffix}`);
    assert.equal(recovery.navigation, "geolocation-denial-recovery");
    assert.match(recovery.route, /BK1203/);
    assert.equal(recovery.served_values?.geo_in_url, true);
  }

  const receipt = manifest.run_receipt;
  assert.equal(typeof receipt, "object", "manifest carries a run_receipt");
  assert.equal(receipt.capture_run_id, manifest.capture_run_id);
  assert.equal(receipt.served_revision, manifest.revision);
  const runStart = Date.parse(receipt.run_started_at);
  const runEnd = Date.parse(receipt.run_finished_at);
  assert.ok(Number.isFinite(runStart) && Number.isFinite(runEnd) && runEnd >= runStart);

  const demo = receipt.host_dedup_demonstration;
  assert.equal(typeof demo, "object");
  assert.equal(demo.first_upload.returned_url, demo.repeat_same_bytes.returned_url);
  assert.notEqual(demo.altered_one_byte.returned_url, demo.first_upload.returned_url);
  assert.equal(demo.same_bytes_returned_same_url, true);
  assert.equal(demo.altered_bytes_returned_different_url, true);

  for (const row of manifest.captures) {
    const rowReceipt = row.run_receipt;
    assert.equal(typeof rowReceipt, "object", `${row.name} carries a per-row run receipt`);
    assert.equal(rowReceipt.capture_run_id, manifest.capture_run_id);
    const capturedAt = Date.parse(rowReceipt.captured_at);
    assert.ok(capturedAt >= runStart && capturedAt <= runEnd, `${row.name} captured inside the run window`);
    assert.equal(rowReceipt.page_load.http_status, 200, `${row.name} page loaded with a 200`);
    assert.match(
      String(rowReceipt.page_load.headers["cf-ray"] || ""),
      /^[0-9a-f]{16}-[A-Z0-9]{2,4}$/,
      `${row.name} records a per-request CF-Ray`,
    );
    assert.ok(rowReceipt.page_load.headers.date, `${row.name} records the served Date`);
    assert.equal(rowReceipt.page_load.served_revision, manifest.revision);
    assert.equal(rowReceipt.upload.returned_url, row.screenshot_url);
    assert.equal(typeof rowReceipt.upload.http_status, "number");
    assert.equal(rowReceipt.click_observation.navigation, row.navigation);
  }

  const digest = createHash("sha256").update(readFileSync(MANIFEST_PATH)).digest("hex");
  assert.equal(digest.length, 64);
});
