import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { loadSourceContracts, rederiveDepot } from "../tools/depot.mjs";

const ROOT = join(dirname(import.meta.filename), "..");
const FIXTURE = join(ROOT, "warehouse", "fixtures", "public-records-release");
const SCRIPT = join(ROOT, "warehouse", "scripts", "release_capture.mjs");
const roots = [];

function caseRoot() {
  const root = mkdtempSync(join(tmpdir(), "release-capture-"));
  roots.push(root);
  copyFileSync(join(FIXTURE, "records.json"), join(root, "records.json"));
  copyFileSync(join(FIXTURE, "success.json"), join(root, "success.json"));
  copyFileSync(join(FIXTURE, "duplicate.json"), join(root, "duplicate.json"));
  copyFileSync(join(FIXTURE, "mismatch.json"), join(root, "mismatch.json"));
  copyFileSync(join(FIXTURE, "gap_taxonomy.json"), join(root, "gap_taxonomy.json"));
  writeFileSync(join(root, "gap-taxonomy.md"), "# Fixture gap taxonomy\n");
  return root;
}

function run(root, manifest) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--manifest", join(root, manifest),
    "--warehouse-root", join(root, "warehouse"),
    "--taxonomy", join(root, "gap_taxonomy.json"),
    "--taxonomy-doc", join(root, "gap-taxonomy.md"),
  ], { cwd: ROOT, encoding: "utf8" });
}

test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

test("captures a release with provenance and closes a class-B gap", () => {
  const root = caseRoot();
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.match(gitignore, /!warehouse\/raw\/public-records\/\*\*/);
  assert.match(gitignore, /!warehouse\/receipts\/public-records\/\*\*/);
  const result = run(root, "success.json");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "captured",
    release_id: "foil-fixture-001",
    receipt_path: join(root, "warehouse", "receipts", "public-records", "foil-fixture-001.json"),
    raw_path: join(root, "warehouse", "raw", "public-records", "foil-fixture-001", "records.json"),
    gap_id: "fixture-class-b-gap",
    gap_class: "not_yet_ingested",
    gap_disposition: "landed",
  });

  const receiptPath = join(root, "warehouse", "receipts", "public-records", "foil-fixture-001.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.schema, "cityscroll.public_records_release_receipt.v1");
  assert.deepEqual(receipt.source, {
    type: "public-records request (FOIL)",
    body: "Department of Public Records",
    request_identifier: "FOIL-2026-001",
    received_date: "2026-08-06",
  });
  assert.equal(receipt.artifact.format, "json");
  assert.equal(receipt.artifact.sha256, "939aefe7570d8f0d073fef6af00ff10825e3465e12c158f41a66f13cddcb4119");
  assert.equal(existsSync(join(root, "warehouse", "raw", "public-records", "foil-fixture-001", "records.json")), true);

  const taxonomyPath = join(root, "gap_taxonomy.json");
  const taxonomy = JSON.parse(readFileSync(taxonomyPath, "utf8"));
  const gap = taxonomy.gaps[0];
  assert.equal(gap.class, "not_yet_ingested");
  assert.equal(gap.disposition, "landed");
  assert.equal(gap.closure.status, "closed_by_acquisition");
  assert.equal(gap.closure.closed_on, "2026-08-06");
  assert.equal(gap.closure.artifact_sha256, receipt.artifact.sha256);
  assert.match(gap.closure_receipt, /warehouse\/receipts\/public-records\/foil-fixture-001\.json$/);
  assert.match(readFileSync(join(root, "gap-taxonomy.md"), "utf8"), /foil-fixture-001\.json/);

  const rederived = rederiveDepot(taxonomy, loadSourceContracts(), { observedOn: "2026-08-06" });
  const rederivedGap = rederived.registry.gaps.find((row) => row.id === gap.id);
  assert.equal(rederivedGap.class, "not_yet_ingested");
  assert.equal(rederivedGap.disposition, "landed");
  assert.equal(rederivedGap.closure_receipt, gap.closure_receipt);
});

test("duplicate delivery is idempotent", () => {
  const root = caseRoot();
  assert.equal(run(root, "success.json").status, 0);
  const receiptPath = join(root, "warehouse", "receipts", "public-records", "foil-fixture-001.json");
  const before = readFileSync(receiptPath);
  const duplicate = run(root, "duplicate.json");
  assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.stdout);
  assert.equal(JSON.parse(duplicate.stdout).status, "duplicate");
  assert.deepEqual(readFileSync(receiptPath), before);
});

test("artifact hash mismatch is refused before warehouse writes", () => {
  const root = caseRoot();
  const mismatch = run(root, "mismatch.json");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /artifact hash mismatch/);
  assert.equal(existsSync(join(root, "warehouse", "receipts", "public-records", "foil-fixture-mismatch.json")), false);
  assert.equal(existsSync(join(root, "warehouse", "raw", "public-records", "foil-fixture-mismatch")), false);
});
