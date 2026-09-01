import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { classifyMissingPath, CardProfileMissingPath } = require("../tools/card_profile_sentinel.cjs");

const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
const config = readJson("tools/card-profile/profile.config.v1.json");
const closure = readJson("tools/card-profile/closure.v1.json");
const patterns = readFileSync(resolve(ROOT, "tools/card-profile/card-work.sparse"), "utf8")
  .split("\n")
  .filter((line) => line && !line.startsWith("#"));

const tracked = new Set(
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean)
);

const sparseActive = (() => {
  try {
    return (
      execFileSync("git", ["config", "--get", "core.sparseCheckout"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() === "true"
    );
  } catch {
    return false;
  }
})();

test("the committed patterns cover the closure and materialise nothing deferred", () => {
  const result = spawnSync(process.execPath, ["tools/derive_card_profile.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("every path the profile declares is a tracked path", () => {
  for (const path of closure.site_data.profile_paths) {
    assert.ok(tracked.has(path), `declared site/data closure path is not tracked: ${path}`);
  }
});

test("no directory pattern reaches into an excluded byte-heavy tree", () => {
  const directoryPatterns = patterns.filter((pattern) => pattern.endsWith("/"));
  for (const pattern of directoryPatterns) {
    const prefix = pattern.slice(1, -1);
    for (const tree of config.exclude_trees) {
      assert.ok(
        !(tree === prefix || tree.startsWith(`${prefix}/`)),
        `directory pattern ${pattern} would materialise the excluded tree ${tree}`
      );
    }
  }
});

test("the profile leaves most of the measured site/data dominant out of the working tree", () => {
  const measured = closure.measured.site_data;
  assert.ok(measured.tracked_count > measured.profile_count);
  const share = measured.profile_logical_bytes / measured.tracked_logical_bytes;
  assert.ok(share < 0.5, `profile holds ${(share * 100).toFixed(1)}% of tracked site/data bytes`);
});

test("every deferred path is a tracked path that the patterns do not materialise", () => {
  const matches = (path) =>
    patterns.some((pattern) => (pattern.endsWith("/") ? path.startsWith(pattern.slice(1)) : path === pattern.slice(1)));
  assert.ok(closure.deferred_hydration_set.paths.length > 0);
  for (const path of closure.deferred_hydration_set.paths) {
    assert.ok(tracked.has(path), `deferred path is not tracked: ${path}`);
    assert.ok(!matches(path), `deferred path is materialised by the patterns: ${path}`);
  }
});

test("the cross-boundary risk CI-08 measured is represented in the closure", () => {
  // Worker sources reach into site/, including into site/data. The profile is
  // only safe if those targets are part of what it materialises.
  assert.ok(closure.sources.static.worker_to_site_reference_count > 0);
  assert.ok(closure.sources.static.worker_to_site_data_reference_count > 0);
  for (const path of closure.sources.static.worker_to_site_data_targets) {
    assert.ok(
      closure.site_data.profile_paths.includes(path),
      `a Worker-referenced site/data path is not in the profile: ${path}`
    );
  }
});

test("every supported gate class has a recorded observation receipt", () => {
  for (const gate of config.gate_classes.filter((entry) => entry.profile_supported)) {
    const path = `docs/evidence/ci-09-working-copy-reduction/raw/closure/${gate.observation}`;
    assert.ok(existsSync(resolve(ROOT, path)), `missing observation receipt: ${path}`);
    const receipt = readJson(path);
    assert.equal(receipt.gate_class, gate.id);
    assert.ok(receipt.paths.length > 0, `observation receipt records no paths: ${path}`);
    assert.equal(receipt.exit_status, 0, `observation receipt records a failing gate: ${path}`);
  }
});

test("every observed read of a supported gate class is inside the profile", () => {
  // This is the property the naive CI-08 sparse profile did not have.
  const profilePaths = new Set(
    execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean)
  );
  const deferred = new Set(closure.deferred_hydration_set.paths);
  for (const gate of config.gate_classes.filter((entry) => entry.profile_supported)) {
    const receipt = readJson(`docs/evidence/ci-09-working-copy-reduction/raw/closure/${gate.observation}`);
    for (const path of receipt.paths) {
      assert.ok(profilePaths.has(path), `observed path is not tracked: ${path}`);
      assert.ok(!deferred.has(path), `an observed path was deferred out of the profile: ${path}`);
    }
  }
});

test("the manifest names the gate classes that stay full-checkout-only", () => {
  const ids = closure.full_checkout_only.map((entry) => entry.id);
  for (const required of ["evidence-placement", "pages-build", "full-history-guards"]) {
    assert.ok(ids.includes(required), `full-checkout-only class not declared: ${required}`);
  }
  for (const entry of closure.full_checkout_only) {
    assert.ok(entry.reason && entry.reason.length > 20, `full-checkout-only class has no reason: ${entry.id}`);
  }
});

test("a missing tracked path the profile excludes is escalated, not returned as a plain ENOENT", () => {
  const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const excluded = new Set(["site/data/excluded_example.json"]);

  const escalated = classifyMissingPath(enoent, "site/data/excluded_example.json", "readFileSync", excluded);
  assert.ok(escalated instanceof CardProfileMissingPath);
  assert.match(escalated.message, /provision_card_profile\.sh hydrate site\/data\/excluded_example\.json/);
  assert.equal(escalated.code, "CARD_PROFILE_MISSING_PATH");

  // A path outside the profile's responsibility keeps its original meaning.
  assert.equal(classifyMissingPath(enoent, "site/data/other.json", "readFileSync", excluded), enoent);
  assert.equal(classifyMissingPath(enoent, null, "readFileSync", excluded), enoent);
  const other = Object.assign(new Error("EACCES"), { code: "EACCES" });
  assert.equal(classifyMissingPath(other, "site/data/excluded_example.json", "readFileSync", excluded), other);
});

test("a full-checkout-only gate class is refused when the reduced profile is active", () => {
  const result = spawnSync(process.execPath, ["tools/verify_card_profile.mjs", "--gate", "evidence-placement"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CITYSCROLL_CARD_PROFILE_ASSUME_REDUCED: "1" }
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires the full-checkout control/);
});

test("a supported gate class is permitted in the reduced profile", () => {
  const result = spawnSync(process.execPath, ["tools/verify_card_profile.mjs", "--gate", "worker-unit"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CITYSCROLL_CARD_PROFILE_ASSUME_REDUCED: "1" }
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("the profile contract check passes on this checkout", () => {
  const result = spawnSync(process.execPath, ["tools/verify_card_profile.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
