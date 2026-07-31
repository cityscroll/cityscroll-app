// Package-boundary characterization for entity_resolution (er-08).
//
// Proves modular-monolith imports resolve (normalizers + stubs + evaluation
// re-exports) and that the worker normalize shim stays behavior-identical.
// No public HTTP ER routes are introduced by this card.
//
//   node --test test/entity_resolution_package.test.mjs   (from crol-list/worker/)
//   node --test worker/test/entity_resolution_package.test.mjs  (from repo root)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  vendorStem,
  sameVendorStem,
  normalizeEntity,
  sameAgency,
  VENDOR_STEM_METHOD,
} from "../../entity_resolution/normalizers/index.mjs";
import {
  vendorStem as packageRootVendorStem,
  generateCandidates,
  extractFeatures,
  scorePair,
  routeDecision,
  toReviewItem,
  CANDIDATE_GENERATION_VERSION,
  FEATURES_VERSION,
  MATCHERS_VERSION,
  POLICIES_VERSION,
  REVIEW_VERSION,
  GOLD_V0_PATH,
  loadGold,
} from "../../entity_resolution/index.mjs";
import {
  vendorStem as workerVendorStem,
  normalizeEntity as workerNormalizeEntity,
} from "../src/lib/normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE = join(ROOT, "entity_resolution");

const REQUIRED_DIRS = [
  "normalizers",
  "candidate_generation",
  "features",
  "matchers",
  "policies",
  "evaluation",
  "review",
];

test("package directories and README exist", () => {
  for (const name of REQUIRED_DIRS) {
    const p = join(PACKAGE, name);
    assert.ok(existsSync(p) && statSync(p).isDirectory(), `missing dir entity_resolution/${name}`);
    assert.ok(
      existsSync(join(p, "index.mjs")),
      `missing entity_resolution/${name}/index.mjs`,
    );
  }
  assert.ok(existsSync(join(PACKAGE, "README.md")), "missing entity_resolution/README.md");
  assert.ok(existsSync(join(PACKAGE, "index.mjs")), "missing entity_resolution/index.mjs");
  // er-04 harness path stays stable
  assert.ok(existsSync(join(PACKAGE, "eval", "gold_v0.jsonl")));
  assert.ok(existsSync(join(PACKAGE, "eval", "run_metrics.mjs")));
});

test("normalizers import resolves and stems vendors", () => {
  assert.equal(vendorStem("Sinergia Inc"), "SINERGIA");
  assert.equal(vendorStem("Sinergia Incorporated"), "SINERGIA");
  assert.ok(sameVendorStem("Acme Construction, LLC.", "Acme Construction LLC"));
  assert.equal(VENDOR_STEM_METHOD, "vendor_stem_v1");

  const v = normalizeEntity("Sinergia Inc", "vendor");
  assert.equal(v.family, "vendor");
  assert.equal(v.key, "SINERGIA");
});

test("package root re-exports match normalizers and worker shim", () => {
  assert.equal(packageRootVendorStem("Turner Construction Company"), "TURNER CONSTRUCTION");
  assert.equal(workerVendorStem("Turner Construction Company"), "TURNER CONSTRUCTION");
  assert.equal(
    workerVendorStem("O'Brien & Sons Co"),
    vendorStem("O'Brien & Sons Co"),
  );
  const a = workerNormalizeEntity("POLICE DEPARTMENT", "agency");
  const b = normalizeEntity("POLICE DEPARTMENT", "agency");
  assert.equal(a.key, b.key);
  assert.ok(a.key.length > 0);
  assert.ok(sameAgency("POLICE DEPARTMENT", "Police Department"));
});

test("stub subpackages import and stay non-linking", () => {
  assert.equal(CANDIDATE_GENERATION_VERSION, "stub");
  assert.equal(FEATURES_VERSION, "stub");
  assert.equal(MATCHERS_VERSION, "stub");
  assert.equal(POLICIES_VERSION, "stub");
  assert.equal(REVIEW_VERSION, "stub");

  assert.deepEqual(generateCandidates([{ name: "Acme" }]), []);
  assert.deepEqual(extractFeatures({ a: 1 }, { b: 2 }), {});

  const scored = scorePair({ name: "A" }, { name: "B" }, {});
  assert.equal(scored.decision, "unresolved");
  assert.equal(scored.confidence, null);

  const routed = routeDecision(scored);
  assert.equal(routed.auto_link, false);
  assert.equal(toReviewItem({ id: 1 }, scored), null);
});

test("evaluation re-exports load gold helpers", () => {
  assert.equal(GOLD_V0_PATH, "entity_resolution/eval/gold_v0.jsonl");
  const goldPath = join(ROOT, GOLD_V0_PATH);
  const text = readFileSync(goldPath, "utf8");
  const { meta, cases, contentHash } = loadGold(text);
  assert.ok(meta && meta.gold_version);
  assert.ok(Array.isArray(cases) && cases.length > 0);
  assert.equal(typeof contentHash, "string");
  assert.ok(contentHash.length >= 8);
});

test("no new public HTTP entity-resolution routes in worker route modules", () => {
  // Boundary card must not add ER as a network service. Scan route-table entry
  // points for new ER path strings introduced as HTTP handlers.
  const routeFiles = [
    "worker/src/index.mjs",
    "worker/src/worker.mjs",
    "worker/src/admin.mjs",
  ].map((rel) => join(ROOT, rel)).filter((p) => existsSync(p));

  assert.ok(routeFiles.length >= 1, "expected at least one worker entry module");

  const banned = [
    /["'`]\/entity[-_]?resolution/i,
    /["'`]\/er\//i,
    /["'`]\/api\/entity[-_]?resolution/i,
    /entityResolutionHandler/i,
    /handleEntityResolution/i,
  ];

  for (const file of routeFiles) {
    const src = readFileSync(file, "utf8");
    for (const re of banned) {
      assert.equal(
        re.test(src),
        false,
        `${file} must not register public ER HTTP routes (matched ${re})`,
      );
    }
  }
});

test("README documents extract criteria and non-goals", () => {
  const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
  assert.match(readme, /Extract criteria/i);
  assert.match(readme, /Non-goals/i);
  assert.match(readme, /Multi-app consumers/i);
  assert.match(readme, /No public HTTP/i);
  assert.match(readme, /modular/i);
});
