import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalDistrictFollowBundle,
  localDistrictFollowDisclosure,
  localDistrictFollowPayload,
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
  const bundle = buildLocalDistrictFollowBundle({ scope, board: "community-board:brooklyn-cb-15" });
  const disclosure = localDistrictFollowDisclosure(bundle);
  assert.ok(disclosure.omitted.includes("people"));
  assert.ok(bundle.children.every((child) => !["entity", "award", "legal_code"].includes(child.lens)));
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
  for (const child of payload.children) {
    assert.deepEqual(child.filter.geographies, ["geography:community_district:K15"]);
    assert.equal(child.filter.when, "week");
    assert.equal(child.filter.place_role, "matter");
  }
});

test("bundle payload is stable across repeated construction", () => {
  const first = localDistrictFollowPayload({ scope, board: "community-board:brooklyn-cb-15" });
  const second = localDistrictFollowPayload({ scope, board: "community-board:brooklyn-cb-15" });
  assert.deepEqual(first.children, second.children);
});
