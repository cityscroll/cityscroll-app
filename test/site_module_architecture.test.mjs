import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SITE_MODULES } from "./helpers/site_source.mjs";

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

test("module concatenation preserves the normalized inline-script source byte for byte", () => {
  const source = SITE_MODULES.map(behaviorSource).join("\n");
  assert.equal(Buffer.byteLength(source), evidence.source_equivalence.normalized_source_bytes);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    evidence.source_equivalence.normalized_source_sha256,
  );
});

test("representative targeted-read byte measurements stay current", () => {
  assert.equal(Buffer.byteLength(index), evidence.after.index_html_bytes);
  for (const task of evidence.representative_tasks) {
    const bytes = task.files.reduce(
      (total, path, index) => total + Buffer.byteLength(readFileSync(new URL(`../${path}`, import.meta.url))) + (index ? 1 : 0),
      0,
    );
    assert.equal(bytes, task.after_bytes, task.task);
    assert.ok(task.before_tokens / task.after_tokens >= 9.5, task.task);
  }
});
