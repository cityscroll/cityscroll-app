import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validInvPayload, MAX_INV_BYTES } from "../src/lib/inv.mjs";
import { normalizeUsageEvent } from "../src/lib/analytics.mjs";
import { storySignalInvestigationItem } from "../../site/investigation_comparative_signal.mjs";

const storySignals = JSON.parse(readFileSync(
  new URL("../../site/data/comparative_story_signals.json", import.meta.url),
  "utf8",
));

function signalItem() {
  return storySignalInvestigationItem(structuredClone(storySignals.signals[0]), {
    peerSetHref: "/experimental/worth-a-look/#peer-20240119104",
  });
}

test("validInvPayload: clamps fields, keeps shape", () => {
  const v = validInvPayload({ name: "scaffold contracts", items: [
    { t: "notice", id: "20260625017", title: "Award — prevention services", meta: "ACS · $10.8M", note: "check subs", added: "2026-07-02" },
  ]});
  assert.equal(v.name, "scaffold contracts");
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].id, "20260625017");
  assert.ok(v.sharedAt);
});

test("validInvPayload: rejects empty, oversized, and junk", () => {
  assert.equal(validInvPayload(null), null);
  assert.equal(validInvPayload({ name: "x", items: [] }), null);
  const big = { name: "x", items: Array.from({length: 150}, (_, i) => ({ t: "notice", id: String(i), title: "t".repeat(300), note: "n".repeat(1000) })) };
  assert.equal(validInvPayload(big), null, "over the byte cap");
  const many = { name: "x", items: Array.from({length: 500}, () => ({ t: "notice", id: "1", title: "t" })) };
  assert.equal(validInvPayload(many), null);
});

test("validInvPayload: preserves a comparative claim, receipt, and evidence through a shared snapshot", () => {
  const item = signalItem();
  item.note = "follow the source record";
  const snapshot = validInvPayload({ name: "award rank", items: [item] });

  assert.ok(snapshot);
  assert.equal(snapshot.items[0].claim, item.claim);
  assert.deepEqual(snapshot.items[0].subject, item.subject);
  assert.deepEqual(snapshot.items[0].comparison, item.comparison);
  assert.deepEqual(snapshot.items[0].comparison_receipt, item.comparison_receipt);
  assert.deepEqual(snapshot.items[0].evidence, item.evidence);
  assert.equal(snapshot.items[0].note, "follow the source record");
  assert.ok(JSON.stringify(snapshot).length < MAX_INV_BYTES);
});

test("validInvPayload: rejects signal-shaped items without the admitted provenance contract", () => {
  const item = signalItem();
  delete item.comparison_receipt;
  assert.equal(validInvPayload({ name: "held", items: [item] }), null);

  const held = signalItem();
  held.state = "held_mnar";
  assert.equal(validInvPayload({ name: "held", items: [held] }), null);
});

test("explicit signal adds reuse the aggregate non-identifying investigation_share event", () => {
  const event = normalizeUsageEvent({
    event: "investigation_share",
    detail: "add_signal",
    surface: "home",
  });
  assert.equal(event.event, "investigation_share");
  assert.equal(event.detail, "add_signal");
  assert.equal(event.lens, "none");
});
