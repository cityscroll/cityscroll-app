// Package-boundary characterization for entity_resolution (er-08) and er-06 review shaping.
//
// Proves modular-monolith imports resolve (normalizers + matcher + evaluation
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
  buildInvestigationWorkspace,
  toReviewItem,
  CANDIDATE_GENERATION_VERSION,
  FEATURES_VERSION,
  MATCHERS_VERSION,
  POLICIES_VERSION,
  REVIEW_VERSION,
  INVESTIGATION_WORKSPACE_VERSION,
  GOLD_V0_PATH,
  loadGold,
  buildClericalAudit,
  serializePublicEntity,
  serializePublicEntityLink,
  PUBLICATION_VERSION,
} from "../../entity_resolution/index.mjs";
import {
  vendorStem as workerVendorStem,
  normalizeEntity as workerNormalizeEntity,
} from "../src/lib/normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE = join(ROOT, "entity_resolution");

const REQUIRED_DIRS = [
  "normalizers",
  "authority_keys",
  "officials",
  "candidate_generation",
  "features",
  "matchers",
  "policies",
  "evaluation",
  "review",
  "publication",
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

test("candidate generation and conventional matcher stay non-linking", () => {
  assert.equal(CANDIDATE_GENERATION_VERSION, "token_v0_v0");
  assert.equal(FEATURES_VERSION, "pair_features_v1");
  assert.equal(MATCHERS_VERSION, "conventional_v1");
  assert.equal(POLICIES_VERSION, "stub");
  assert.equal(REVIEW_VERSION, "possibly_same_v1");
  assert.equal(INVESTIGATION_WORKSPACE_VERSION, "private_evidence_workspace_v1");
  assert.equal(PUBLICATION_VERSION, "public_er_v1");

  const candidates = generateCandidates([
    { id: "a", display_name: "Acme Construction LLC", entity_type: "vendor" },
    { id: "b", display_name: "Acme Construction Inc", entity_type: "vendor" },
    { id: "c", display_name: "Different Vendor", entity_type: "vendor" },
  ]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].shared_keys, ["stem:ACME CONSTRUCTION", "tok:ACME", "tok:CONSTRUCTION"]);
  const features = extractFeatures(
    { display_name: "Acme Construction LLC" },
    { display_name: "ACME CONSTRUCTION, INC." },
  );
  assert.equal(features.stem_equal, true);
  assert.equal(features.token_jaccard, 1);

  const scored = scorePair({ name: "A" }, { name: "B" });
  assert.equal(scored.decision, "unresolved");
  assert.equal(typeof scored.confidence, "number");

  const routed = routeDecision(scored);
  assert.equal(routed.auto_link, false);
  assert.equal(toReviewItem({ id: 1 }, scored), null);
  assert.equal(typeof buildInvestigationWorkspace, "function");

  assert.deepEqual(
    serializePublicEntity({ id: "vendor:acme", entity_type: "vendor", display_name: "Acme" }),
    { id: "vendor:acme", type: "vendor", name: "Acme" },
  );
  assert.deepEqual(
    serializePublicEntityLink({
      canonical_entity_id: "vendor:acme",
      source_system: "city_record",
      source_system_id: "notice-1",
    }),
    { entity_id: "vendor:acme", source: { system: "city_record", id: "notice-1" } },
  );
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
  assert.equal(typeof buildClericalAudit, "function");
});

test("no generic public entity-resolution service routes in worker modules", () => {
  // The bounded dossier read model is allowed; the ER engine itself remains an
  // in-process package rather than a generic network service.
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
        `${file} must not register a generic public ER service route (matched ${re})`,
      );
    }
  }
});

test("README documents extract criteria and non-goals", () => {
  const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
  assert.match(readme, /Extract criteria/i);
  assert.match(readme, /Non-goals/i);
  assert.match(readme, /Multi-app consumers/i);
  assert.match(readme, /No writable public HTTP/i);
  assert.match(readme, /\/entity-dossier/);
  assert.match(readme, /modular/i);
});
