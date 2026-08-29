import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const GUARD = new URL("../tools/check_stale_repo_name.mjs", import.meta.url);
const PROBE = new URL("../.legacy-name-guard-probe.txt", import.meta.url);
const legacyName = ["crol", "-", "list"].join("");
const bannedVocabulary = ["kra", "ken"].join("");
const reservedMarker = ["card-seal", "5rk8-qj2m-xv91"].join(":");

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

test("a novel banned vocabulary reference fails the guard", () => {
  writeFileSync(PROBE, `new ${bannedVocabulary} reference\n`);
  try {
    assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${bannedVocabulary}`, "i"));
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("the reserved content marker always fails the guard", () => {
  writeFileSync(PROBE, `reserved ${reservedMarker}\n`);
  try {
    assert.throws(() => runGuard(), new RegExp(`legacy-name-guard-probe.*${reservedMarker}`));
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});

test("allowlist rewrite refuses a novel occurrence", () => {
  writeFileSync(PROBE, `new ${legacyName} reference\n`);
  try {
    assert.throws(
      () => execFileSync(process.execPath, [GUARD.pathname, "--write"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }),
      new RegExp(`legacy-name-guard-probe.*${legacyName}`),
    );
  } finally {
    if (existsSync(PROBE)) unlinkSync(PROBE);
  }
});
