import { buildReviewQueue, REVIEW_WEIGHTS } from "../worker/src/lib/review_queue.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const fixtures = readJson("data/wave4/review-fixtures.json");
writeOrCheck("data/review_queue.json", {
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
      "Published records may omit outreach, internal approvals, or delivery facts.",
      "Amount percentiles are meaningful only within the stated source coverage.",
      "A high or low score is not an editorial conclusion."
    ],
    human_review_required: true
  },
  queue: buildReviewQueue(fixtures.records)
}, check);
