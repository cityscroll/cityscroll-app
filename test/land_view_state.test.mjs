// Land presentation state (view=list|map) is a sibling of the Land filter keys, not one of
// them. These tests pin the whole boundary: the parser and serializer, the semantic keys that
// must survive a renderer switch untouched, the canonical watch compiler that must never see
// `view`, the List fallback when a Map cannot paint, and the site-owner question that must
// stay open until it is reviewed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LAND_DEFAULT_VIEW,
  LAND_PRESENTATION_STATE_KEYS,
  LAND_VIEWS,
  LAND_VIEW_DEFAULT_QUESTION,
  LAND_VIEW_FALLBACK_REASONS,
  LAND_VIEW_LIST,
  LAND_VIEW_MAP,
  LAND_VIEW_PARAM,
  isKnownLandView,
  landViewFromRouteHash,
  landViewFromSearchParams,
  normalizeLandView,
  omitLandPresentationState,
  resolveLandPresentation,
  routeHashWithLandView,
  stripLandPresentationState,
} from "../site/land_view_state.mjs";
import { landViewFallbackNote, landViewHref, landViewSwitchHTML } from "../site/land_view_switch.mjs";
import {
  routeHashFromScope,
  scopeFromRouteHash,
  scopeFromWatch,
  watchFromScope,
} from "../site/scope_v0.mjs";
import { LEGACY_ROUTE_PARAMETERS, migrateLegacyUrl } from "../site/route_migration.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const SPECIMEN = "#land?boro=Queens&stage=public_review&view=map";
const SEMANTIC = "#land?boro=Queens&stage=public_review";

// Every Land filter key the current app already carries through the route.
const FULL_SCOPE = "#land?boro=Queens&cd=Q04&council=25&q=rezoning&status=all"
  + "&stage=public_review&future=hearing&procedure=ulurp&family=acquisition&attendance=in_person";

function semanticParams(hash) {
  const params = new URLSearchParams(String(hash).split("?", 2)[1] || "");
  for (const key of LAND_PRESENTATION_STATE_KEYS) params.delete(key);
  return [...params.entries()].sort();
}

/* ===== A1: valid map and list links switch presentation and keep every filter ===== */

test("A1 the two valid views are the only values that change Land presentation", () => {
  assert.deepEqual([...LAND_VIEWS], ["list", "map"]);
  assert.equal(LAND_DEFAULT_VIEW, LAND_VIEW_LIST);
  assert.equal(landViewFromRouteHash(SPECIMEN), LAND_VIEW_MAP);
  assert.equal(landViewFromRouteHash(`${SEMANTIC}&view=list`), LAND_VIEW_LIST);
  assert.equal(landViewFromRouteHash(SEMANTIC), LAND_VIEW_LIST);
});

test("A1 a renderer switch preserves every existing Land filter key and value", () => {
  const list = routeHashWithLandView(FULL_SCOPE, LAND_VIEW_LIST);
  const map = routeHashWithLandView(FULL_SCOPE, LAND_VIEW_MAP);
  const expected = semanticParams(FULL_SCOPE);
  assert.deepEqual(semanticParams(list), expected);
  assert.deepEqual(semanticParams(map), expected);
  assert.equal(landViewFromRouteHash(map), LAND_VIEW_MAP);
  // Switching back is lossless in both directions.
  assert.equal(routeHashWithLandView(map, LAND_VIEW_LIST), FULL_SCOPE);
  assert.equal(routeHashWithLandView(list, LAND_VIEW_MAP), map);
});

test("A1 a List route stays byte-identical to the legacy route that carries no view", () => {
  assert.equal(routeHashWithLandView(SEMANTIC, LAND_VIEW_LIST), SEMANTIC);
  assert.equal(routeHashWithLandView(SEMANTIC, "globe"), SEMANTIC);
  assert.equal(routeHashWithLandView("#land", LAND_VIEW_LIST), "#land");
  assert.equal(routeHashWithLandView("#land", LAND_VIEW_MAP), "#land?view=map");
  // An explicit view=list normalizes onto the same legacy address.
  assert.equal(routeHashWithLandView(`${SEMANTIC}&view=list`, LAND_VIEW_LIST), SEMANTIC);
});

test("A1 the control offers both destinations and marks only the view that painted", () => {
  const html = landViewSwitchHTML({ view: LAND_VIEW_LIST, currentHash: SEMANTIC });
  assert.match(html, /data-land-view="list"[^>]*/);
  assert.match(html, /data-land-view="map"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /aria-pressed="true"[^>]*data-land-view="list"/);
  assert.equal(landViewHref(LAND_VIEW_MAP, SEMANTIC), `${SEMANTIC}&view=map`);
  assert.equal(landViewHref(LAND_VIEW_LIST, SPECIMEN), SEMANTIC);
  // A Map request that fell back to List must not claim a map is on screen.
  const fellBack = landViewSwitchHTML({ view: LAND_VIEW_LIST, currentHash: SPECIMEN });
  assert.match(fellBack, /aria-pressed="true"[^>]*data-land-view="list"/);
});

/* ===== A2: view is presentation state, never watch scope or filter semantics ===== */

test("A2 a Land route's view never becomes a semantic facet value", () => {
  const scope = scopeFromRouteHash(SPECIMEN);
  assert.equal(LAND_VIEW_PARAM in scope.facets.values, false);
  assert.equal(scope.facets.values.stage, "public_review");
  assert.deepEqual(scope.place.boroughs, ["Queens"]);
  // Canonical Land serialization emits no presentation key and no leftover facet blob.
  assert.equal(routeHashFromScope(scope, { surface: "land" }), SEMANTIC);
});

test("A2 canonical Land watch scope is identical for map, list, absent, and unknown views", () => {
  const watches = [SPECIMEN, `${SEMANTIC}&view=list`, SEMANTIC, `${SEMANTIC}&view=globe`]
    .map((hash) => watchFromScope(scopeFromRouteHash(hash), { lens: "land" }));
  for (const watch of watches) {
    assert.equal(LAND_VIEW_PARAM in watch.filter, false);
    assert.deepEqual(watch, watches[0]);
  }
  assert.equal(watches[0].filter.stage, "public_review");
  assert.equal(watches[0].filter.boro, "Queens");
});

test("A2 a watch that already carries presentation state cannot smuggle it back in", () => {
  const hostile = scopeFromWatch({ lens: "land", filter: { boro: "Queens", stage: "public_review", view: "map" } });
  assert.equal(LAND_VIEW_PARAM in hostile.facets.values, false);
  assert.equal(routeHashFromScope(hostile, { surface: "land" }), SEMANTIC);
  assert.equal(LAND_VIEW_PARAM in watchFromScope(hostile, { lens: "land" }).filter, false);
});

test("A2 the typed-facet escape hatch cannot carry presentation state on Land", () => {
  // Before this contract existed, a Land route with `view` degenerated into exactly this
  // shape: renderer state serialized as a semantic facet blob, one adapter from watch identity.
  const blob = encodeURIComponent(JSON.stringify({ view: "map", entity_refs_all: ["project:ABC123"] }));
  const scope = scopeFromRouteHash(`${SEMANTIC}&facet=${blob}`);
  assert.equal(LAND_VIEW_PARAM in scope.facets.values, false);
  // The real typed constraint beside it is untouched.
  assert.deepEqual(scope.facets.values.entity_refs_all, ["project:ABC123"]);
  assert.equal(LAND_VIEW_PARAM in watchFromScope(scope, { lens: "land" }).filter, false);
  assert.doesNotMatch(routeHashFromScope(scope, { surface: "land" }), /[?&]view=|%22view%22/);
});

test("A2 other surfaces keep their own unrelated view facet", () => {
  for (const hash of ["#people?view=guide", "#property?view=tax-lien"]) {
    const surface = hash.slice(1).split("?", 1)[0];
    assert.equal(routeHashFromScope(scopeFromRouteHash(hash), { surface }), hash, hash);
  }
});

test("A2 omitLandPresentationState leaves semantic keys untouched", () => {
  assert.deepEqual(
    omitLandPresentationState({ stage: "public_review", view: "map", family: "rezoning" }),
    { stage: "public_review", family: "rezoning" },
  );
  assert.deepEqual(omitLandPresentationState(null), {});
  assert.equal(stripLandPresentationState(SPECIMEN), SEMANTIC);
  assert.equal(stripLandPresentationState(SEMANTIC), SEMANTIC);
});

/* ===== A3: round trips normalize unknown values while preserving semantic fields ===== */

test("A3 valid, absent, unknown, repeated, and reordered views all round-trip", () => {
  const cases = [
    { hash: SPECIMEN, view: LAND_VIEW_MAP },
    { hash: `${SEMANTIC}&view=list`, view: LAND_VIEW_LIST },
    { hash: SEMANTIC, view: LAND_VIEW_LIST },
    { hash: `${SEMANTIC}&view=globe`, view: LAND_VIEW_LIST },
    { hash: `${SEMANTIC}&view=`, view: LAND_VIEW_LIST },
    { hash: `${SEMANTIC}&view=%20MAP%20`, view: LAND_VIEW_MAP },
    // Repeated: the first occurrence wins, exactly like every other route key.
    { hash: `${SEMANTIC}&view=map&view=list`, view: LAND_VIEW_MAP },
    { hash: `${SEMANTIC}&view=globe&view=map`, view: LAND_VIEW_LIST },
    // Reordered: presentation state is position-independent.
    { hash: "#land?view=map&stage=public_review&boro=Queens", view: LAND_VIEW_MAP },
  ];
  for (const { hash, view } of cases) {
    assert.equal(landViewFromRouteHash(hash), view, hash);
    // The semantic scope is identical in every case.
    const scope = scopeFromRouteHash(hash);
    assert.equal(routeHashFromScope(scope, { surface: "land" }), SEMANTIC, hash);
    // Re-serializing the parsed view is idempotent.
    const serialized = routeHashWithLandView(routeHashFromScope(scope, { surface: "land" }), view);
    assert.equal(landViewFromRouteHash(serialized), view, hash);
    assert.equal(routeHashWithLandView(serialized, view), serialized, hash);
  }
});

test("A3 normalization accepts only the two known values", () => {
  for (const value of ["list", "LIST", " map ", "Map"]) assert.equal(isKnownLandView(value), true, value);
  for (const value of ["globe", "", null, undefined, "grid", 7, {}]) {
    assert.equal(isKnownLandView(value), false, String(value));
    assert.equal(normalizeLandView(value), LAND_DEFAULT_VIEW, String(value));
  }
  assert.equal(landViewFromSearchParams(new URLSearchParams("view=map")), LAND_VIEW_MAP);
  assert.equal(landViewFromSearchParams({ view: "globe" }), LAND_VIEW_LIST);
  assert.equal(landViewFromSearchParams("?boro=Queens&view=map"), LAND_VIEW_MAP);
});

/* ===== A4: history, load failure, legacy links, and the open default question ===== */

test("A4 a Map load failure returns to List without dropping the semantic scope", () => {
  const requested = { requested: LAND_VIEW_MAP };
  assert.deepEqual(resolveLandPresentation({ ...requested, rendererReady: true }), {
    view: LAND_VIEW_MAP, requested: LAND_VIEW_MAP, fallback: false, reason: null,
  });
  assert.deepEqual(resolveLandPresentation({ ...requested, rendererReady: false }), {
    view: LAND_VIEW_LIST,
    requested: LAND_VIEW_MAP,
    fallback: true,
    reason: LAND_VIEW_FALLBACK_REASONS.RENDERER_ABSENT,
  });
  assert.deepEqual(resolveLandPresentation({ ...requested, rendererReady: true, failure: new Error("tiles") }), {
    view: LAND_VIEW_LIST,
    requested: LAND_VIEW_MAP,
    fallback: true,
    reason: LAND_VIEW_FALLBACK_REASONS.RENDERER_FAILED,
  });
  // The route the resident keeps is still the map route with all filters intact.
  assert.equal(semanticParams(SPECIMEN).length, semanticParams(SEMANTIC).length);
  assert.notEqual(landViewFallbackNote({ fallback: true, reason: LAND_VIEW_FALLBACK_REASONS.RENDERER_FAILED }), "");
  assert.notEqual(landViewFallbackNote({ fallback: true, reason: LAND_VIEW_FALLBACK_REASONS.RENDERER_ABSENT }), "");
  assert.equal(landViewFallbackNote({ fallback: false }), "");
});

test("A4 an unknown view is reported as a fallback rather than silently swallowed", () => {
  assert.deepEqual(resolveLandPresentation({ requested: "globe" }), {
    view: LAND_VIEW_LIST,
    requested: LAND_VIEW_LIST,
    fallback: true,
    reason: LAND_VIEW_FALLBACK_REASONS.UNKNOWN_VIEW,
  });
  assert.deepEqual(resolveLandPresentation({}), {
    view: LAND_VIEW_LIST, requested: LAND_VIEW_LIST, fallback: false, reason: null,
  });
});

test("A4 legacy Land links without a view keep their exact current behavior", () => {
  const legacy = "#land?status=public%3AIn+Public+Review";
  assert.equal(landViewFromRouteHash(legacy), LAND_VIEW_LIST);
  assert.equal(routeHashWithLandView(legacy, LAND_VIEW_LIST), legacy);
  assert.equal(routeHashFromScope(scopeFromRouteHash(legacy), { surface: "land" }), legacy);
});

test("A4 the Land document route forwards presentation state instead of rejecting it", () => {
  assert.equal(LEGACY_ROUTE_PARAMETERS.land.has(LAND_VIEW_PARAM), true);
  const migrated = migrateLegacyUrl(`/${SPECIMEN}`);
  assert.equal(migrated.migrated, true);
  const url = new URL(migrated.target, "https://cityscroll.org");
  assert.equal(url.searchParams.get("view"), "map");
  assert.equal(url.searchParams.get("boro"), "Queens");
  assert.equal(url.searchParams.get("stage"), "public_review");
  assert.equal(url.searchParams.has("legacy"), false);
});

test("A4 the route wires presentation state through history without rebuilding results", () => {
  // serializeState re-applies the presentation key after the scope round trip.
  assert.match(SITE_SOURCE, /routeHashWithLandView\(canonicalHash,landView\)/);
  // applyHash canonicalization keeps the requested view instead of stripping it.
  assert.match(SITE_SOURCE, /routeHashWithLandView\(rebuilt,landViewFromRouteHash\("#"\+raw\)\)/);
  // An incoming route seeds the presentation state.
  assert.match(SITE_SOURCE, /landView=landViewFromSearchParams\(q\)/);
  // The switch pushes a history entry (Back returns to the previous view) and repaints only
  // presentation; it never calls landSearch().
  const setLandView = SITE_SOURCE.slice(SITE_SOURCE.indexOf("function setLandView("));
  const body = setLandView.slice(0, setLandView.indexOf("\n}"));
  assert.match(body, /pushHash\(\)/);
  assert.doesNotMatch(body, /landSearch\(/);
  // Both the replaced and the pushed Land entry repaint presentation, so Back and Forward
  // land on the renderer their history entry names.
  assert.equal((SITE_SOURCE.match(/if\(h\.startsWith\("#land"\)\) applyLandPresentation\(h\);/g) || []).length, 2);
  // Back/Forward on the canonical Land document route arrives as popstate, not hashchange,
  // so the restored entry's view is re-read there too.
  const popstate = SITE_SOURCE.slice(SITE_SOURCE.indexOf('addEventListener("popstate",()=>{\n  const raw='));
  const restore = popstate.slice(0, popstate.indexOf("\n});"));
  assert.match(restore, /raw\.split\("\?",1\)\[0\]!=="land"/);
  assert.match(restore, /landView=restored/);
  assert.match(restore, /applyLandPresentation\(`#\$\{raw\}`\)/);
});

test("A4 the parity-era default question stays open and reviewable", () => {
  assert.equal(LAND_VIEW_DEFAULT_QUESTION.status, "open");
  assert.equal(LAND_VIEW_DEFAULT_QUESTION.decided_by, "site_owner");
  assert.equal(LAND_VIEW_DEFAULT_QUESTION.current_default, LAND_VIEW_LIST);
  const review = readFileSync(new URL(`../${LAND_VIEW_DEFAULT_QUESTION.review_document}`, import.meta.url), "utf8");
  assert.match(review, /\*\*Status:\*\* open/);
  assert.match(review, /LAND_DEFAULT_VIEW/);
  // No implementation may decide it by making the default conditional or time-based.
  const contract = readFileSync(new URL("../site/land_view_state.mjs", import.meta.url), "utf8");
  assert.match(contract, /export const LAND_DEFAULT_VIEW = LAND_VIEW_LIST;/);
  assert.doesNotMatch(contract, /Date\.|localStorage|fetch\(/);
});
