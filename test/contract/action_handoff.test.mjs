import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/wave4/action-fixtures.json", import.meta.url)));
const registry = JSON.parse(readFileSync(new URL("../fixtures/wave4/generated/action_registry.json", import.meta.url)));

function findAction(type) {
  const action = registry.actions.find((item) => item.type === type);
  assert.ok(action, `action ${type} should exist in action rail`);
  return action;
}

test("comments, testimony, application, bid, and subscription actions declare delivery tiers", () => {
  assert.equal(findAction("comment").delivery, "official_handoff");
  assert.equal(findAction("rsvp").delivery, "official_handoff");
  assert.equal(findAction("official_application").delivery, "official_handoff");
  assert.equal(findAction("watch").delivery, "local");
});

test("account-gated official actions stay official handoffs with visible destination and confirmation", () => {
  for (const action of [findAction("comment"), findAction("rsvp"), findAction("official_application")]) {
    assert.equal(action.delivery, "official_handoff");
    assert.match(action.destination, /^https:\/\//);
    assert.equal(typeof action.destination_label, "string");
    assert.ok(action.destination_label.length > 0);
    assert.equal(action.confirmation_required, true);
  }
});

test("source links and deadlines are explicit for consequential official handoffs", () => {
  for (const type of ["comment", "rsvp", "official_application"]) {
    const action = findAction(type);
    assert.equal(action.delivery, "official_handoff");
    assert.equal(action.destination, fixture.matter[type === "official_application" ? "official_application_url" : "official_notice_url"]);
    assert.equal(action.deadline, fixture.matter.deadline);
  }
});

test("subscription handoff keeps double opt-in contract metadata", () => {
  const watch = findAction("watch");
  assert.equal(watch.delivery, "local");
  assert.equal(watch.confirmation_required, true);
  assert.equal(watch.destination, "index.html#alerts");
});

test("unavailable actions carry no hidden official destination", () => {
  for (const action of registry.actions) {
    if (action.delivery === "unavailable") {
      assert.equal(action.destination, undefined);
      assert.equal(action.confirmation_required, false);
      assert.equal(typeof action.destination_label, "undefined");
    }
  }
});
