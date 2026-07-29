import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBetaReview } from "../tools/check_beta_review_contract.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const capabilityBody = `
## Stable preview alias

https://pr-42.crol-list-beta.pages.dev/

## What this enables

The alias follows the pull request head and records exact commit provenance.
`;
const GOVERNANCE_PROSE = [
  /Chat prompt:/i,
  /Review deadline:/i,
  /Site owner outcome/i,
  /Outcome summary:/i,
  /Objection disposition:/i,
  /Silence is recorded as no response/i,
];

test("the pull request template is capability-only", () => {
  const template = read(".github/PULL_REQUEST_TEMPLATE.md");
  assert.match(template, /Preview alias:/);
  for (const pattern of GOVERNANCE_PROSE) {
    assert.doesNotMatch(template, pattern);
  }
});

test("public beta guidance contains no team-governance workflow", () => {
  for (const path of [
    "CONTRIBUTING.md",
    "docs/beta-channel.md",
    "tools/check_beta_review_contract.mjs",
  ]) {
    const source = read(path);
    for (const pattern of GOVERNANCE_PROSE) {
      assert.doesNotMatch(source, pattern, `${path}: ${pattern}`);
    }
  }
});

test("the existing required unit check enforces the technical alias contract", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /ready_for_review/);
  assert.match(workflow, /labeled/);
  assert.match(workflow, /Beta preview alias contract/);
  assert.match(workflow, /node tools\/check_beta_review_contract\.mjs/);
  assert.match(workflow, /github\.event_name == 'pull_request'/);
});

test("draft beta previews may omit the alias while deployment is pending", () => {
  assert.deepEqual(
    validateBetaReview({
      number: 42,
      draft: true,
      labels: ["preview:beta"],
      body: "",
    }),
    [],
  );
});

test("a ready beta preview requires its own stable alias", () => {
  assert.deepEqual(
    validateBetaReview({
      number: 42,
      draft: false,
      labels: ["preview:beta"],
      body: capabilityBody,
    }),
    [],
  );
});

test("the gate rejects a missing or wrong preview alias", () => {
  for (const body of [
    "",
    capabilityBody.replace("pr-42", "pr-41"),
    "https://example.com/",
  ]) {
    const errors = validateBetaReview({
      number: 42,
      draft: false,
      labels: ["preview:beta"],
      body,
    });
    assert.ok(errors.some((error) => /preview alias/.test(error)));
  }
});

test("unlabeled pull requests do not acquire beta-only requirements", () => {
  assert.deepEqual(
    validateBetaReview({
      number: 42,
      draft: false,
      labels: [],
      body: "",
    }),
    [],
  );
});
