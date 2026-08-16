import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("local accessibility setup uses one persistent pinned environment", () => {
  const setup = read("tools/setup_local_a11y_python.sh");
  const runner = read("tools/with_local_a11y_python.sh");
  const preflight = read("tools/preflight-required-checks.sh");
  const makefile = read("Makefile");

  assert.match(setup, /XDG_DATA_HOME.*\.local\/share/);
  assert.match(setup, /\.github\/actions\/setup-playwright\/requirements\.txt/);
  assert.match(setup, /-m venv/);
  assert.doesNotMatch(setup, /--user|--break-system-packages/);

  assert.match(runner, /CROL_A11Y_VENV/);
  assert.match(runner, /export PATH=/);
  assert.match(makefile, /^setup-a11y:/m);
  assert.match(makefile, /^a11y:/m);
  assert.match(makefile, /with_local_a11y_python\.sh .*preflight-required-checks\.sh --full/);

  assert.doesNotMatch(preflight, /pip install playwright/);
  assert.match(preflight, /Run 'make setup-a11y' once, then use 'make a11y'/);
});
