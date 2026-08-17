import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSE_CONCEPT_DOCUMENT_PATHS_COMPAT,
  BROWSE_DOCUMENT_CONCEPT_ROUTE_ENTRIES_COMPAT,
  BROWSE_DOCUMENT_FACET_HASHES_COMPAT,
  BROWSE_LEGACY_LENS_FACETS_COMPAT,
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
import { BROWSE_FACETS, BROWSE_OBJECTS } from "../site/browse_view.mjs";

test("People, Staffing, and Exams have one unique surface owner each", () => {
  assert.deepEqual(Object.keys(BROWSE_SURFACE_CONTRACTS), [
    "people-organizations",
    "staffing",
    "exams",
  ]);
  assert.equal(BROWSE_SURFACES.length, 3);

  for (const field of ["surfaceId", "route", "builder", "controller"]) {
    const values = BROWSE_SURFACES.map((surface) => surface[field]);
    assert.ok(values.every(Boolean), `${field} is declared for every surface`);
    assert.equal(new Set(values).size, BROWSE_SURFACES.length, `${field} is one-to-one`);
  }

  for (const surface of BROWSE_SURFACES) {
    assert.equal(Object.hasOwn(surface, "targetFacet"), false);
    assert.equal(Object.hasOwn(surface, "targetTab"), false);
  }

  assert.equal(browseSurfaceContract("people-organizations"), PEOPLE_ORGANIZATIONS_SURFACE);
  assert.equal(browseSurfaceContract("staffing"), STAFFING_SURFACE);
  assert.equal(browseSurfaceContract("exams"), EXAMS_SURFACE);
  assert.equal(browseSurfaceContract("unknown"), null);
  assert.equal(browseSurfaceContractForRoute("/browse/exams"), EXAMS_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/staffing/"), STAFFING_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/people///"), PEOPLE_ORGANIZATIONS_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/contracts/"), null);
});

test("Exams uses its declared document builder and browser controller", () => {
  assert.deepEqual(EXAMS_SURFACE.compatibility, {
    routeKey: "exams",
    runtimeTab: "exams",
    currentBuilder: EXAMS_SURFACE.builder,
    currentController: EXAMS_SURFACE.controller,
  });
  assert.deepEqual(BROWSE_DOCUMENT_FACET_HASHES_COMPAT, { staffing: "people" });
  assert.deepEqual(BROWSE_DOCUMENT_CONCEPT_ROUTE_ENTRIES_COMPAT, [
    ["people", "people"],
    ["staffing", "people"],
  ]);
  assert.deepEqual(BROWSE_CONCEPT_DOCUMENT_PATHS_COMPAT, [
    "/browse/people",
    "/browse/staffing",
  ]);
  assert.deepEqual(BROWSE_LEGACY_LENS_FACETS_COMPAT, {
    people: "staffing",
    staffing: "staffing",
  });

  assert.equal(BROWSE_CONCEPTS.people.route, PEOPLE_ORGANIZATIONS_SURFACE.route);
  assert.equal(BROWSE_FACETS.staffing.route, STAFFING_SURFACE.route);
  assert.equal(PEOPLE_LIST_BROWSE_VIEW.route, PEOPLE_ORGANIZATIONS_SURFACE.route);
  assert.equal(EXAMS_BROWSE_VIEW.route, EXAMS_SURFACE.route);
  assert.equal(EXAMS_BROWSE_VIEW.tab, "exams");
  assert.equal(BROWSE_OBJECTS.exams.route, EXAMS_SURFACE.route);
});
