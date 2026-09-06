import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  describeContract,
  inspectPublicPath,
  inspectPublicPaths,
  PUBLIC_NAMESPACE,
  PUBLIC_PATH_ROOTS,
} from "../tools/public_identity_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedPaths() {
  const result = spawnSync("git", ["-C", ROOT, "ls-files", "--", ...PUBLIC_PATH_ROOTS], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, "git ls-files must succeed");
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

test("the path rule is part of the stated contract", () => {
  const contract = describeContract();
  assert.deepEqual(contract.public_path_roots, [...PUBLIC_PATH_ROOTS]);
  assert.ok(contract.private_namespace_filename_pattern);
  assert.ok(contract.queue_position_segment_pattern);
});

test("a registry filename outside the one public namespace is rejected", () => {
  for (const path of [
    "architecture/evidence.d/cityscroll-some-grouping--xy-01-a-topic.json",
    "architecture/evidence.d/cityscroll-another-grouping--a-topic.json",
  ]) {
    const rules = inspectPublicPath(path).map((row) => row.rule);
    assert.ok(rules.includes("public-path-namespace"), path);
  }
});

test("the one public namespace is the registry filename form", () => {
  assert.deepEqual(
    inspectPublicPath(`architecture/evidence.d/${PUBLIC_NAMESPACE}--land-map-marker-join.json`),
    [],
  );
});

test("an abbreviation followed by an ordinal is rejected wherever it heads a segment", () => {
  for (const path of [
    "docs/evidence/xy-08-some-measured-thing/README.md",
    "docs/evidence/nested/xy-08-some-measured-thing/raw/environment.json",
    "artifacts/some-group/xy-02.json",
    "data/xy-09-some-fixtures/contract.v1.json",
    "artifacts/some-group/raw/xy-3-a-probe.jsonl",
  ]) {
    const rules = inspectPublicPath(path).map((row) => row.rule);
    assert.ok(rules.includes("public-path-queue-position"), path);
  }
});

test("a measurement is a description, not a queue position", () => {
  for (const path of [
    "artifacts/agency-fiscal-context/after-390.png",
    "artifacts/agency-fiscal-context/before-1440.png",
    "data/geography/layers/nta2020/26B.full.json",
    "docs/evidence/land-map-stage-affordance/after/1440.png",
    "artifacts/content-parity-r3/baseline-main/capture.json",
  ]) {
    assert.deepEqual(inspectPublicPath(path), [], path);
  }
});

test("the rule governs the public evidence roots and nothing else", () => {
  assert.deepEqual(inspectPublicPath("site/media/review/xy-04-a-thing/poster.png"), []);
  assert.deepEqual(inspectPublicPath("tools/capture_xy04_a_thing.py"), []);
});

test("every tracked path in the public evidence roots is descriptively named", () => {
  const paths = trackedPaths();
  assert.ok(paths.length > 0, "the public evidence roots must be tracked");
  const violations = inspectPublicPaths(paths);
  assert.deepEqual(
    violations.map((row) => `${row.path} (${row.rule})`),
    [],
    "a public evidence path must carry descriptive words, not a register namespace or a queue position",
  );
});
