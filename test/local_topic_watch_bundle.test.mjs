import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLocalTopicWatchBundle,
  buildLocalTopicWatchBundle,
  canonicalLocalTopicWatchId,
  deliverLocalTopicWatch,
  localTopicWatchStoredPayload,
  previewLocalTopicWatch,
  rehearseLocalTopicWatch,
  renderLocalTopicWatchConfirmation,
  renderLocalTopicWatchDigest,
} from "../site/local_topic_watch_bundle.mjs";

function renderedElementByChildId(html, tag, childId) {
  const marker = `data-watch-child-id="${childId}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return "";
  const start = html.lastIndexOf(`<${tag}`, markerIndex);
  const end = html.indexOf(`</${tag}>`, markerIndex);
  return start >= 0 && end >= 0 ? html.slice(start, end + tag.length + 3) : "";
}

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
  for (const child of bundle.children) {
    const row = renderedElementByChildId(html, "li", child.id);
    assert.ok(row.includes(` · ${child.frequency} ·`), `${child.id} confirmation row renders its frequency`);
  }
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

test("one local topic digest preserves every labelled source-family section", () => {
  const bundle = buildLocalTopicWatchBundle({ district: "K15", topic: "Shelter safety" });
  const snapshot = {
    snapshot_id: "k15-topic-fixture",
    children: Object.fromEntries(bundle.children.map((child, index) => [child.id, [{ id: `item-${index}` }]])),
  };
  const html = renderLocalTopicWatchDigest(bundle, snapshot);
  for (const child of bundle.children) {
    const section = renderedElementByChildId(html, "section", child.id);
    assert.ok(
      section.includes(`data-source-family="${child.source_family}"`)
        && section.includes(`<h3>${child.label}</h3>`),
      `${child.id} digest section preserves ${child.label}`,
    );
  }
});

test("K15 preview, stored payload, rehearsal, and delivery share canonical IDs from one snapshot", () => {
  const bundle = buildLocalTopicWatchBundle({ district: "K15", topic: "Shelter safety" });
  const snapshot = {
    snapshot_id: "k15-topic-fixture",
    children: Object.fromEntries(bundle.children.map((child, index) => [child.id, [{ index }]])),
  };
  const preview = previewLocalTopicWatch(bundle, snapshot);
  const stored = localTopicWatchStoredPayload(bundle, { email: "reader@example.com", snapshot_id: snapshot.snapshot_id });
  const rehearsal = rehearseLocalTopicWatch(bundle, snapshot);
  const delivery = deliverLocalTopicWatch(bundle, snapshot);
  const ids = [
    preview.sections.map(({ watch_id }) => watch_id),
    stored.children.map(({ id }) => id),
    rehearsal.sections.map(({ watch_id }) => watch_id),
    delivery.sections.map(({ watch_id }) => watch_id),
  ];
  assert.ok(ids.every((stage) => stage.length === bundle.children.length));
  assert.deepEqual(ids, [ids[0], ids[0], ids[0], ids[0]]);
  assert.equal(preview.snapshot_id, snapshot.snapshot_id);
  assert.equal(stored.snapshot_id, snapshot.snapshot_id);
  assert.equal(rehearsal.snapshot_id, snapshot.snapshot_id);
  assert.equal(delivery.snapshot_id, snapshot.snapshot_id);
});
