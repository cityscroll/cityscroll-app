import assert from "node:assert/strict";
import test from "node:test";

import {
  officialProfileSectionHref,
  officialProfileSectionRoute,
} from "../site/official_profile_navigation.mjs";

test("official profile section links retain the canonical profile document", () => {
  assert.equal(
    officialProfileSectionHref("7811", "official-lobby"),
    "/officials/7811/#official-lobby",
  );
  assert.equal(
    officialProfileSectionHref("7801", "official-skim"),
    "/officials/7801/#official-skim",
  );
  assert.equal(officialProfileSectionHref("7811", "not-a-section"), "");
});

test("only allowlisted fragments on an official document become in-page routes", () => {
  assert.deepEqual(officialProfileSectionRoute({
    pathname: "/officials/7811/",
    hash: "#official-cfb",
  }), { officialId: "7811", sectionId: "official-cfb" });
  assert.equal(officialProfileSectionRoute({
    pathname: "/officials/7811/",
    hash: "#money",
  }), null);
  assert.equal(officialProfileSectionRoute({
    pathname: "/vendors/7811/",
    hash: "#official-cfb",
  }), null);
});
