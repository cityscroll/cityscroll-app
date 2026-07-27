import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(ROOT, "index.html"), "utf8");
const {
  buildSearchDeepLink,
  canonicalSearchURL,
  parsePresetStore,
  presetLens,
  savePreset,
} = require("../nl_deeplink.js");

test("fixtures pin canonical links for Land, Staffing, and a City Record section", () => {
  assert.equal(
    buildSearchDeepLink("land", { boro: "Queens", keywords: [], status: "active" }),
    "#land?boro=Queens",
  );
  assert.equal(
    buildSearchDeepLink("people", { lookupType: "person", keywords: ["Rodriguez"] }),
    "#people?mode=person&q=rodriguez",
  );
  assert.equal(
    buildSearchDeepLink("rules", {
      agency: "Department of Buildings",
      keywords: ["sidewalk"],
    }),
    "#rules?agency=Department+of+Buildings&q=sidewalk",
  );
});

test("a Land Ask resolution gets the same deterministic hash as equivalent controls", () => {
  const resolved = { boro: "Queens", keywords: ["rezonings"], status: null };
  assert.equal(
    buildSearchDeepLink("land", { ...resolved, keywords: [] }),
    "#land?boro=Queens",
  );
  assert.match(indexSource, /const deepLink=buildSearchDeepLink\(lens, linkFilter\)/);
});

test("one preset store accepts every search lens and identifies its lens for labeling", () => {
  let store = savePreset([], "Rezonings in Queens", "#land?boro=Queens");
  store = savePreset(store, "Rodriguez", "#people?mode=person&q=rodriguez");
  store = savePreset(store, "Sidewalk rules", "#rules?q=sidewalk");
  assert.deepEqual(store.map(presetLens), ["land", "people", "rules"]);
  assert.deepEqual(parsePresetStore(JSON.stringify(store)), store);
  assert.equal(
    canonicalSearchURL(
      { origin: "https://crol-list.org", pathname: "/" },
      store[0].hash,
    ),
    "https://crol-list.org/#land?boro=Queens",
  );
});

test("the shared component pair is mounted and rendered on every non-Alerts search lens", () => {
  assert.match(indexSource, /function renderSearchComponents\(lens/);
  assert.match(indexSource, /function interpretedSearchRowHTML\(lens/);
  assert.match(indexSource, /function searchActionsHTML\(lens, hash\)/);
  assert.match(indexSource, /data-search-state/);
  assert.match(indexSource, /data-search-actions/);
  assert.match(indexSource, /data-search-presets/);
  assert.match(indexSource, /renderSearchComponents\("people"\)/);
  assert.match(indexSource, /renderSearchComponents\("land"\)/);
  assert.match(indexSource, /renderSearchComponents\(key\)/);
});

test("preset replay uses the hash router, so a saved lens opens from any other lens", () => {
  assert.match(
    indexSource,
    /if\(location\.hash===preset\.hash\) applyHash\(\); else location\.hash=preset\.hash;/,
  );
  assert.match(indexSource, /presetLens\(preset\)/);
});
