import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const validator = new URL("../tools/validate_beta_flags.mjs", import.meta.url).pathname;

test("the committed registry satisfies the complete contract", () => {
  const result = spawnSync(
    process.execPath,
    [validator, "--today", "2026-07-29"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("an expired flag fails validation until removed or explicitly renewed", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-beta-flags-"));
  try {
    const registry = JSON.parse(
      readFileSync(new URL("../beta-flags.json", import.meta.url), "utf8"),
    );
    registry.flags[0].removal_date = "2026-07-28";
    const path = join(root, "registry.json");
    writeFileSync(path, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      [validator, "--registry", path, "--today", "2026-07-29"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expired on 2026-07-28/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("access-control fields are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-beta-flags-"));
  try {
    const registry = JSON.parse(
      readFileSync(new URL("../beta-flags.json", import.meta.url), "utf8"),
    );
    registry.flags[0].permissions = ["admin"];
    const path = join(root, "registry.json");
    writeFileSync(path, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      [validator, "--registry", path, "--today", "2026-07-29"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public flags never grant access/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
