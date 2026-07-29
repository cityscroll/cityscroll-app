import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReviewQueue, reviewComponents, scoreReviewRecord } from "../worker/src/lib/review_queue.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../data/wave4/review-fixtures.json", import.meta.url)));
const bundle = JSON.parse(readFileSync(new URL("../data/review_queue.json", import.meta.url)));

test("every ordering decomposes and reproduces from visible source facts", () => {
  assert.deepEqual(buildReviewQueue(fixtures.records), bundle.queue);
  for (const source of fixtures.records) {
    const scored = scoreReviewRecord(source);
    assert.deepEqual(scored.components, reviewComponents(source));
    assert.equal(scored.score, Object.values(scored.components).reduce((sum, value) => sum + value, 0));
    assert.ok(scored.source_urls.length);
  }
});

test("remove-one counterfactual exposes the effect of every component", () => {
  for (const record of bundle.queue) {
    for (const [component, value] of Object.entries(record.components)) {
      assert.deepEqual(record.remove_one[component], {
        score_without: record.score - value,
        change: value ? -value : 0
      });
    }
  }
});

test("the queue feeds the shipped investigation workspace", () => {
  assert.ok(bundle.queue.every((record) => record.investigation_href === "#investigation"));
});

test("methodology ranks review effort without predicting scandal", () => {
  assert.equal(bundle.methodology.label, "Review priority");
  assert.equal(bundle.methodology.human_review_required, true);
  assert.doesNotMatch(JSON.stringify(bundle), /\b(is of public interest|misconduct occurred|corrupt|fraudulent|guilty)\b/i);
  assert.ok(bundle.queue.every((record) => /does not determine public interest/.test(record.caveat)));
});
