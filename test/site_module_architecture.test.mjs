import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SITE_MODULES } from "./helpers/site_source.mjs";
import { computeModuleGraphDigest } from "../tools/site_module_architecture.mjs";

const evidence = JSON.parse(
  readFileSync(new URL("../docs/evidence/index-module-split.json", import.meta.url), "utf8"),
);
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const loader = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");

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
  assert.deepEqual(
    [...loader.matchAll(/await import\("\.\/(.+?)"\);/g)].map((match) => match[1]),
    SITE_MODULES,
  );
});

test("every application module stays below the short-context working bar", () => {
  for (const name of SITE_MODULES) {
    const bytes = Buffer.byteLength(moduleSource(name));
    assert.ok(bytes < evidence.after.working_bar_bytes, `${name}: ${bytes} bytes`);
  }
});

test("module concatenation matches the committed module-graph digest", () => {
  const source = SITE_MODULES.map(behaviorSource).join("\n");
  const computed = computeModuleGraphDigest();
  assert.equal(Buffer.byteLength(source), evidence.current_module_graph.normalized_source_bytes);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    evidence.current_module_graph.normalized_source_sha256,
  );
  assert.equal(computed.normalized_source_sha256, evidence.current_module_graph.normalized_source_sha256);
  assert.equal(computed.normalized_source_bytes, evidence.current_module_graph.normalized_source_bytes);
});

// Historical split evidence (before/after token measurements on representative tasks)
// remains in docs/evidence/index-module-split.json for the modular-split write-up.
// One-time migration assertions (hard-coded after_bytes + token_reduction >= 9.5)
// were retired: they re-proved the split forever and broke on every intentional module edit.
// Refresh the live fingerprint with: node tools/site_module_architecture.mjs --update
