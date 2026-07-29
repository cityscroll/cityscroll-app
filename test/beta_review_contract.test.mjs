import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBetaReview } from "../tools/check_beta_review_contract.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const completeBody = `
## Beta review

Beta link: https://pr-42.crol-list-beta.pages.dev

Review deadline: 2026-08-05

Chat prompt: React ✅ if you would be comfortable shipping this. Otherwise reply with the screen, concern, and preferred change.

### Site owner outcome

- [x] Promote
- [ ] Revise
- [ ] Withdraw

Outcome summary:
The reviewed interaction is ready for the beta channel.

Objection disposition:
One spacing concern was resolved; no other responses were received.
`;

test("the pull request template carries the complete chat-to-PR record", () => {
  const template = read(".github/PULL_REQUEST_TEMPLATE.md");
  assert.match(template, /Beta link:/);
  assert.match(template, /Review deadline:/);
  assert.match(template, /React ✅/);
  assert.match(template, /screen, concern, and preferred change/);
  assert.match(template, /Site owner outcome/);
  assert.match(template, /Outcome summary:/);
  assert.match(template, /Objection disposition:/);
  assert.match(template, /Silence is recorded as no response, not approval/);
});

test("the existing required unit check enforces beta readiness", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /ready_for_review/);
  assert.match(workflow, /labeled/);
  assert.match(workflow, /node tools\/check_beta_review_contract\.mjs/);
  assert.match(workflow, /github\.event_name == 'pull_request'/);
});

test("draft beta reviews may remain incomplete while review is active", () => {
  assert.deepEqual(
    validateBetaReview({
      number: 42,
      draft: true,
      labels: ["preview:beta"],
      body: "## Beta review\n\nReview is in progress.",
    }),
    [],
  );
});

test("a ready beta review requires an affirmative, complete public record", () => {
  assert.deepEqual(
    validateBetaReview({
      number: 42,
      draft: false,
      labels: ["preview:beta"],
      body: completeBody,
    }),
    [],
  );

  const errors = validateBetaReview({
    number: 42,
    draft: false,
    labels: ["preview:beta"],
    body: completeBody
      .replace("- [x] Promote", "- [ ] Promote")
      .replace("- [ ] Revise", "- [x] Revise"),
  });
  assert.ok(errors.some((error) => /Promote/.test(error)));
});

test("the gate rejects missing review facts and the wrong preview alias", () => {
  const errors = validateBetaReview({
    number: 42,
    draft: false,
    labels: ["preview:beta"],
    body: completeBody
      .replace("https://pr-42.crol-list-beta.pages.dev", "https://example.com")
      .replace("2026-08-05", "soon")
      .replace(
        "The reviewed interaction is ready for the beta channel.",
        "<!-- summarize -->",
      ),
  });

  assert.ok(errors.some((error) => /preview alias/.test(error)));
  assert.ok(errors.some((error) => /YYYY-MM-DD/.test(error)));
  assert.ok(errors.some((error) => /outcome summary/.test(error)));
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
