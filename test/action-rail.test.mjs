import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileActionRail, validateAction } from "../worker/src/lib/action_registry.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wave4/action-fixtures.json", import.meta.url)));
const registry = JSON.parse(readFileSync(new URL("./fixtures/wave4/generated/action_registry.json", import.meta.url)));

test("action rail compiles every typed action in the card contract", () => {
  assert.deepEqual(compileActionRail(fixture.matter, {vaultEnabled: false}), registry.actions);
  assert.deepEqual(registry.actions.map((action) => action.type), [
    "watch", "calendar", "document", "contact", "rsvp", "comment", "attend",
    "bid_checklist", "official_application", "return_to_matter", "local_note"
  ]);
});

test("consequential actions expose their official destination before leaving", () => {
  for (const action of registry.actions.filter((item) => item.delivery === "official_handoff")) {
    validateAction(action);
    assert.match(action.destination, /^https:\/\//);
    assert.ok(action.destination_label);
  }
  assert.equal(registry.handoff_contract.consequential_actions_submit_in_product, false);
});

test("no-R2 document action falls back to the official link", () => {
  const document = registry.actions.find((action) => action.type === "document");
  assert.equal(document.vault_fallback, true);
  assert.equal(document.destination, fixture.matter.document.official_url);
});

test("return state restores the matter permalink", () => {
  const action = registry.actions.find((item) => item.type === "return_to_matter");
  assert.equal(action.destination, fixture.matter.matter_href);
});
