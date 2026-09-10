// Owed rows join a digest section by the recorded outbox watch_id first, then by
// the unique current lens when that watch identity is no longer on the subscriber.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attachOwedRows,
  OWED_ATTACH_REASONS,
} from "../src/lib/owed_attach.mjs";

const PRIOR_WATCH_ID = "watch:prior-district-key";
const CURRENT_WATCH_ID = "watch:current-district-key";
const OLDEST_ITEM_ID = "district:land:2019M0059:2023-03-13";

function owedItem({ watchId = PRIOR_WATCH_ID, itemId = OLDEST_ITEM_ID, lens = "district", payload = null } = {}) {
  return {
    watch_id: watchId,
    subscriber_id: "subscriber:test",
    item_id: itemId,
    lens,
    payload_json: JSON.stringify(payload || {
      district_item_id: "land:2019M0059:2023-03-13",
      district_section: "land",
      project_id: "2019M0059",
      project_name: "Held district land action",
    }),
  };
}

function districtSection(watchId = CURRENT_WATCH_ID) {
  return {
    sub: "sub:district",
    subKey: "sub:district",
    lens: "district",
    status: "success",
    watchId,
    kind: "district",
    freshRows: [],
    new: 0,
    noticeIds: [],
    action: "none",
  };
}

test("attachment fails against the previous watch_id key and passes against the recorded lens", () => {
  const owed = [owedItem()];
  const previousKey = districtSection(CURRENT_WATCH_ID);
  const missed = (previousKey.watchId === owed[0].watch_id)
    ? 1
    : 0;
  assert.equal(missed, 0, "the previous key is the current section watch_id, which does not match the recorded outbox watch_id");

  const previous = attachOwedRows([previousKey], owed);
  assert.equal(previous.attached_by.watch_id, 0, "watch_id-only attach would drain nothing");
  assert.equal(previous.attached_by.lens, 1);
  assert.equal(previousKey.new, 1);
  assert.equal(previousKey.action, "match");
  assert.match(previousKey.freshRows[0].project_name, /Held district land action/);

  const exact = districtSection(PRIOR_WATCH_ID);
  const byWatch = attachOwedRows([exact], owed);
  assert.equal(byWatch.attached_by.watch_id, 1);
  assert.equal(byWatch.attached_by.lens, 0);
});

test("an owed row whose lens the reader no longer watches stays owed and names the reason", () => {
  const section = districtSection();
  const receipt = attachOwedRows([section], [owedItem({ lens: "money", itemId: "notice:STRAY" })]);
  assert.equal(receipt.attached_count, 0);
  assert.equal(section.new, 0);
  assert.equal(receipt.unattached[0].reason, OWED_ATTACH_REASONS.NO_CURRENT_LENS_WATCH);
  assert.equal(receipt.unattached[0].item_id, "notice:STRAY");
});

test("a skipped weekly section does not receive owed rows and names section_not_ready", () => {
  const skipped = {
    ...districtSection(PRIOR_WATCH_ID),
    status: "skipped",
    skipped: "weekly",
  };
  const receipt = attachOwedRows([skipped], [owedItem({ watchId: PRIOR_WATCH_ID })]);
  assert.equal(receipt.attached_count, 0);
  assert.equal(receipt.unattached[0].reason, OWED_ATTACH_REASONS.SECTION_NOT_READY);
});

test("a failed sibling of the same lens does not inherit the other watch's owed rows", () => {
  const ready = districtSection("watch:district-ready");
  const failed = {
    ...districtSection("watch:district-failed"),
    sub: "sub:district-failed",
    subKey: "sub:district-failed",
    status: "failed",
    error: "upstream",
  };
  const receipt = attachOwedRows([ready, failed], [owedItem({ watchId: "watch:district-failed" })]);
  assert.equal(receipt.attached_count, 0);
  assert.equal(ready.new, 0);
  assert.equal(receipt.unattached[0].reason, OWED_ATTACH_REASONS.SECTION_NOT_READY);
});

test("two current watches of the same lens do not guess; the row stays owed", () => {
  const first = districtSection("watch:district-a");
  const second = { ...districtSection("watch:district-b"), sub: "sub:district-b", subKey: "sub:district-b" };
  const receipt = attachOwedRows([first, second], [owedItem()]);
  assert.equal(receipt.attached_count, 0);
  assert.equal(receipt.unattached[0].reason, OWED_ATTACH_REASONS.LENS_AMBIGUOUS);
});

test("lens fallback carries a row whose recorded filter equals the current watch filter", () => {
  const section = { ...districtSection(), filter: { councilDistrict: "3" } };
  const owed = [owedItem({
    payload: {
      district_item_id: "land:2019M0059:2023-03-13",
      district_section: "land",
      project_id: "2019M0059",
      project_name: "Held district land action",
      watch_filter: { councilDistrict: "3" },
    },
  })];
  const receipt = attachOwedRows([section], owed);
  assert.equal(receipt.attached_by.lens, 1);
  assert.equal(receipt.unattached_count, 0);
  assert.equal(section.new, 1);
});

test("lens fallback keeps a row owed with filter_mismatch when the current watch filter changed", () => {
  const section = { ...districtSection(), filter: { councilDistrict: "12" } };
  const owed = [owedItem({
    payload: {
      district_item_id: "land:2019M0059:2023-03-13",
      district_section: "land",
      project_id: "2019M0059",
      project_name: "Held district land action",
      council_district: "3",
      watch_filter: { councilDistrict: "3" },
    },
  })];
  const receipt = attachOwedRows([section], owed);
  assert.equal(receipt.attached_count, 0);
  assert.equal(section.new, 0);
  assert.equal(receipt.unattached[0].reason, OWED_ATTACH_REASONS.FILTER_MISMATCH);
});
