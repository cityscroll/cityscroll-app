import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aliasHash,
  aliasSearchParams,
  BROWSE_ROUTE_ALIASES,
  browseRouteAlias,
} from "../site/browse_route_aliases.mjs";
import { forwardLegacyFragment } from "../site/legacy_hash_forward.mjs";

const alias = BROWSE_ROUTE_ALIASES.exams;

test("Exams alias keeps its public path while targeting the Staffing guide", () => {
  assert.equal(browseRouteAlias("/browse/exams/"), alias);
  assert.equal(browseRouteAlias("/browse/exams"), alias);
  assert.equal(browseRouteAlias("/browse/staffing/"), null);
  assert.equal(aliasHash(alias), "people?view=guide");
});

test("Exams alias defaults to guide without discarding shareable filter state", () => {
  const params = aliasSearchParams(alias, "lang=es&interest=technology-science&window=open&q=planner");
  assert.equal(params.get("view"), "guide");
  assert.equal(aliasHash(alias, params), "people?interest=technology-science&window=open&q=planner&view=guide");
  assert.equal(aliasHash(alias, "view=notices&interest=technology-science"), "people?view=guide&interest=technology-science");
});

test("Exams alias keeps selected-exam deep links on its public route", () => {
  let replaced = false;
  const aliasLocation = {
    pathname: "/browse/exams/",
    search: "",
    hash: "#exam/7016",
    href: "https://cityscroll.org/browse/exams/#exam/7016",
    replace: () => { replaced = true; },
  };
  assert.equal(forwardLegacyFragment(aliasLocation), false);
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
