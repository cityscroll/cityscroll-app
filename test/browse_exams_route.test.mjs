import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXAMS_SURFACE,
  STAFFING_SURFACE,
  browseSurfaceContractForRoute,
} from "../site/browse_surface_contracts.mjs";
import { forwardLegacyFragment } from "../site/legacy_hash_forward.mjs";

test("Exams resolves directly to its canonical surface", () => {
  assert.equal(browseSurfaceContractForRoute("/browse/exams/"), EXAMS_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/exams"), EXAMS_SURFACE);
  assert.equal(browseSurfaceContractForRoute("/browse/staffing/"), STAFFING_SURFACE);
  assert.equal(EXAMS_SURFACE.navigationFamily, "exams");
});

test("the Exams document retains selected-card fragments on its public route", () => {
  let replaced = false;
  const examsLocation = {
    pathname: "/browse/exams/",
    search: "",
    hash: "#exam/7016",
    href: "https://cityscroll.org/browse/exams/#exam/7016",
    replace: () => { replaced = true; },
  };
  assert.equal(forwardLegacyFragment(examsLocation), false);
  assert.equal(replaced, false);

  let legacyTarget = "";
  const legacyLocation = {
    pathname: "/",
    search: "",
    hash: "#exam/7016",
    href: "https://cityscroll.org/#exam/7016",
    replace: (value) => { legacyTarget = value; },
  };
  assert.equal(forwardLegacyFragment(legacyLocation), true);
  assert.equal(legacyTarget, "/exams/7016/");
});
