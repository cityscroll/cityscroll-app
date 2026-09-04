/**
 * Canonical place-scope fixtures (PS-06), continued: the two combined-scope fixtures the
 * commission calls for, built on the shared scope-v0 contract (site/scope_v0.mjs) rather
 * than a surface-specific shape.
 */

import { scopeFromLensState } from "../../../site/scope_v0.mjs";
import {
  FIXTURE_BOROUGH,
  FIXTURE_COMMUNITY_DISTRICT,
  FIXTURE_COUNCIL_DISTRICT,
} from "./geography.mjs";

/** FIXTURE 2: a council-district scope combining keyword, domain, agency, place role, and a time window. */
export function councilDistrictScopeFixture({ placeRole = "matter" } = {}) {
  return scopeFromLensState("meetings", {
    q: "resiliency",
    agency: "Parks",
    councilDistrict: FIXTURE_COUNCIL_DISTRICT,
    when: "month",
    place_role: placeRole,
  });
}

/** FIXTURE 3: a community-district scope with a place role, built for Following watch serialization. */
export function communityDistrictWatchScopeFixture({ placeRole = "affected_area" } = {}) {
  return scopeFromLensState("meetings", {
    boro: FIXTURE_BOROUGH,
    communityDistrict: FIXTURE_COMMUNITY_DISTRICT,
    agency: "Housing Preservation and Development",
    q: "resiliency",
    place_role: placeRole,
  });
}
