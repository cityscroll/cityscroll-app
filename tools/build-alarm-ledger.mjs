import { evaluateAlarmFixtures } from "../worker/src/lib/procurement_alarms.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const fixtures = readJson("data/wave4/alarm-fixtures.json");
const evaluations = evaluateAlarmFixtures(fixtures.cases);
writeOrCheck("data/alarm_ledger.json", {
  schema_version: "1.0.0",
  snapshot_date: fixtures.snapshot_date,
  source_snapshot_hash: sha256(fixtures),
  coverage: {
    scope: "Five-family methodology fixtures",
    full_corpus: false,
    notice: fixtures.fixture_notice
  },
  methodology: {
    output_term: "review lead",
    human_review_required: true,
    automated_verdict: false,
    rule_families: ["date_order", "expired_before_process", "future_competition", "contestability_package", "broken_succession"]
  },
  evaluations
}, check);
