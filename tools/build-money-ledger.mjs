import { buildMoneyLedger } from "../worker/src/lib/money_events.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const source = readJson("data/wave4/money-events.json");
const ledger = {
  schema_version: "1.0.0",
  snapshot_date: source.snapshot_date,
  source_snapshot_hash: sha256(source),
  coverage: {
    scope: "Wave 4 reference fixtures",
    full_corpus: false,
    notice: source.fixture_notice
  },
  definitions: {
    IDA: "Industrial Development Agency — a public authority or public-benefit-corporation class.",
    LDC: "Local Development Corporation — a government-affiliated not-for-profit local-authority class."
  },
  source_policies: {
    paris_abo: {
      reporting_threshold_usd: 5000,
      quality: "self_reported_unverified",
      blank_amount_semantics: "unknown_not_zero"
    }
  },
  processes: buildMoneyLedger(source.events, source.snapshot_date),
  late_contracts: source.late_contracts
};
writeOrCheck("data/money_ledger.json", ledger, check);
