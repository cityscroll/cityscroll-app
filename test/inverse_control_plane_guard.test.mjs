import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { aggregateArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";
import { classifyPath, evaluate, scanDocument, validateManifest } from "../tools/inverse_control_plane_guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = "test/fixtures/inverse-control-plane";
const manifest = JSON.parse(readFileSync(join(ROOT, "docs/repository-control-plane/inverse-guard.v1.json"), "utf8"));
const architecture = aggregateArchitectureEvidence({ root: ROOT });

function fixture(kind, name) {
  const text = readFileSync(join(ROOT, FIXTURES, kind, name), "utf8");
  if (name === "private-evidence.json") return JSON.parse(text).scheme_parts.join("");
  return text;
}

function publicScan(kind, name, contentClass = "public-current-contract") {
  return scanDocument({
    path: `${FIXTURES}/${kind}/${name}`,
    text: fixture(kind, name),
    classification: {
      content_class: contentClass,
      canonical_owner: "cityscroll-engineering/inverse-control-plane-guard",
      allowed_evidence_contract: "current-contract-only",
    },
  });
}

test("manifest is versioned, typed, and every register id resolves through MT-7 source cards", () => {
  assert.equal(architecture.status, "PASS");
  assert.deepEqual(validateManifest(manifest, architecture.sourceCards), []);
  assert.equal(manifest.source_card_inventory.provider, "architecture-evidence-shards");
  for (const row of manifest.classifications) {
    for (const field of ["path_pattern", "content_class", "canonical_owner", "register_id", "disposition", "allowed_evidence_contract"]) {
      assert.equal(typeof row[field], "string", `${row.id}.${field}`);
      assert.ok(row[field].length > 0, `${row.id}.${field}`);
    }
  }
});

test("invalid register reference fails through the existing source-card inventory", () => {
  const candidate = structuredClone(manifest);
  candidate.classifications[0].register_id = "cityscroll-engineering/does-not-exist";
  assert.deepEqual(validateManifest(candidate, architecture.sourceCards).map((row) => row.rule), ["unresolved-register-id"]);
});

const negativeMatrix = [
  ["repo-only-card.md", "repo-only-card-heading"],
  ["rollout-register.md", "rollout-register"],
  ["temporal-intent.md", "temporal-intent"],
  ["owner-confirmation.md", "owner-confirmation"],
  ["mutable-record.md", "mutable-planning-record"],
  ["internal-research.md", "internal-research-id"],
  ["private-evidence.json", "private-evidence-scheme"],
];

for (const [name, rule] of negativeMatrix) {
  test(`rejects ${rule}`, () => {
    assert.ok(publicScan("negative", name).some((row) => row.rule === rule));
  });
}

test("findings name path, rule, class, and owner", () => {
  const [row] = publicScan("negative", "rollout-register.md");
  assert.deepEqual(Object.keys(row), ["path", "rule", "class", "owner", "detail"]);
  assert.equal(row.class, "public-current-contract");
  assert.equal(row.owner, "cityscroll-engineering/inverse-control-plane-guard");
});

const positiveMatrix = [
  ["accepted-adr.md", "accepted-architecture-decision"],
  ["product-status.json", "public-source-contract"],
  ["http-status.md", "public-source-contract"],
  ["source-contract.json", "public-source-contract"],
  ["code-evidence.json", "public-code-coupled-evidence"],
  ["mt7-shard.json", "implementation-evidence-shard"],
  ["test-example.mjs", "test"],
  ["fixture-example.json", "test"],
];

for (const [name, contentClass] of positiveMatrix) {
  test(`permits ${name} as ${contentClass}`, () => {
    assert.deepEqual(publicScan("positive", name, contentClass), []);
  });
}

test("classification uses the first narrow typed path contract", () => {
  assert.equal(classifyPath("docs/adr/0001-example.md", manifest).content_class, "accepted-architecture-decision");
  assert.equal(classifyPath("test/example.test.mjs", manifest).content_class, "test");
  assert.equal(classifyPath("architecture/evidence.d/example--card.json", manifest).content_class, "implementation-evidence-shard");
  assert.equal(classifyPath("docs/ordinary.md", manifest).content_class, "public-current-contract");
});

test("changed-path evaluation is deterministic", () => {
  const paths = [
    `${FIXTURES}/negative/rollout-register.md`,
    `${FIXTURES}/negative/owner-confirmation.md`,
  ];
  const first = evaluate({ root: ROOT, manifest, paths, sourceCards: architecture.sourceCards });
  const second = evaluate({ root: ROOT, manifest, paths: [...paths].reverse(), sourceCards: architecture.sourceCards });
  assert.deepEqual(first, second);
});
