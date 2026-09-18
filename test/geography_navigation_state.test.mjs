// Durable Near You geography selection URL state.
//
//   node --test test/geography_navigation_state.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE,
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  GEOGRAPHY_NAVIGATION_RECOVERY_REASONS,
  GEOGRAPHY_NAVIGATION_STATE_SCHEMA,
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  bindGeographyNavigationPopState,
  canonicalizeGeographyNavigationUrl,
  geographyNavigationPayloadLeaksEphemeral,
  geographyNavigationStateFromLegacyMapHash,
  geographyNavigationStateFromStaticPath,
  geographyNavigationUrlFromState,
  isStaticNearYouPath,
  normalizeGeographyNavigationLocation,
  omitGeographyNavigationEphemeral,
  parseGeographyNavigationState,
  readGeographyNavigationHistory,
  scopeWithGeographyNavigationState,
  serializeGeographyNavigationState,
  writeGeographyNavigationHistory,
} from "../site/geography_navigation_state.mjs";
import {
  emptyScope,
  geographyKeysFromScope,
  nearYouUrlFromScope,
  scopeFromRouteHash,
} from "../site/scope_v0.mjs";

const ROOT = process.cwd();
const MODULE_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_state.mjs"), "utf8");

function memorySession() {
  const entries = [{ url: "/near-you/", state: null }];
  let index = 0;
  const location = {
    pathname: "/near-you/",
    search: "",
    href: "https://cityscroll.invalid/near-you/",
  };
  const syncLocation = (url) => {
    const next = new URL(url, "https://cityscroll.invalid/near-you/");
    location.pathname = next.pathname;
    location.search = next.search;
    location.href = next.toString();
  };
  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state, url: String(url) });
      index = entries.length - 1;
      syncLocation(url);
    },
    replaceState(state, _title, url) {
      entries[index] = { state, url: String(url) };
      syncLocation(url);
    },
    back() {
      if (index <= 0) return;
      index -= 1;
      syncLocation(entries[index].url);
      target.dispatchEvent({ type: "popstate", state: entries[index].state });
    },
    forward() {
      if (index >= entries.length - 1) return;
      index += 1;
      syncLocation(entries[index].url);
      target.dispatchEvent({ type: "popstate", state: entries[index].state });
    },
  };
  const listeners = new Map();
  const target = {
    history,
    location,
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((entry) => entry !== handler));
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
  };
  return { history, location, target, entries: () => entries, index: () => index };
}

/* ===== A1: canonical round-trip keeps selection, comparison, surface, lens ===== */

test("A1 geo+compare+surface round-trips to the same canonical state and keeps the lens", () => {
  const input = "/near-you/?geo=nta2020%3ABK1503&compare=council_district&surface=map&lens=meetings";
  const state = parseGeographyNavigationState(input);
  assert.equal(state.schema, GEOGRAPHY_NAVIGATION_STATE_SCHEMA);
  assert.equal(state.ok, true);
  assert.equal(state.geo, "nta2020:BK1503");
  assert.equal(state.key, "geography:nta2020:BK1503");
  assert.equal(state.type, "nta2020");
  assert.equal(state.id, "BK1503");
  assert.equal(state.compare, "council_district");
  assert.equal(state.surface, GEOGRAPHY_NAVIGATION_SURFACE_MAP);
  assert.equal(state.lens, "meetings");
  assert.equal(state.recovery, null);

  const url = geographyNavigationUrlFromState(state);
  assert.match(url, /geo=nta2020%3ABK1503/);
  assert.match(url, /compare=council_district/);
  assert.match(url, /surface=map/);
  assert.match(url, /lens=meetings/);

  const again = parseGeographyNavigationState(url);
  assert.deepEqual(
    {
      geo: again.geo,
      key: again.key,
      compare: again.compare,
      surface: again.surface,
      lens: again.lens,
      ok: again.ok,
    },
    {
      geo: "nta2020:BK1503",
      key: "geography:nta2020:BK1503",
      compare: "council_district",
      surface: "map",
      lens: "meetings",
      ok: true,
    },
  );
  assert.equal(canonicalizeGeographyNavigationUrl(input), url);
});

test("A1 full geography: keys normalize onto the short geo token", () => {
  const state = parseGeographyNavigationState({
    geo: "geography:nta2020:BK1503",
    compare: "community_district",
    surface: "records",
    lens: "land",
  });
  assert.equal(state.geo, "nta2020:BK1503");
  assert.equal(state.key, "geography:nta2020:BK1503");
  assert.equal(state.surface, GEOGRAPHY_NAVIGATION_SURFACE_RECORDS);
  const params = serializeGeographyNavigationState(state, { includeDefaults: true });
  assert.equal(params.get("geo"), "nta2020:BK1503");
  assert.equal(params.get("surface"), "records");
});

/* ===== A2: only registered types and valid ids ===== */

test("A2 invalid type/id pairs cannot reach selection state", () => {
  const unknownLayer = parseGeographyNavigationState("geo=state_assembly:42&surface=map");
  assert.equal(unknownLayer.ok, false);
  assert.equal(unknownLayer.geo, null);
  assert.equal(unknownLayer.key, null);
  assert.equal(unknownLayer.recovery.reason, GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNKNOWN_LAYER);

  const badId = parseGeographyNavigationState("geo=nta2020:NOTREAL&compare=council_district");
  assert.equal(badId.ok, false);
  assert.equal(badId.key, null);
  assert.equal(badId.recovery.reason, GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.INVALID_ID);

  const badCompare = parseGeographyNavigationState("geo=nta2020:BK1503&compare=sanitation_district");
  assert.equal(badCompare.ok, false);
  assert.equal(badCompare.recovery.reason, GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNKNOWN_COMPARE);

  const scoped = scopeWithGeographyNavigationState(emptyScope(), badId);
  assert.deepEqual(geographyKeysFromScope(scoped), []);
});

test("A2 only first-slice public navigation types are selectable", () => {
  for (const [geo, type] of [
    ["nta2020:BK1503", "nta2020"],
    ["community_district:K15", "community_district"],
    ["council_district:48", "council_district"],
    ["police_precinct:61", "police_precinct"],
  ]) {
    const state = parseGeographyNavigationState({ geo, surface: "map" });
    assert.equal(state.ok, true, geo);
    assert.equal(state.type, type, geo);
    assert.equal(state.key, `geography:${geo}`);
  }
});

/* ===== A3: coordinates, address, hover, viewport never durable ===== */

test("A3 coordinates, address text, hover, and precise viewport never enter durable output", () => {
  const leaky = {
    geo: "nta2020:BK1503",
    compare: "council_district",
    surface: "map",
    lat: "40.5869",
    lng: "-73.9542",
    address: "1208 Sheepshead Bay Road",
    hover: "nta2020:BK1503",
    viewport: { zoom: 14, center: [-73.95, 40.58] },
    view_box: "0 0 100 100",
  };
  const state = parseGeographyNavigationState(leaky);
  const params = serializeGeographyNavigationState(state, { includeDefaults: true });
  const url = geographyNavigationUrlFromState(state);
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    assert.equal(params.has(key), false, key);
    assert.equal(new URL(url, "https://cityscroll.invalid").searchParams.has(key), false, key);
  }
  assert.equal(geographyNavigationPayloadLeaksEphemeral(params), false);
  assert.equal(geographyNavigationPayloadLeaksEphemeral(url), false);

  const cleaned = omitGeographyNavigationEphemeral(leaky);
  assert.equal("lat" in cleaned, false);
  assert.equal("address" in cleaned, false);
  assert.equal("hover" in cleaned, false);
  assert.equal("viewport" in cleaned, false);
  assert.equal(cleaned.geo, "nta2020:BK1503");

  // Storage / analytics shaped bags stay clean after omit.
  const storageBag = omitGeographyNavigationEphemeral({
    ...leaky,
    session: true,
  });
  assert.equal(geographyNavigationPayloadLeaksEphemeral(storageBag), false);
  assert.match(MODULE_SOURCE, /GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS/);
  assert.doesNotMatch(MODULE_SOURCE, /localStorage\.setItem\([^\)]*(lat|address|hover)/i);
});

/* ===== A4: history traversal restores selection + UI chrome ===== */

test("A4 direct load, refresh, Back, and Forward restore selection chrome", () => {
  const session = memorySession();
  const first = parseGeographyNavigationState({
    geo: "nta2020:BK1503",
    compare: "council_district",
    surface: "map",
    drawer: "open",
    focus: "nta2020:BK1503",
    lens: "meetings",
  });
  writeGeographyNavigationHistory(session.history, session.location, first, { mode: "replace" });

  const second = parseGeographyNavigationState({
    geo: "community_district:K15",
    compare: "nta2020",
    surface: "records",
    drawer: "closed",
    focus: "community_district:K15",
    lens: "land",
  });
  writeGeographyNavigationHistory(session.history, session.location, second, { mode: "push" });

  const restored = [];
  const stop = bindGeographyNavigationPopState(session.target, (state) => restored.push(state));

  // Refresh / direct load reads the current location.
  const refresh = parseGeographyNavigationState(`${session.location.pathname}${session.location.search}`);
  assert.equal(refresh.geo, "community_district:K15");
  assert.equal(refresh.surface, "records");
  assert.equal(refresh.drawer, "closed");
  assert.equal(refresh.focus, "community_district:K15");
  assert.equal(refresh.lens, "land");

  session.history.back();
  assert.equal(restored.at(-1).geo, "nta2020:BK1503");
  assert.equal(restored.at(-1).compare, "council_district");
  assert.equal(restored.at(-1).surface, "map");
  assert.equal(restored.at(-1).drawer, "open");
  assert.equal(restored.at(-1).focus, "nta2020:BK1503");
  assert.equal(restored.at(-1).lens, "meetings");

  session.history.forward();
  assert.equal(restored.at(-1).geo, "community_district:K15");
  assert.equal(restored.at(-1).lens, "land");
  assert.equal(restored.at(-1).surface, "records");

  const fromHistory = readGeographyNavigationHistory(session.location, session.history.state);
  assert.equal(fromHistory.geo, "community_district:K15");
  stop();
});

test("A4 replaceState normalizes encodings without adding a history entry", () => {
  const session = memorySession();
  session.location.pathname = "/near-you/";
  session.location.search = "?geo=geography%3Anta2020%3ABK1503&surface=map&surface=records&lat=40.5";
  session.location.href = `https://cityscroll.invalid/near-you/${session.location.search}`;
  session.history.replaceState(null, "", `${session.location.pathname}${session.location.search}`);

  const before = session.entries().length;
  const result = normalizeGeographyNavigationLocation(session.history, session.location);
  assert.equal(result.changed, true);
  assert.equal(session.entries().length, before);
  assert.equal(result.state.geo, "nta2020:BK1503");
  assert.equal(result.state.surface, GEOGRAPHY_NAVIGATION_DEFAULT_SURFACE);
  assert.equal(session.location.search.includes("lat="), false);
  assert.equal(session.location.search.includes("geography%3Anta2020"), false);
});

/* ===== A5: legacy hashes and static paths ===== */

test("A5 supported legacy map hashes reach equivalent enhanced selection", () => {
  const community = geographyNavigationStateFromLegacyMapHash(
    "#map?level=community_district&id=K15&lens=meetings",
  );
  assert.equal(community.ok, true);
  assert.equal(community.geo, "community_district:K15");
  assert.equal(community.key, "geography:community_district:K15");
  assert.equal(community.lens, "meetings");
  assert.equal(community.source, "legacy_map_hash");

  const council = geographyNavigationStateFromLegacyMapHash("#map?level=council_district&id=48&lens=land");
  assert.equal(council.geo, "council_district:48");
  assert.equal(council.lens, "land");

  const bare = geographyNavigationStateFromLegacyMapHash("#map");
  assert.equal(bare.ok, true);
  assert.equal(bare.geo, null);
  assert.equal(bare.recovery, null);
});

test("A5 static Near You area links remain server destinations; stale keys recover", () => {
  assert.equal(isStaticNearYouPath("/near-you/"), true);
  assert.equal(isStaticNearYouPath("/near-you/borough/brooklyn/"), true);
  assert.equal(isStaticNearYouPath("/near-you/borough/brooklyn/land/"), true);
  assert.equal(isStaticNearYouPath("/near-you/lens/meetings/"), true);
  assert.equal(isStaticNearYouPath("/near-you/?geo=nta2020:BK1503"), true);

  const staticState = geographyNavigationStateFromStaticPath("/near-you/borough/brooklyn/land/");
  assert.equal(staticState.ok, true);
  assert.equal(staticState.source, "static_path");
  assert.equal(staticState.static_path, "/near-you/borough/brooklyn/land/");
  assert.equal(staticState.lens, "land");
  assert.equal(staticState.geo, null);

  const stale = parseGeographyNavigationState("geo=nta2020:ZZ9999&surface=map");
  assert.equal(stale.ok, false);
  assert.match(stale.recovery.explanation, /unselected|not valid|not recognized/i);
  assert.equal(stale.geo, null);
});

/* ===== A6: URL state selects materialized scope only ===== */

test("A6 URL state never invents record membership; it only names a geography key", () => {
  const state = parseGeographyNavigationState({
    geo: "nta2020:BK1503",
    compare: "council_district",
    surface: "map",
    lens: "meetings",
  });
  const scope = scopeWithGeographyNavigationState(emptyScope(), state);
  assert.deepEqual(geographyKeysFromScope(scope), ["geography:nta2020:BK1503"]);
  assert.deepEqual(scope.facets.domains, ["meetings"]);
  // No synthetic record ids, counts, or membership arrays appear on the scope.
  assert.equal(scope.records, undefined);
  assert.equal(scope.membership, undefined);
  assert.equal(scope.items, undefined);

  const wire = nearYouUrlFromScope(scope);
  assert.match(wire, /geo=geography%3Anta2020%3ABK1503|geo=nta2020/);
  // Compare/surface are presentation beside scope, not membership.
  const enhanced = geographyNavigationUrlFromState(state);
  assert.match(enhanced, /compare=council_district/);
  assert.equal(enhanced.includes("membership="), false);
});

/* ===== A7: malformed encodings, duplicates, unknown layers, special-use, history, leakage ===== */

test("A7 malformed encodings and duplicate params stay deterministic", () => {
  const malformed = parseGeographyNavigationState("geo=%E0%A4%A&surface=map");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.geo, null);

  const duplicate = parseGeographyNavigationState(
    "geo=nta2020:BK1503&geo=nta2020:MN0102&compare=council_district&compare=police_precinct&surface=map",
  );
  assert.equal(duplicate.geo, "nta2020:BK1503");
  assert.equal(duplicate.compare, "council_district");

  const unknown = parseGeographyNavigationState("geo=business_improvement_district:soho&surface=map");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.recovery.reason, GEOGRAPHY_NAVIGATION_RECOVERY_REASONS.UNKNOWN_LAYER);
});

test("A7 special-use NTA keys remain selectable by id pattern", () => {
  // Park / cemetery / airport codes still match the NTA id grammar; label policy
  // is owned by the capability, not by URL membership.
  const park = parseGeographyNavigationState({ geo: "nta2020:BK0991", surface: "map" });
  assert.equal(park.ok, true);
  assert.equal(park.type, "nta2020");
  assert.equal(park.id, "BK0991");
  assert.equal(park.key, "geography:nta2020:BK0991");
});

test("A7 history traversal and leakage negatives are covered together", () => {
  const session = memorySession();
  const selected = parseGeographyNavigationState({
    geo: "nta2020:BK1503",
    compare: "council_district",
    surface: "map",
    drawer: "open",
    focus: "feature:nta2020:BK1503",
    lens: "property",
  });
  writeGeographyNavigationHistory(session.history, session.location, selected, { mode: "push" });
  writeGeographyNavigationHistory(
    session.history,
    session.location,
    parseGeographyNavigationState({ geo: "council_district:48", surface: "records", lens: "money" }),
    { mode: "push" },
  );

  const seen = [];
  bindGeographyNavigationPopState(session.target, (state) => seen.push(state.geo));
  session.history.back();
  session.history.forward();
  assert.deepEqual(seen, ["nta2020:BK1503", "council_district:48"]);

  const params = serializeGeographyNavigationState(selected, { includeDefaults: true });
  assert.equal(geographyNavigationPayloadLeaksEphemeral({
    ...Object.fromEntries(params.entries()),
    address: "should not remain",
  }), true);
  assert.equal(geographyNavigationPayloadLeaksEphemeral(Object.fromEntries(params.entries())), false);
});

test("A7 compare equal to the selected layer is omitted rather than duplicated", () => {
  const state = parseGeographyNavigationState({
    geo: "nta2020:BK1503",
    compare: "nta2020",
    surface: "map",
  });
  assert.equal(state.compare, null);
  assert.equal(serializeGeographyNavigationState(state).has("compare"), false);
});

test("module stays a pure parser/serializer and history adapter", () => {
  assert.match(MODULE_SOURCE, /writeGeographyNavigationHistory/);
  assert.match(MODULE_SOURCE, /bindGeographyNavigationPopState/);
  assert.match(MODULE_SOURCE, /geographyNavigationStateFromLegacyMapHash/);
  assert.doesNotMatch(MODULE_SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(MODULE_SOURCE, /localStorage|sessionStorage/);
});
