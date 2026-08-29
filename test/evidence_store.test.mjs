import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function run(args) {
  return spawnSync("python3", ["tools/evidence_store.py", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("records a content-addressed WebP with CI review references and retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-evidence-store-"));
  const capture = join(dir, "capture.webp");
  writeFileSync(capture, Buffer.from("RIFF0000WEBP fixture bytes"));
  const result = run([
    "record", "--file", capture, "--root", dir, "--pr-number", "1401",
    "--card-id", "repo-diet/evidence-store-v1", "--capture-kind", "content-parity-full-page",
    "--surface", "home", "--phase", "before", "--viewport-width", "390", "--viewport-height", "844",
    "--commit", "abc123", "--captured-at", "2026-08-29T00:00:00Z",
    "--artifact-url", "https://github.com/cityscroll/cityscroll-app/actions/runs/123/artifacts",
    "--gate-receipt", "https://github.com/cityscroll/cityscroll-app/actions/runs/123/artifacts#gate-receipt",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.sha256, row.hash);
  assert.equal(row.media_type, "image/webp");
  assert.equal(row.viewport, "390x844");
  assert.equal(row.retention_deadline, "2026-11-27T00:00:00Z");
  assert.match(row.url, /^https:\/\/github\.com\/cityscroll\/cityscroll-app\/actions\/runs\/123\/artifacts#evidence\//);
  assert.equal(run(["check", "--root", dir, "--require-rows"]).status, 0);
});

test("rejects a local filesystem review URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-evidence-store-"));
  const capture = join(dir, "capture.webp");
  writeFileSync(capture, Buffer.from("RIFF0000WEBP fixture bytes"));
  const result = run([
    "record", "--file", capture, "--root", dir, "--card-id", "card", "--capture-kind", "kind",
    "--surface", "home", "--phase", "before", "--viewport-width", "390", "--viewport-height", "844",
    "--artifact-url", `file://${capture}`,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local filesystem URL/);
});

test("release evidence has indefinite retention and a backstage URL locally", () => {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-evidence-store-"));
  const capture = join(dir, "capture.webp");
  writeFileSync(capture, Buffer.from("RIFF0000WEBP release fixture bytes"));
  const result = run([
    "record", "--file", capture, "--root", dir, "--card-id", "card", "--capture-kind", "kind",
    "--surface", "home", "--phase", "release-evidence", "--viewport-width", "1440", "--viewport-height", "900",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.retention_deadline, null);
  assert.equal(row.retention, "indefinite");
  assert.match(row.url, /^backstage:\/\/cityscroll-evidence\/objects\//);
});
