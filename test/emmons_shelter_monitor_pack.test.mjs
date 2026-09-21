import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildEmmonsShelterMonitorPack, createEmmonsWatchChildren, EMMONS_ANCHORS, EMMONS_ROUTES, renderEmmonsShelterMonitorPack } from "../site/emmons_shelter_monitor_pack.mjs";

const captureManifest = JSON.parse(readFileSync(new URL("../docs/evidence/emmons-shelter-monitor-pack/capture-manifest.json", import.meta.url)));
const captureDigest = (html) => createHash("sha256").update(html).digest("hex");
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const observationDigest = (observation) => captureDigest(JSON.stringify(canonicalize(observation)));

test("the Emmons pack retains exact anchors and excludes the nearby address", () => {
  const pack = buildEmmonsShelterMonitorPack();
  assert.equal(pack.subject_ref, "monitor-pack:emmons-shelter");
  assert.deepEqual(pack.anchors, EMMONS_ANCHORS);
  assert.ok(pack.events.every((event) => event.source_observation_ref && event.canonical_href));
  assert.ok(pack.watches.every((watch) => JSON.stringify(watch).includes("CT107120258801626") || JSON.stringify(watch).includes("3218 Emmons")));
  assert.doesNotMatch(JSON.stringify(pack), /3206 Emmons|separate procurement/i);
});

test("the resident document links canonical objects and states bounded coverage", () => {
  const html = renderEmmonsShelterMonitorPack();
  for (const route of Object.values(EMMONS_ROUTES)) assert.match(html, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Court activity is not presently acquired by CityScroll/);
  assert.match(html, /Community Board opposition is not asserted/);
  assert.match(html, /Source observation/);
  assert.match(html, /data-emmons-create-watches/);
  assert.doesNotMatch(html, /no case exists/i);
});

test("one reviewed action creates each child exactly once through an idempotent store", async () => {
  const calls = [];
  const result = await createEmmonsWatchChildren(buildEmmonsShelterMonitorPack(), async (child) => {
    calls.push(child.child_id);
    return { created: !calls.slice(0, -1).includes(child.child_id) };
  });
  assert.equal(result.child_count, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.created, ["exact-procurement", "project-alias-money", "cb15-meeting-alias"]);
});

test("the retained journey manifest binds static and served observations without hashing untaken surfaces", () => {
  const expected = new Map([
    ["desktop", (html) => ["What CityScroll knows", "Timeline", "What to watch", "Not yet covered"].every((text) => html.includes(text))],
    ["narrow-touch", null],
    ["keyboard", null],
    ["no-javascript", (html) => html.includes("<!doctype html>") && !html.includes("<script")],
    ["back-navigation", null],
    ["failed-detail-load", null],
  ]);
  assert.equal(captureManifest.capture_tool, "python3 tools/capture_emmons_shelter_monitor_pack.py");
  assert.equal(captureManifest.runner, "node --test test/emmons_shelter_monitor_pack.test.mjs test/tracked_issue_read_model.test.mjs");
  assert.deepEqual(captureManifest.captures.map((capture) => capture.surface), [...expected.keys()]);
  const html = renderEmmonsShelterMonitorPack();
  for (const capture of captureManifest.captures) {
    const assertion = expected.get(capture.surface);
    if (capture.state === "not-yet-taken") {
      assert.equal(assertion, null, capture.surface);
      assert.match(capture.reason, /requires|cannot evidence/i, capture.surface);
      assert.equal("sha256" in capture, false, capture.surface);
      continue;
    }
    assert.equal(capture.state, "complete", capture.surface);
    if (!assertion) {
      assert.match(capture.method, /headless-playwright-loopback-served/, capture.surface);
      assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.surface);
      assert.equal(capture.observations.assertion, capture.assertion, capture.surface);
      assert.equal(capture.observations.observation_digest_basis, "sorted JSON of this textual browser observation", capture.surface);
      assert.equal(capture.sha256, observationDigest(capture.observations), capture.surface);
      continue;
    }
    assert.match(capture.method, /deterministic-render-fixture/, capture.surface);
    assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.surface);
    assert.equal(capture.sha256, captureDigest(html), capture.surface);
    assert.equal(assertion(html), true, capture.surface);
  }
});
