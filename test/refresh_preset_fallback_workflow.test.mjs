import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("live-derived preset fallback is not refreshed through a git workflow", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/refresh-preset-fallback.yml")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "site/data/preset-validation.json")),
    false,
  );
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /validate_presets\.mjs --check/);
  assert.doesNotMatch(ci, /refresh-preset-fallback/);
});
