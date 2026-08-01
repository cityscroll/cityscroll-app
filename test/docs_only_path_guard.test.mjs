// Characterization for tools/docs-only-path-guard.sh — docs-only PRs take the
// unit/browser fast path so the merge queue is not starved of required checks.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "tools", "docs-only-path-guard.sh");

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

test("docs/** only: guard passes", () => {
  assert.equal(run(["docs/architecture.md", "docs/adr/foo.md"]).code, 0);
});

test("top-level Markdown only: guard passes", () => {
  assert.equal(run(["README.md", "CONTRIBUTING.md", "Agents.md"]).code, 0);
});

test("docs plus top-level Markdown: guard passes", () => {
  assert.equal(run(["docs/gap-taxonomy.md", "README.md"]).code, 0);
});

test("site path is not docs-only", () => {
  const result = run(["docs/architecture.md", "site/index.html"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /site\/index\.html/);
});

test("worker path is not docs-only", () => {
  assert.equal(run(["worker/src/index.mjs"]).code, 1);
});

test("nested markdown outside docs/ fails closed", () => {
  assert.equal(run(["entity_resolution/README.md"]).code, 1);
});

test("empty path set fails closed", () => {
  assert.equal(run([]).code, 1);
});
