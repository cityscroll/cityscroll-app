import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";
import { buildReviewQueue } from "../worker/src/lib/review_queue.mjs";

const fixtures = readJson("data/wave4/review-fixtures.json");
const bundle = readJson("data/review_queue.json");
assert.deepEqual(bundle.queue, buildReviewQueue(fixtures.records));
assert.equal(bundle.methodology.human_review_required, true);
assert.ok(bundle.methodology.blind_spots.length >= 3);
assert.ok(bundle.methodology.exclusions.includes("browser_history"));
assert.doesNotMatch(JSON.stringify(bundle), /\b(is of public interest|misconduct occurred|corrupt|fraudulent|guilty)\b/i);
for (const record of bundle.queue) {
  assert.equal(Object.keys(record.components).length, Object.keys(record.remove_one).length);
  for (const [component, counterfactual] of Object.entries(record.remove_one)) {
    assert.equal(counterfactual.score_without, record.score - record.components[component]);
  }
}
console.log(`audited ${bundle.queue.length} review-queue records`);
