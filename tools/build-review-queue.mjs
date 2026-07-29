import { buildReviewQueue, REVIEW_WEIGHTS } from "../worker/src/lib/review_queue.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const fixtures = readJson("test/fixtures/wave4/review-fixtures.json");
writeOrCheck("test/fixtures/wave4/generated/review_queue.json", {
  schema_version: "1.0.0",
  snapshot_date: fixtures.snapshot_date,
  source_snapshot_hash: sha256(fixtures),
  coverage: {
    scope: "Wave 4 review-order fixtures",
    full_corpus: false,
    notice: fixtures.fixture_notice
  },
  methodology: {
    label: "Review priority",
    weights: REVIEW_WEIGHTS,
    exclusions: ["identity", "occupation", "protected_class", "union_membership", "visitor_location", "browser_history"],
    blind_spots: [
      "Source coverage is printed beside every queue snapshot.",
      "Amount percentiles use that declared source coverage.",
      "Review leads organize human attention; they are not findings."
    ],
    human_review_required: true
  },
  queue: buildReviewQueue(fixtures.records)
}, check);
