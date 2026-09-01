/**
 * Composes the route-lazy, lot-keyed source digests rendered on a Land project detail so the Land
 * application module keeps one import, one load, and one render call as digests are added.
 */
import { attachEDesignationDigests, eDesignationDigestHTML, loadEDesignations } from "./e_designation_digest_view.mjs";
import { attachLaterHousingActivity, laterHousingActivityHTML, loadLaterHousingActivity } from "./later_housing_activity_view.mjs";

export function loadLandLotSourceDigests() {
  return Promise.all([loadEDesignations(), loadLaterHousingActivity()]);
}

export function attachLandLotSourceDigests(target, digests = []) {
  attachEDesignationDigests(target, digests[0]);
  return attachLaterHousingActivity(target, digests[1]);
}

export function landLotSourceDigestsHTML(row, options) {
  return eDesignationDigestHTML(row?.e_designation_digest, options)
    + laterHousingActivityHTML(row?.later_housing_activity, options);
}
