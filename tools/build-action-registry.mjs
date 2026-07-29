import { compileActionRail, OUTCOME_ENUM } from "../worker/src/lib/action_registry.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const fixture = readJson("test/fixtures/wave4/action-fixtures.json");
writeOrCheck("test/fixtures/wave4/generated/action_registry.json", {
  schema_version: "1.0.0",
  snapshot_date: fixture.snapshot_date,
  source_snapshot_hash: sha256(fixture),
  coverage: {scope: "Wave 4 reference matter", full_corpus: false},
  handoff_contract: {
    consequential_actions_submit_in_product: false,
    destination_visible_before_leaving: true,
    third_party_credentials_accepted: false,
    return_state: "matter permalink"
  },
  matter: fixture.matter,
  actions: compileActionRail(fixture.matter, {vaultEnabled: false}),
  outcomes: OUTCOME_ENUM
}, check);
