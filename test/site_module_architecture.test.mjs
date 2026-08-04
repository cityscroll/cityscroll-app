import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { SITE_MODULES } from "./helpers/site_source.mjs";
import { computeModuleGraphDigest } from "../tools/site_module_architecture.mjs";

const evidence = JSON.parse(
  readFileSync(new URL("../docs/evidence/index-module-split.json", import.meta.url), "utf8"),
);
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const loader = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");
const loaderModules = [...loader.matchAll(/await import\("\.\/(.+?)"\);/g)].map(
  (match) => match[1],
);
const applicationModules = readdirSync(new URL("../site/app/", import.meta.url))
  .filter((name) => name.endsWith(".mjs") && name !== "main.mjs")
  .sort();

function moduleSource(name) {
  return readFileSync(new URL(`../site/app/${name}`, import.meta.url), "utf8");
}

function behaviorSource(name) {
  return moduleSource(name).split(
    "\n// Publish live bindings for neighboring modules and legacy inline handlers.",
  )[0].replaceAll('import("../', 'import("./');
}

test("index.html delegates application behavior to the ordered ES-module loader", () => {
  assert.match(index, /<script type="module" src="app\/main\.mjs"><\/script>/);
  assert.doesNotMatch(index, /<script>\s*const SODA/);
  assert.deepEqual(loaderModules, SITE_MODULES);
});

test("every application module is registered exactly once in the import graph", () => {
  assert.equal(new Set(loaderModules).size, loaderModules.length, "duplicate loader imports");
  assert.deepEqual([...loaderModules].sort(), applicationModules);
});

test("every application module stays below the short-context working bar", () => {
  for (const name of SITE_MODULES) {
    const bytes = Buffer.byteLength(moduleSource(name));
    assert.ok(bytes < evidence.after.working_bar_bytes, `${name}: ${bytes} bytes`);
  }
});

test("module-graph digest is derived from the registered modules at check time", () => {
  const source = SITE_MODULES.map(behaviorSource).join("\n");
  const computed = computeModuleGraphDigest();
  assert.deepEqual(computed, {
    normalized_source_bytes: Buffer.byteLength(source),
    normalized_source_sha256: createHash("sha256").update(source).digest("hex"),
    module_count: SITE_MODULES.length,
  });
});

// Historical split evidence (before/after token measurements on representative tasks)
// remains in docs/evidence/index-module-split.json for the modular-split write-up.
// One-time migration assertions (hard-coded after_bytes + token_reduction >= 9.5)
// were retired: they re-proved the split forever and broke on every intentional module edit.
// Inspect the live fingerprint with: node tools/site_module_architecture.mjs --print
