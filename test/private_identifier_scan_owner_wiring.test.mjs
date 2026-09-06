import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "tools/inverse_control_plane_guard.mjs");
const PREFLIGHT = join(ROOT, "tools/preflight-required-checks.sh");

/**
 * An obviously synthetic sentinel term. Real terms come from an owner-supplied
 * file outside this repository; this fixture proves the wiring without the
 * repository ever carrying a real private identifier.
 */
const SENTINEL = "zzqxownerwiringsentinel";

test("preflight wires the owner-controlled private-identifier scan behind a documented default path", () => {
  const source = readFileSync(PREFLIGHT, "utf8");
  assert.match(source, /PRIVATE_IDENTIFIER_TERMS_FILE:-\$HOME\/\.config\/estate\/private-terms\.txt/);
  assert.match(source, /--private --private-identifier-terms "\$PRIVATE_IDENTIFIER_TERMS_FILE"/);
  // The default path is documented, but never treated as required: without the
  // file, preflight must not fail closed for every contributor who lacks it.
  assert.match(source, /skipping the private-mode gate/);
  // The identical public-mode call runs first (that is CI's shape); the
  // private-mode call is strictly additional, never a replacement for it.
  const publicCallIndex = source.indexOf("node tools/inverse_control_plane_guard.mjs --check --all\n");
  const privateCallIndex = source.indexOf("--private --private-identifier-terms");
  assert.ok(publicCallIndex >= 0 && privateCallIndex > publicCallIndex);
});

test("through the same entry point preflight calls, an owner-supplied term set yields a real status, not SKIPPED", () => {
  const directory = mkdtempSync(join(tmpdir(), "private-identifier-owner-wiring-"));
  try {
    const termsFile = join(directory, "terms.txt");
    writeFileSync(termsFile, `${SENTINEL}\n`);
    const stdout = execFileSync(
      process.execPath,
      [GUARD, "--check", "--all", "--private", "--private-identifier-terms", termsFile],
      { cwd: ROOT, encoding: "utf8" },
    );
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.private_identifier_scan.status, "PASS");
    assert.notEqual(receipt.private_identifier_scan.status, "SKIPPED");
    assert.equal(receipt.private_identifier_scan.private_terms_supplied, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
