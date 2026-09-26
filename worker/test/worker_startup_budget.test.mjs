/**
 * Worker startup CPU budget detector.
 *
 * A large JSON imported statically into the Worker entry graph is parsed into an
 * object literal during startup, which counts against Cloudflare's startup CPU
 * budget (validation error 10021). This detector reads an esbuild metafile and
 * fails when such a JSON sits on the startup (static-import) graph. The positive
 * control proves it fails when a large JSON is imported at top level, and the
 * converse control proves a dynamic import() clears it.
 *
 * verify: node --test worker/test/worker_startup_budget.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  STARTUP_JSON_PER_FILE_LIMIT_BYTES,
  assessWorkerStartupBudget,
  startupEvaluatedInputs,
  toRepoRelative,
} from "../../tools/worker_startup_budget.mjs";

const BIG = STARTUP_JSON_PER_FILE_LIMIT_BYTES * 5; // clearly over the per-file limit

// A minimal esbuild-shaped metafile: one entry that imports a big JSON with the
// given edge kind. workerDir defaults to "worker", so a src/ path normalizes to
// worker/src/... — matching how wrangler records inputs from the worker dir.
function metafileImportingBigJson(kind) {
  return {
    inputs: {
      "src/worker.mjs": {
        bytes: 1000,
        imports: [{ path: "src/data/big_dataset.json", kind }],
      },
      "src/data/big_dataset.json": { bytes: BIG, imports: [] },
    },
    outputs: {
      "worker.js": { entryPoint: "src/worker.mjs" },
    },
  };
}

test("positive control: a large JSON imported at top level is flagged", () => {
  const metafile = metafileImportingBigJson("import-statement");
  const { findings } = assessWorkerStartupBudget(metafile);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "unlisted-large-startup-json");
  assert.equal(findings[0].path, "worker/src/data/big_dataset.json");
  assert.equal(findings[0].bytes, BIG);
});

test("converse control: the same large JSON imported dynamically is not flagged", () => {
  const metafile = metafileImportingBigJson("dynamic-import");
  const { findings, startupJsonBytes } = assessWorkerStartupBudget(metafile);
  assert.deepEqual(findings, []);
  // The dynamically-imported dataset is off the startup graph entirely.
  assert.equal(startupJsonBytes, 0);
});

test("a small JSON imported at top level is under the per-file limit", () => {
  const metafile = metafileImportingBigJson("import-statement");
  metafile.inputs["src/data/big_dataset.json"].bytes = 1024; // 1 KiB
  const { findings } = assessWorkerStartupBudget(metafile);
  assert.deepEqual(findings, []);
});

test("a grandfathered baseline dataset on the startup graph is allowed", () => {
  const metafile = {
    inputs: {
      "src/worker.mjs": {
        bytes: 1000,
        imports: [{ path: "../site/data/procurement_digest_snapshot.json", kind: "import-statement" }],
      },
      "../site/data/procurement_digest_snapshot.json": { bytes: BIG, imports: [] },
    },
    outputs: { "worker.js": { entryPoint: "src/worker.mjs" } },
  };
  const { findings, largeStartupJson } = assessWorkerStartupBudget(metafile);
  assert.deepEqual(findings, []);
  assert.equal(largeStartupJson[0].path, "site/data/procurement_digest_snapshot.json");
});

test("aggregate backstop fails when startup JSON exceeds the total budget", () => {
  const metafile = { inputs: { "src/worker.mjs": { bytes: 100, imports: [] } }, outputs: { "worker.js": { entryPoint: "src/worker.mjs" } } };
  // Import many allowlisted-shaped small JSONs is awkward; instead assert with a tiny budget.
  metafile.inputs["src/worker.mjs"].imports = [{ path: "../site/data/procurement_digest_snapshot.json", kind: "import-statement" }];
  metafile.inputs["../site/data/procurement_digest_snapshot.json"] = { bytes: BIG, imports: [] };
  const { findings } = assessWorkerStartupBudget(metafile, { aggregateLimitBytes: BIG - 1 });
  assert.ok(findings.some((f) => f.kind === "aggregate-startup-json-over-budget"));
});

test("startupEvaluatedInputs excludes modules reached only via dynamic import", () => {
  const metafile = metafileImportingBigJson("dynamic-import");
  const startup = startupEvaluatedInputs(metafile);
  assert.ok(startup.has("src/worker.mjs"));
  assert.ok(!startup.has("src/data/big_dataset.json"));
});

test("a module reached by both a static and a dynamic edge stays on the startup graph", () => {
  const metafile = {
    inputs: {
      "src/worker.mjs": {
        bytes: 1000,
        imports: [
          { path: "src/data/big_dataset.json", kind: "import-statement" },
          { path: "src/lazy.mjs", kind: "dynamic-import" },
        ],
      },
      "src/lazy.mjs": { bytes: 100, imports: [{ path: "src/data/big_dataset.json", kind: "dynamic-import" }] },
      "src/data/big_dataset.json": { bytes: BIG, imports: [] },
    },
    outputs: { "worker.js": { entryPoint: "src/worker.mjs" } },
  };
  const { findings } = assessWorkerStartupBudget(metafile);
  assert.equal(findings.length, 1, "static edge keeps it on the startup graph");
});

test("toRepoRelative resolves worker-relative metafile paths", () => {
  assert.equal(toRepoRelative("../site/data/x.json"), "site/data/x.json");
  assert.equal(toRepoRelative("src/data/x.json"), "worker/src/data/x.json");
});
