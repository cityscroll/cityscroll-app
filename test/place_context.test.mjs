import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPlaceContextToHash,
  appendPlaceContextToHref,
  clearPlaceContext,
  mergePlaceContextIntoLensFilter,
  placeContextFromScope,
  placeContextLabel,
  scopeWithPlaceContext,
} from "../site/place_context.mjs";
import {
  routeHashFromScope,
  scopeFromRouteHash,
} from "../site/scope_v0.mjs";
import { renderCivicDocumentMast } from "../site/civic_document_chrome.mjs";

test("Near You's resolved M03 place carries into the Meetings route", () => {
  const nearYouScope = scopeFromRouteHash(
    "#map?level=community_district&id=M03&parent=Manhattan&lens=meetings",
  );
  const context = placeContextFromScope(nearYouScope, { source: "near_you" });

  assert.deepEqual(context, {
    borough: "Manhattan",
    communityDistrict: "M03",
    councilDistrict: null,
    neighborhood: null,
    locationScope: null,
    source: "near_you",
  });
  assert.equal(placeContextLabel(context), "Manhattan CB3");

  const meetingsHref = appendPlaceContextToHref("/browse/meetings/", context);
  const carried = scopeFromRouteHash(`#meetings?${new URL(meetingsHref, "https://cityscroll.invalid").searchParams}`);
  assert.deepEqual(carried.place.boroughs, ["Manhattan"]);
  assert.deepEqual(carried.place.community_districts, ["M03"]);
  assert.equal(appendPlaceContextToHash("#meetings?q=parks", context), "#meetings?q=parks&boro=Manhattan&cd=M03");

  const mast = renderCivicDocumentMast({ current: "near-you", scope: nearYouScope });
  assert.match(mast, /href="\/browse\/\?boro=Manhattan&amp;cd=M03"/);
});

test("a borough override replaces the carried district and removes stale URL state", () => {
  const carried = scopeFromRouteHash("#meetings?boro=Manhattan&cd=M03&q=parks");
  const brooklyn = scopeWithPlaceContext(carried, { borough: "Brooklyn", source: "user" });

  assert.deepEqual(brooklyn.place.boroughs, ["Brooklyn"]);
  assert.deepEqual(brooklyn.place.community_districts, []);
  assert.equal(routeHashFromScope(brooklyn, { surface: "meetings" }), "#meetings?q=parks&boro=Brooklyn");
  assert.deepEqual(clearPlaceContext(brooklyn).place, {
    boroughs: [],
    community_districts: [],
    council_districts: [],
    neighborhood: null,
    location_scope: null,
    viewport: null,
  });
});

test("a bare community-board query has no place context to carry", () => {
  const scope = scopeFromRouteHash("#meetings?q=community%20board%203");
  assert.equal(placeContextFromScope(scope), null);
  assert.deepEqual(mergePlaceContextIntoLensFilter(
    { keywords: ["community board 3"] },
    null,
  ), { keywords: ["community board 3"] });
});

test("Ask filters inherit the established place only when the query names no place", () => {
  const context = { borough: "Manhattan", communityDistrict: "M03", source: "near_you" };
  assert.deepEqual(mergePlaceContextIntoLensFilter({ keywords: ["parks"] }, context), {
    keywords: ["parks"],
    borough: "Manhattan",
    communityDistrict: "M03",
  });
  assert.deepEqual(mergePlaceContextIntoLensFilter({ borough: "Brooklyn" }, context), {
    borough: "Brooklyn",
  });
});
