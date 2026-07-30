// Characterization test for tools/changelog-path-guard.sh — the hard guard update-changelog.yml
// runs before arming self-merge on the changelog bot's own PR. Self-merge must only ever arm
// when the PR's changed paths are exclusively the changelog files the bot owns; anything else
// needs a human to look at it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "tools", "changelog-path-guard.sh");

function run(paths) {
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      input: paths.map((p) => p + "\n").join(""),
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stderr: err.stderr };
  }
}

test("both changelog-owned files changed: guard arms", () => {
  const result = run(["site/changelog-data.json", "site/changelog.html"]);
  assert.equal(result.code, 0);
});

test("only one changelog-owned file changed: guard arms", () => {
  const result = run(["site/changelog-data.json"]);
  assert.equal(result.code, 0);
});

test("a changelog file plus an unrelated path: guard does not arm", () => {
  const result = run(["site/changelog-data.json", "worker/src/index.mjs"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /worker\/src\/index\.mjs/);
});

test("an unrelated path only: guard does not arm", () => {
  const result = run(["package.json"]);
  assert.equal(result.code, 1);
});

test("no changed paths at all: guard fails closed", () => {
  const result = run([]);
  assert.equal(result.code, 1);
});
