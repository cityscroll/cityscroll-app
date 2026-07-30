import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";
import { outcomeEvent } from "../worker/src/lib/action_registry.mjs";

const registry = readJson("test/fixtures/wave4/generated/action_registry.json");
const forbidden = ["person", "email", "query", "notice_id", "process_id", "outbound_url", "destination"];
for (const outcome of registry.outcomes) {
  const event = outcomeEvent(outcome);
  assert.deepEqual(Object.keys(event).sort(), ["detail", "event", "surface"]);
  assert.ok(forbidden.every((field) => !Object.hasOwn(event, field)));
}
for (const action of registry.actions.filter((item) => item.delivery === "official_handoff")) {
  assert.match(action.destination, /^https:\/\//);
  assert.ok(action.destination_label);
}
assert.equal(registry.handoff_contract.consequential_actions_submit_in_product, false);
console.log(`audited ${registry.outcomes.length} aggregate outcome events`);
