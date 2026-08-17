import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = fs.readFileSync(
  path.join(ROOT, ".github/workflows/refresh-preset-fallback.yml"),
  "utf8",
);

test("preset fallback refresh writes through a pull request, never protected main", () => {
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /peter-evans\/create-pull-request@v8/);
  assert.match(workflow, /branch: automation\/refresh-preset-fallback/);
  assert.doesNotMatch(workflow, /HEAD:main|refs\/heads\/main/);
});

test("preset fallback refresh skips no-op commits and dispatches required PR checks", () => {
  assert.match(workflow, /if \[ -z "\$changed" \]/);
  assert.match(workflow, /echo "changed=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /gh workflow run ci\.yml --ref automation\/refresh-preset-fallback/);
});
