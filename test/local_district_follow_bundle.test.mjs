import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLocalDistrictFollowBundle,
  buildLocalDistrictFollowBundle,
  deliverLocalDistrictFollow,
  localDistrictFollowDisclosure,
  localDistrictFollowPayload,
  previewLocalDistrictFollow,
} from "../site/local_district_follow_bundle.mjs";

const scope = {
  place: { boroughs: ["Brooklyn"], community_districts: ["K15"] },
  time_window: { preset: "week" },
  facets: { values: { place_role: "matter" } },
};

test("district confirmation enumerates the exact board and supported children", () => {
  const bundle = buildLocalDistrictFollowBundle({ scope, board: "community-board:brooklyn-cb-15" });
  assert.equal(bundle.children.length, 5);
  assert.equal(bundle.children[0].lens, "meetings");
  assert.deepEqual(bundle.children[0].filter, {
    borough: "Brooklyn",
    geographies: ["geography:community_district:K15"],
    communityBoard: "community-board:brooklyn-cb-15",
    when: "week",
    dateWindow: "week",
    communityDistrict: "K15",
    place_role: "matter",
  });
  assert.deepEqual(bundle.children.slice(1).map(({ lens }) => lens), ["land", "property", "rules", "money"]);
});

test("unsupported lenses are disclosed and omitted from the general district bundle", () => {
  const bundle = buildLocalDistrictFollowBundle({
    scope,
    board: "community-board:brooklyn-cb-15",
    supportedLenses: ["land", "property", "rules", "money", "topic", "vendor-wide"],
  });
  const disclosure = localDistrictFollowDisclosure(bundle);
  assert.equal(disclosure.frequency, "one weekly digest");
  assert.deepEqual(disclosure.omitted, [
    "people", "entity", "award", "district", "topic", "legal_code", "mandates", "obligations", "vendor-wide",
  ]);
  assert.deepEqual(bundle.children.map(({ lens }) => lens), ["meetings", "land", "property", "rules", "money"]);
});

test("a district without an exact board fails closed", () => {
  const bundle = buildLocalDistrictFollowBundle({ scope });
  assert.equal(bundle.children.length, 0);
  assert.match(bundle.unavailable, /Community Board/);
});

test("payload preserves geography, board, topic, role, and time constraints", () => {
  const payload = localDistrictFollowPayload({ scope, board: "community-board:brooklyn-cb-15" }, { email: "reader@example.com" });
  assert.equal(payload.pack_id, "local-district-follow");
  assert.equal(payload.children.length, 5);
  for (const [index, child] of payload.children.entries()) {
    assert.deepEqual(child.filter.geographies, ["geography:community_district:K15"]);
    assert.equal(child.filter.when, "week");
    assert.equal(child.filter.dateWindow, "week");
    assert.equal(child.filter.place_role, "matter");
    assert.equal(child.filter.text_query, undefined);
    assert.equal(child.filter.communityBoard, index === 0 ? "community-board:brooklyn-cb-15" : undefined);
  }
});

test("bundle payload is stable across repeated construction", () => {
  const first = localDistrictFollowPayload({ scope, board: "community-board:brooklyn-cb-15" });
  const second = localDistrictFollowPayload({ scope, board: "community-board:brooklyn-cb-15" });
  assert.deepEqual(first.children, second.children);
});

test("one action creates each missing child once and returns labelled digest sections", async () => {
  const bundle = buildLocalDistrictFollowBundle({ scope, board: "community-board:brooklyn-cb-15" });
  const calls = [];
  const created = await applyLocalDistrictFollowBundle(bundle, async (child) => {
    calls.push(structuredClone(child));
  });
  assert.equal(created.status, "created");
  assert.deepEqual(created.created, bundle.children.map((child) => child.id));
  assert.deepEqual(calls, bundle.children);
  assert.deepEqual(created.digest.sections.map(({ label }) => label), [
    "Community Board meetings", "Land and zoning", "Property", "Rules and notices", "City contracts",
  ]);
  const replay = await applyLocalDistrictFollowBundle(bundle, async () => {
    throw new Error("an existing child must not be attempted again");
  }, created.created);
  assert.equal(replay.status, "created");
  assert.deepEqual(replay.created, []);
});

test("partial creation failure retries only the missing child with the exact payload", async () => {
  const bundle = buildLocalDistrictFollowBundle({ scope, board: "community-board:brooklyn-cb-15" });
  const calls = [];
  let failMoney = true;
  const create = async (child) => {
    calls.push(structuredClone(child));
    if (child.lens === "money" && failMoney) throw new Error("temporary failure");
  };
  const first = await applyLocalDistrictFollowBundle(bundle, create);
  assert.equal(first.status, "partial");
  assert.equal(first.created.length, 4);
  assert.deepEqual(first.remaining.map((child) => child.id), [bundle.children[4].id]);
  failMoney = false;
  const second = await applyLocalDistrictFollowBundle(bundle, create, first.created);
  assert.equal(second.status, "created");
  assert.deepEqual(second.created, [bundle.children[4].id]);
  assert.deepEqual(calls, [...bundle.children, bundle.children[4]]);
});

test("K15 preview and delivery share canonical IDs from one materialized snapshot", () => {
  const bundle = buildLocalDistrictFollowBundle({ scope, board: "community-board:brooklyn-cb-15" });
  const snapshot = { snapshot_id: "k15-fixture", children: Object.fromEntries(bundle.children.map((child, index) => [child.id, [{ index }]])) };
  const preview = previewLocalDistrictFollow(bundle, snapshot);
  const delivery = deliverLocalDistrictFollow(bundle, snapshot);
  assert.deepEqual(preview.sections.map(({ watch_id }) => watch_id), delivery.sections.map(({ watch_id }) => watch_id));
  assert.deepEqual(preview.sections.map(({ items }) => items), delivery.sections.map(({ items }) => items));
  assert.equal(preview.snapshot_id, delivery.snapshot_id);
});
