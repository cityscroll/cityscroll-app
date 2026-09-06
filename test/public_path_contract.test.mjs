import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// One entry could not be renamed with the rest. Its identity is declared on the
// same physical source line as a published schema id, so no edit changes the
// identity without also reprinting that schema id; renaming the schema id is a
// separate contract change with its own consumers.
//
// The exception pins that path by SHA-256 rather than by name. The rule exists to
// keep this class of name out of the repository's text, and an exception written
// in plain characters would put one back — the digest identifies the path exactly
// without reprinting it, and cannot be read back into a name. It is one exact
// path, not a pattern, and the test below fails if it ever stops being needed, so
// it cannot outlive the rename it is waiting for.
const PENDING_RENAME_SHA256 = "245d1728db582a773fcbc11ed3fcede9742d194427d2731b6a4a4e2fba9e72e1";

function pathDigest(path) {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

test("exactly one tracked path is pending a rename, and it is the pinned one", () => {
  const pending = trackedPaths().filter((path) => inspectPublicPath(path).length > 0);
  assert.deepEqual(
    pending.map(pathDigest),
    [PENDING_RENAME_SHA256],
    "delete this exception once the pinned path is renamed; a second pending path is a regression",
  );
});

test("every other tracked path in the public evidence roots is descriptively named", () => {
  const paths = trackedPaths();
  assert.ok(paths.length > 0, "the public evidence roots must be tracked");
  const violations = inspectPublicPaths(
    paths.filter((path) => pathDigest(path) !== PENDING_RENAME_SHA256),
  );
  assert.deepEqual(
    violations.map((row) => `${row.path} (${row.rule})`),
    [],
    "a public evidence path must carry descriptive words, not a register namespace or a queue position",
  );
});
