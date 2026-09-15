import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflows = {
  "ci.yml": "ci",
  "time-travel.yml": "time-travel",
  "architecture-reconciliation.yml": "architecture-reconciliation",
  "no-home-path-leak.yml": "home-path-leak-guard",
  "external-consumer-proof.yml": "external-consumer-proof",
};

for (const [file, name] of Object.entries(workflows)) {
  test(`${file} preserves isolated supersession concurrency`, () => {
    const source = fs.readFileSync(`.github/workflows/${file}`, "utf8");
    assert.match(source, new RegExp(`concurrency:\\s+group: ${name}-\\$\\{\\{ github\\.event\\.pull_request\\.number \\|\\| github\\.ref \\}\\}`));
    assert.match(source, /cancel-in-progress:\s+\$\{\{[^\n]*refs\/heads\/main[^\n]*refs\/heads\/gh-readonly-queue\//);
  });
}
