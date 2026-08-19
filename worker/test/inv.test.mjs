import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleInv } from "../src/inv.mjs";
import { validInvPayload, INV_TTL, MAX_INV_BYTES } from "../src/lib/inv.mjs";
import { normalizeUsageEvent } from "../src/lib/analytics.mjs";
import { storySignalInvestigationItem } from "../../site/investigation_comparative_signal.mjs";
import { researchPackageRequestFromInvestigation } from "../../site/research_package.mjs";

const storySignals = JSON.parse(readFileSync(
  new URL("../../site/data/comparative_story_signals.json", import.meta.url),
  "utf8",
));

function signalItem() {
  return storySignalInvestigationItem(structuredClone(storySignals.signals[0]), {
    peerSetHref: "/experimental/worth-a-look/#peer-20240119104",
  });
}

function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value, options) { values.set(key, value); this.lastOptions = options; },
  };
}

function packageRequest(options = {}) {
  return researchPackageRequestFromInvestigation({
    name: "Award rank",
    created: "2026-08-19",
    items: [signalItem()],
  }, {
    question: "Which observed award stands out?",
    ...options,
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

test("/inv mints immutable package v1 and v2 records without changing legacy storage", async () => {
  const SUBS = memoryKv();
  const post = async (body) => {
    const response = await handleInv(new Request("https://api.cityscroll.org/inv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), { SUBS }, "/inv");
    return { response, json: await response.json() };
  };

  const first = await post(packageRequest());
  assert.equal(first.response.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.kind, "research_package");
  assert.equal(first.json.version, 1);
  assert.equal(first.json.ttlDays, 90);
  assert.equal(SUBS.lastOptions.expirationTtl, INV_TTL);

  const firstStored = SUBS.values.get(`inv:${first.json.id}`);
  const v1 = JSON.parse(firstStored);
  assert.equal(v1.version_id, first.json.id);
  assert.equal(v1.package_id, first.json.packageId);

  const second = await post(packageRequest({
    supersedes: { version_id: first.json.id },
    changes: [{ kind: "data_refreshed", summary: "Refreshed the source snapshot." }],
  }));
  assert.equal(second.response.status, 200);
  assert.equal(second.json.version, 2);
  const v2 = JSON.parse(SUBS.values.get(`inv:${second.json.id}`));
  assert.equal(v2.package_id, v1.package_id);
  assert.deepEqual(v2.supersedes, { version_id: v1.version_id, version: 1 });
  assert.deepEqual(v2.changes, [{ kind: "data_refreshed", summary: "Refreshed the source snapshot." }]);
  assert.equal(SUBS.values.get(`inv:${first.json.id}`), firstStored, "v1 bytes remain unchanged");

  const getV1 = await handleInv(new Request(`https://api.cityscroll.org/inv/${first.json.id}`), { SUBS }, `/inv/${first.json.id}`);
  assert.equal(await getV1.text(), firstStored, "frozen retrieval returns the original bytes");
});

test("/inv rejects unexplained or missing supersession while preserving legacy snapshot behavior", async () => {
  const SUBS = memoryKv();
  const legacy = validInvPayload({ name: "legacy", items: [{ t: "notice", id: "1", title: "one" }] });
  const legacyPost = await handleInv(new Request("https://api.cityscroll.org/inv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "legacy", items: [{ t: "notice", id: "1", title: "one" }] }),
  }), { SUBS }, "/inv");
  const legacyResult = await legacyPost.json();
  assert.equal(legacyResult.ok, true);
  assert.deepEqual(JSON.parse(SUBS.values.get(`inv:${legacyResult.id}`)), legacy);

  const missing = packageRequest({
    supersedes: { version_id: "does-not-exist" },
    changes: [{ kind: "data_refreshed", summary: "Refreshed data." }],
  });
  const response = await handleInv(new Request("https://api.cityscroll.org/inv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(missing),
  }), { SUBS }, "/inv");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "missing-superseded-version");
});
