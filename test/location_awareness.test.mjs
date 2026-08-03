import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const indexSource = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const {
  bindLocationControl,
  coarseLandFilter,
  resetCouncilBoundariesCache,
  resolveLandEntryLocation,
} = require("../site/location_awareness.js");
const {
  buildSearchDeepLink,
  canonicalSearchURL,
} = require("../site/nl_deeplink.js");

const COUNCIL_LAYER = {
  schema: "cityscroll.district_boundaries.v0",
  layer: "council_district",
  dataset_id: "872g-cjhh",
  boundary_vintage: "2026-05-26",
  districts: [{
    id: "25",
    label: "City Council District 25",
    bbox: [-73.89, 40.74, -73.87, 40.755],
    polygons: [{
      rings: [[
        [-73.89, 40.74],
        [-73.87, 40.74],
        [-73.87, 40.755],
        [-73.89, 40.755],
        [-73.89, 40.74],
      ]],
    }],
  }],
};

function locationOptions(extra) {
  return {
    councilBoundaries: COUNCIL_LAYER,
    ...extra,
  };
}

function locationButton() {
  return {
    disabled: false,
    listener: null,
    addEventListener(event, listener) {
      assert.equal(event, "click");
      this.listener = listener;
    },
    async click() {
      assert.ok(this.listener, "location control is wired");
      await this.listener();
    },
  };
}

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("the tap control requests a position and GeoSearch only after activation", async () => {
  resetCouncilBoundariesCache();
  const button = locationButton();
  const calls = { permission: 0, fetch: [] };
  let resolved = null;
  const geolocation = {
    getCurrentPosition(success) {
      calls.permission++;
      success({ coords: { latitude: 40.7473, longitude: -73.8832 } });
    },
  };
  const fetchImpl = async (url) => {
    calls.fetch.push(url);
    if (url.includes("MAPPLUTO")) {
      return {
        ok: true,
        async json() {
          return { features: [{ attributes: { CD: 404 } }] };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          features: [{
            geometry: { type: "Point", coordinates: [-73.883189, 40.747305] },
            properties: {
              label: "40-12 83 Street, Elmhurst, NY, USA",
              borough: "Queens",
              neighbourhood: "Elmhurst",
              addendum: { pad: { bbl: "4014930012" } },
            },
          }],
        };
      },
    };
  };

  bindLocationControl(button, locationOptions({
    geolocation,
    fetchImpl,
    onResolved(area) {
      resolved = area;
    },
  }));

  assert.equal(calls.permission, 0, "wiring the page never asks for location");
  assert.equal(calls.fetch.length, 0, "wiring the page never contacts GeoSearch");
  await button.click();

  assert.equal(calls.permission, 1);
  assert.equal(calls.fetch.length, 2);
  const request = new URL(calls.fetch[0]);
  assert.equal(request.origin + request.pathname, "https://geosearch.planninglabs.nyc/v2/reverse");
  assert.equal(request.searchParams.get("point.lat"), "40.7473");
  assert.equal(request.searchParams.get("point.lon"), "-73.8832");
  assert.deepEqual(resolved, {
    borough: "Queens",
    neighbourhood: "Elmhurst",
    label: "40-12 83 Street, Elmhurst, NY, USA",
    bbl: "4014930012",
    block: "401493",
    communityDistrict: "Q04",
    councilDistrict: "25",
  });
  assert.equal("latitude" in resolved, false);
  assert.equal("longitude" in resolved, false);
});

test("an existing geolocation grant resolves the returning user's area without a tap", async () => {
  resetCouncilBoundariesCache();
  const calls = { permission: 0, position: 0, fetch: 0 };
  let resolved = null;
  const area = await resolveLandEntryLocation(locationOptions({
    permissions: {
      async query(descriptor) {
        calls.permission++;
        assert.deepEqual(descriptor, { name: "geolocation" });
        return { state: "granted" };
      },
    },
    geolocation: {
      getCurrentPosition(success) {
        calls.position++;
        success({ coords: { latitude: 40.7473, longitude: -73.8832 } });
      },
    },
    async fetchImpl(url) {
      calls.fetch++;
      return {
        ok: true,
        async json() {
          return url.includes("MAPPLUTO")
            ? { features: [{ attributes: { CD: 404 } }] }
            : {
                features: [{
                  properties: {
                    label: "40-12 83 Street, Elmhurst, NY, USA",
                    borough: "Queens",
                    neighbourhood: "Elmhurst",
                    addendum: { pad: { bbl: "4014930012" } },
                  },
                }],
              };
        },
      };
    },
    onResolved(value) {
      resolved = value;
    },
  }));

  assert.equal(calls.permission, 1);
  assert.equal(calls.position, 1);
  assert.equal(calls.fetch, 2);
  assert.equal(area, resolved);
  assert.equal(resolved.communityDistrict, "Q04");
  assert.equal(resolved.councilDistrict, "25");
});

test("a first prompt-state Land entry asks once and dismissal preserves the tap fallback", async () => {
  const storage = memoryStorage();
  let positions = 0;
  let fetches = 0;
  const options = {
    permissions: {
      async query(descriptor) {
        assert.deepEqual(descriptor, { name: "geolocation" });
        return { state: "prompt" };
      },
    },
    storage,
    geolocation: {
      getCurrentPosition(_success, dismissed) {
        positions++;
        assert.equal(
          storage.getItem("crol_land_location_auto_asked_v1"),
          "1",
          "the latch is recorded before the browser prompt opens",
        );
        dismissed({ code: 1 });
      },
    },
    async fetchImpl() {
      fetches++;
    },
  };

  assert.equal(await resolveLandEntryLocation(options), null);
  assert.equal(await resolveLandEntryLocation(options), null);
  assert.equal(positions, 1, "dismissal must consume the once-ever automatic ask");
  assert.equal(fetches, 0);
});

test("asked-before prompt and denied states keep the explicit-tap/manual paths", async () => {
  for (const fixture of [
    { state: "prompt", asked: "1" },
    { state: "denied", asked: null },
  ]) {
    let positions = 0;
    let fetches = 0;
    let resolutions = 0;
    const storage = memoryStorage(
      fixture.asked ? { crol_land_location_auto_asked_v1: fixture.asked } : {},
    );
    const area = await resolveLandEntryLocation({
      permissions: {
        async query(descriptor) {
          assert.deepEqual(descriptor, { name: "geolocation" });
          return { state: fixture.state };
        },
      },
      storage,
      geolocation: {
        getCurrentPosition() {
          positions++;
        },
      },
      async fetchImpl() {
        fetches++;
      },
      onResolved() {
        resolutions++;
      },
    });

    assert.equal(area, null, `${fixture.state} must not resolve an area`);
    assert.equal(positions, 0, `${fixture.state} must not request a position`);
    assert.equal(fetches, 0, `${fixture.state} must not contact GeoSearch`);
    assert.equal(resolutions, 0, `${fixture.state} must not alter the Land view`);
  }
});

test("missing or unusable Permissions API support falls back to the tap affordance", async () => {
  for (const permissions of [
    null,
    {},
    { query() { throw new Error("unsupported descriptor"); } },
  ]) {
    let positions = 0;
    const area = await resolveLandEntryLocation({
      permissions,
      storage: memoryStorage(),
      geolocation: {
        getCurrentPosition() {
          positions++;
        },
      },
      async fetchImpl() {
        throw new Error("GeoSearch must not run without an existing grant");
      },
    });
    assert.equal(area, null);
    assert.equal(positions, 0);
  }
});

test("an unavailable localStorage latch fails closed to the tap affordance", async () => {
  let positions = 0;
  const area = await resolveLandEntryLocation({
    permissions: {
      async query() {
        return { state: "prompt" };
      },
    },
    storage: {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("storage unavailable");
      },
    },
    geolocation: {
      getCurrentPosition() {
        positions++;
      },
    },
    async fetchImpl() {
      throw new Error("GeoSearch must not run without a durable latch");
    },
  });
  assert.equal(area, null);
  assert.equal(positions, 0);
});

test("denial and an unavailable Geolocation API leave the current view unchanged", async () => {
  for (const geolocation of [
    null,
    { getCurrentPosition(_success, denied) { denied({ code: 1 }); } },
  ]) {
    const button = locationButton();
    let fetches = 0;
    let resolutions = 0;
    bindLocationControl(button, {
      geolocation,
      async fetchImpl() {
        fetches++;
        throw new Error("GeoSearch must not run without a position");
      },
      onResolved() {
        resolutions++;
      },
    });
    await button.click();
    assert.equal(fetches, 0);
    assert.equal(resolutions, 0);
    assert.equal(button.disabled, false);
  }
});

test("a located Land view emits only its resolved coarse area", () => {
  const filter = coarseLandFilter({
    borough: "Queens",
    neighbourhood: "Elmhurst",
    label: "40-12 83 Street, Elmhurst, NY, USA",
    bbl: "4014930012",
    block: "401493",
    communityDistrict: "Q04",
    councilDistrict: "25",
  }, "active");
  const hash = buildSearchDeepLink("land", filter);
  const url = canonicalSearchURL(
    { origin: "https://cityscroll.org", pathname: "/" },
    hash,
  );

  assert.equal(hash, "#land?boro=Queens&cd=Q04&council=25");
  assert.equal(url, "https://cityscroll.org/#land?boro=Queens&cd=Q04&council=25");
  assert.doesNotMatch(url, /(?:lat|latitude|lon|longitude|40\.7473|-73\.8832|4014930012)/i);
});

test("missing council boundaries leave councilDistrict unset without failing the area", async () => {
  resetCouncilBoundariesCache();
  const button = locationButton();
  let resolved = null;
  bindLocationControl(button, {
    geolocation: {
      getCurrentPosition(success) {
        success({ coords: { latitude: 40.7473, longitude: -73.8832 } });
      },
    },
    async fetchImpl(url) {
      if (String(url).includes("council_district_boundaries")) {
        return { ok: false, async json() { return {}; } };
      }
      if (String(url).includes("MAPPLUTO")) {
        return { ok: true, async json() { return { features: [{ attributes: { CD: 404 } }] }; } };
      }
      return {
        ok: true,
        async json() {
          return {
            features: [{
              properties: {
                label: "40-12 83 Street, Elmhurst, NY, USA",
                borough: "Queens",
                neighbourhood: "Elmhurst",
                addendum: { pad: { bbl: "4014930012" } },
              },
            }],
          };
        },
      };
    },
    onResolved(area) { resolved = area; },
  });
  await button.click();
  assert.equal(resolved.communityDistrict, "Q04");
  assert.equal(resolved.councilDistrict, undefined);
});

test("the Land control is a translated, focusable button wired through the click gate", () => {
  assert.match(indexSource, /<button[^>]+id="landlocation"[^>]+data-i18n="use_my_location"/);
  assert.match(indexSource, /#landlocation\{min-height:32px;/);
  assert.match(indexSource, /bindLocationControl\(\$\("#landlocation"\)/);
  assert.match(indexSource, /if\(name==="land"\)[\s\S]{0,400}maybeAutoLocateLand\(\)/);
  assert.doesNotMatch(indexSource, /(?:DOMContentLoaded|addEventListener\("load")[\s\S]{0,300}getCurrentPosition/);
});
