import assert from "node:assert/strict";
import test from "node:test";
import { buildEmmonsShelterMonitorPack, createEmmonsWatchChildren, EMMONS_ANCHORS, EMMONS_ROUTES, renderEmmonsShelterMonitorPack } from "../site/emmons_shelter_monitor_pack.mjs";

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
