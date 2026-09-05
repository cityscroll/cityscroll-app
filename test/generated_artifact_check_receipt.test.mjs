import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GENERATED_ARTIFACT_CHECK_RECEIPT_SCHEMA,
  buildCheckReceipt,
  sha256,
  verifyFromCheckReceipt,
} from "../tools/lib/generated_artifact_check_receipt.mjs";
import { moduleSourceFingerprint } from "../tools/lib/module_source_fingerprint.mjs";

const GENERATOR = "tools/build_shared_procurement_read_model.mjs";
const FINGERPRINT = "generator-fingerprint";
const INPUTS = { "site/data/spine.json": sha256("spine"), "site/data/awards.json": sha256("awards") };

function emitted(root) {
  mkdirSync(join(root, "site/data/model"), { recursive: true });
  const groups = [
    {
      artifactLabel: "stale procurement artifact",
      shardLabel: "stale procurement shard",
      shardDir: "site/data/model",
      expectedNames: ["shard-000.json", "shard-001.json"],
      outputs: [
        ["site/data/model.json", "{\"manifest\":true}\n"],
        ["site/data/model/shard-000.json", "{\"shard\":0}\n"],
        ["site/data/model/shard-001.json", "{\"shard\":1}\n"],
      ],
    },
    {
      artifactLabel: "stale procurement artifact",
      shardLabel: null,
      shardDir: null,
      expectedNames: null,
      outputs: [["site/data/digest.json", "{\"digest\":true}\n"]],
    },
  ];
  for (const group of groups) {
    for (const [path, content] of group.outputs) writeFileSync(join(root, path), content);
  }
  return groups;
}

function verify(root, receipt, overrides = {}) {
  return verifyFromCheckReceipt({
    receipt,
    root,
    generator: GENERATOR,
    generatorFingerprint: FINGERPRINT,
    inputs: INPUTS,
    ...overrides,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "check-receipt-"));
  const groups = emitted(root);
  const receipt = buildCheckReceipt({
    generator: GENERATOR,
    generatedAt: "2026-09-05T00:00:00Z",
    rowCount: 42,
    generatorFingerprint: FINGERPRINT,
    inputs: INPUTS,
    groups,
  });
  return { root, receipt };
}

test("a receipt from the same inputs and generator verifies the emitted artifacts", () => {
  const { root, receipt } = fixture();
  try {
    assert.equal(receipt.schema, GENERATED_ARTIFACT_CHECK_RECEIPT_SCHEMA);
    assert.equal(receipt.outputs.length, 4);
    const verified = verify(root, receipt);
    assert.deepEqual(verified, { current: true, rowCount: 42, stale: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edited artifact is stale, and names the same artifact the rebuild path names", () => {
  const { root, receipt } = fixture();
  try {
    writeFileSync(join(root, "site/data/digest.json"), "{\"digest\":false}\n");
    const verified = verify(root, receipt);
    assert.equal(verified.current, false);
    assert.deepEqual(verified.stale, [`stale procurement artifact: ${join(root, "site/data/digest.json")}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing artifact is stale", () => {
  const { root, receipt } = fixture();
  try {
    rmSync(join(root, "site/data/model/shard-001.json"));
    const verified = verify(root, receipt);
    assert.equal(verified.current, false);
    assert.equal(verified.stale.length, 1);
    assert.match(verified.stale[0], /stale procurement artifact: .*shard-001\.json$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a surplus shard left behind by an earlier build is stale", () => {
  const { root, receipt } = fixture();
  try {
    writeFileSync(join(root, "site/data/model/shard-009.json"), "{\"shard\":9}\n");
    const verified = verify(root, receipt);
    assert.equal(verified.current, false);
    assert.deepEqual(verified.stale, [`stale procurement shard: ${join(root, "site/data/model/shard-009.json")}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt from different inputs cannot stand in for a rebuild", () => {
  const { root, receipt } = fixture();
  try {
    assert.equal(verify(root, receipt, {
      inputs: { ...INPUTS, "site/data/awards.json": sha256("awards-advanced") },
    }), null);
    assert.equal(verify(root, receipt, { inputs: { "site/data/spine.json": INPUTS["site/data/spine.json"] } }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt from a different generator revision cannot stand in for a rebuild", () => {
  const { root, receipt } = fixture();
  try {
    assert.equal(verify(root, receipt, { generatorFingerprint: "other-fingerprint" }), null);
    assert.equal(verify(root, receipt, { generator: "tools/other_generator.mjs" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent or foreign receipt cannot stand in for a rebuild", () => {
  const { root, receipt } = fixture();
  try {
    assert.equal(verify(root, null), null);
    assert.equal(verify(root, { ...receipt, schema: "something.else.v1" }), null);
    assert.equal(verify(root, { ...receipt, outputs: undefined }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the generator source fingerprint covers the modules the generator reaches", () => {
  const root = new URL("../", import.meta.url).pathname;
  const graph = moduleSourceFingerprint(join(root, GENERATOR), root);
  assert.match(graph.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(graph.files.includes(GENERATOR));
  // The modules the read model is actually built from must participate, or a
  // logic change there could pass a receipt-backed check unnoticed.
  for (const file of [
    "site/shared_procurement_read_model.mjs",
    "site/cross_source_evidence_receipt.mjs",
    "site/checkbook_passport_corroboration.mjs",
    "site/procurement_search_producer.mjs",
    "site/procurement_digest_compile.mjs",
    "site/procurement_process_events.mjs",
    "site/procurement_read_model_shards.mjs",
    "site/procurement_browse_query.mjs",
  ]) {
    assert.ok(graph.files.includes(file), `${file} must be covered by the generator fingerprint`);
  }
});

test("the generator source fingerprint changes when a reached module changes", () => {
  const root = mkdtempSync(join(tmpdir(), "fingerprint-"));
  try {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "entry.mjs"), 'import { value } from "./lib/leaf.mjs";\nexport default value;\n');
    writeFileSync(join(root, "lib/leaf.mjs"), "export const value = 1;\n");
    const before = moduleSourceFingerprint(join(root, "entry.mjs"), root);
    assert.deepEqual(before.files, ["entry.mjs", "lib/leaf.mjs"]);
    writeFileSync(join(root, "lib/leaf.mjs"), "export const value = 2;\n");
    assert.notEqual(moduleSourceFingerprint(join(root, "entry.mjs"), root).fingerprint, before.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
