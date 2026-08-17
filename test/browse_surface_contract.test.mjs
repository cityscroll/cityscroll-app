import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSE_SURFACE_CONTRACTS,
  BROWSE_SURFACES,
  EXAMS_SURFACE,
  PEOPLE_ORGANIZATIONS_SURFACE,
  STAFFING_SURFACE,
  browseSurfaceContract,
  browseSurfaceContractForRoute,
} from "../site/browse_surface_contracts.mjs";
import { BROWSE_CONCEPTS } from "../site/browse_concept_view.mjs";
import { EXAMS_BROWSE_VIEW } from "../site/exams_surface.mjs";
import { PEOPLE_LIST_BROWSE_VIEW } from "../site/people_organizations_surface.mjs";
import { STAFFING_BROWSE_VIEW } from "../site/staffing_surface.mjs";
import { BROWSE_FACETS, BROWSE_OBJECTS } from "../site/browse_view.mjs";

test("People, Staffing, and Exams have one unique surface owner each", () => {
  assert.deepEqual(Object.keys(BROWSE_SURFACE_CONTRACTS), [
    "people-organizations",
    "staffing",
    "exams",
  ]);
  assert.equal(BROWSE_SURFACES.length, 3);

  for (const field of ["surfaceId", "canonicalRoute", "builder", "controller"]) {
    const values = BROWSE_SURFACES.map((surface) => surface[field]);
    assert.ok(values.every(Boolean), `${field} is declared for every surface`);
    assert.equal(new Set(values).size, BROWSE_SURFACES.length, `${field} is one-to-one`);
  }

  for (const surface of BROWSE_SURFACES) {
    assert.equal(Object.hasOwn(surface, "compatibility"), false);
    assert.equal(Object.hasOwn(surface, "targetFacet"), false);
    assert.equal(Object.hasOwn(surface, "targetTab"), false);
    assert.ok(surface.sourceDomain);
    assert.ok(surface.navigationFamily);
  }

  assert.equal(PEOPLE_ORGANIZATIONS_SURFACE.sourceDomain, "people");
  assert.equal(STAFFING_SURFACE.sourceDomain, "staffing");
  assert.equal(EXAMS_SURFACE.sourceDomain, "staffing");
  assert.equal(EXAMS_SURFACE.surfaceId, "exams");
  assert.notEqual(EXAMS_SURFACE.sourceDomain, EXAMS_SURFACE.surfaceId);

  assert.equal(browseSurfaceContract("people-organizations"), PEOPLE_ORGANIZATIONS_SURFACE);
  assert.equal(browseSurfaceContract("staffing"), STAFFING_SURFACE);
  assert.equal(browseSurfaceContract("exams"), EXAMS_SURFACE);
  assert.equal(browseSurfaceContract("unknown"), null);
  assert.equal(browseSurfaceContractForRoute("/browse/exams"), EXAMS_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/staffing/"), STAFFING_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/people///"), PEOPLE_ORGANIZATIONS_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/contracts/"), null);
});

test("each surface uses only its declared builder and controller", () => {
  assert.equal(BROWSE_CONCEPTS.people.route, PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute);
  assert.equal(BROWSE_FACETS.staffing.route, STAFFING_SURFACE.canonicalRoute);
  assert.equal(PEOPLE_LIST_BROWSE_VIEW.route, PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute);
  assert.equal(STAFFING_BROWSE_VIEW.route, STAFFING_SURFACE.canonicalRoute);
  assert.equal(EXAMS_BROWSE_VIEW.route, EXAMS_SURFACE.canonicalRoute);
  assert.equal(STAFFING_BROWSE_VIEW.tab, STAFFING_SURFACE.navigationFamily);
  assert.equal(EXAMS_BROWSE_VIEW.tab, "exams");
  assert.equal(BROWSE_OBJECTS.exams.route, EXAMS_SURFACE.canonicalRoute);
});
