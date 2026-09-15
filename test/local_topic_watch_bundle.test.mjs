import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLocalTopicWatchBundle,
  buildLocalTopicWatchBundle,
  canonicalLocalTopicWatchId,
  renderLocalTopicWatchConfirmation,
} from "../site/local_topic_watch_bundle.mjs";

test("confirmation exposes exact children, place, literal query, cadence, and preview counts", () => {
  const bundle = buildLocalTopicWatchBundle({
    district: "K15",
    topic: "Shelter safety",
    board: { id: "community-board:brooklyn-cb-15" },
    preview_counts: { community_board_meeting: 3, shared_procurement_read_model: 1 },
  });
  assert.equal(bundle.status, "confirmed");
  assert.deepEqual(bundle.children.map((child) => child.lens), ["meetings", "money"]);
  assert.ok(bundle.children.every((child) => child.filter.geographies[0] === "geography:community_district:K15"));
  assert.equal(bundle.children[0].filter.communityBoard, "community-board:brooklyn-cb-15");
  assert.ok(bundle.children.every((child) => child.filter.text_query.all[0][0].value === "shelter safety"));
  assert.deepEqual(bundle.children.map((child) => child.preview_count), [3, 1]);
  const html = renderLocalTopicWatchConfirmation(bundle);
  assert.match(html, /Community Board meetings/);
  assert.match(html, /3 preview matches/);
  assert.match(html, /“Shelter safety”/);
  assert.match(html, /· weekly ·[\s\S]*· weekly ·/, "confirmation renders frequency for every child");
});

test("unsupported source families are omitted and never widened into watches", () => {
  const bundle = buildLocalTopicWatchBundle({ district: "K15", topic: "housing", source_families: [
    "community_board_meeting", "community_board_project", "document_excerpt",
  ] });
  assert.equal(bundle.children.length, 1);
  assert.deepEqual(bundle.omissions.map((item) => item.source_family), ["community_board_project", "document_excerpt"]);
  assert.match(renderLocalTopicWatchConfirmation(bundle), /Not included/);
  assert.doesNotMatch(JSON.stringify(bundle), /monitor.pack|procurement_lookup|vendor-wide|project relationship/i);
});

test("invalid expressions and changed district scope fail closed", () => {
  assert.equal(buildLocalTopicWatchBundle({ district: "K15", topic: "---" }).status, "invalid_topic");
  assert.equal(buildLocalTopicWatchBundle({ district: "K15", topic: "housing" }, { district: "K03" }).status, "scope_changed");
  assert.equal(buildLocalTopicWatchBundle({ district: "not-a-district", topic: "housing" }).status, "invalid_scope");
});

test("one action is idempotent and partial retry only attempts missing children", async () => {
  const bundle = buildLocalTopicWatchBundle({ district: "K15", topic: "housing" });
  const calls = [];
  let failMoney = true;
  const create = async (child) => {
    calls.push(child.id);
    if (child.lens === "money" && failMoney) throw new Error("temporary failure");
  };
  const first = await applyLocalTopicWatchBundle(bundle, create);
  assert.equal(first.status, "partial");
  assert.equal(first.created.length, 1);
  assert.equal(first.remaining.length, 1);
  failMoney = false;
  const second = await applyLocalTopicWatchBundle(bundle, create, first.created);
  assert.equal(second.status, "created");
  assert.deepEqual(second.created, [first.remaining[0].id]);
  assert.equal(calls.length, 3);
  assert.equal(canonicalLocalTopicWatchId(bundle.children[0]), bundle.children[0].id);
});
