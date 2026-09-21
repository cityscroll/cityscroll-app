import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { CARTO_BASEMAP_API_KEY, cartoBasemapTileUrl } from "../site/carto_basemap.mjs";
import { injectCartoBasemapKey } from "../tools/inject_carto_basemap_key.mjs";

const fixtureKey = "cb1_test_fixture_not_a_real_key";
function output(t) {
  const dir = mkdtempSync(join(tmpdir(), "carto-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "site"));
  for (const path of ["carto_basemap.mjs", "site/carto_basemap.mjs"]) copyFileSync(new URL("../site/carto_basemap.mjs", import.meta.url), join(dir, path));
  return dir;
}
test("tile URLs preserve renderer placeholders and use the keyed raster endpoint", () => {
  assert.equal(cartoBasemapTileUrl({ subdomain: "{s}", retina: true, apiKey: fixtureKey }), `https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=${fixtureKey}`);
  assert.equal(new URL(cartoBasemapTileUrl()).search, "");
});
test("release injection configures executable modules in both public layouts", async (t) => {
  const dir = output(t);
  assert.deepEqual(injectCartoBasemapKey({ siteDir: dir, apiKey: fixtureKey, required: true }), { configured: true, modules: 2 });
  for (const path of ["carto_basemap.mjs", "site/carto_basemap.mjs"]) {
    const module = await import(pathToFileURL(join(dir, path)));
    assert.equal(new URL(module.cartoBasemapTileUrl()).searchParams.get("key"), fixtureKey);
  }
});
test("required injection rejects missing, placeholder, malformed keys without modifying output", (t) => {
  const dir = output(t);
  const before = readFileSync(join(dir, "carto_basemap.mjs"), "utf8");
  for (const apiKey of ["", CARTO_BASEMAP_API_KEY, "__CITYSCROLL_other_placeholder", "cb1_short", `${fixtureKey}\n`, "not-a-carto-key"]) {
    assert.throws(() => injectCartoBasemapKey({ siteDir: dir, apiKey, required: true }));
    assert.equal(readFileSync(join(dir, "carto_basemap.mjs"), "utf8"), before);
  }
});
test("CLI reads environment, fails closed and never logs the value", (t) => {
  const dir = output(t);
  const args = ["tools/inject_carto_basemap_key.mjs", "--site-dir", dir, "--require"];
  const missing = spawnSync(process.execPath, args, { env: { ...process.env, CARTO_BASEMAP_API_KEY: "" }, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  const valid = spawnSync(process.execPath, args, { env: { ...process.env, CARTO_BASEMAP_API_KEY: fixtureKey }, encoding: "utf8" });
  assert.equal(valid.status, 0);
  assert.ok(!(valid.stdout + valid.stderr).includes(fixtureKey));
});
