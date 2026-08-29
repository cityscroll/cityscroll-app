import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const GUARD = new URL("../tools/check_stale_repo_name.mjs", import.meta.url);
const PROBE = new URL("../.legacy-name-guard-probe.txt", import.meta.url);
const legacyName = ["crol", "-", "list"].join("");

function runGuard() {
  return execFileSync(process.execPath, [GUARD.pathname], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
}

test("the checked-in compatibility inventory is accepted", () => {
  assert.match(runGuard(), /guard passed/i);
});

test("a novel unallowlisted reference fails the guard", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  try {
    assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});
