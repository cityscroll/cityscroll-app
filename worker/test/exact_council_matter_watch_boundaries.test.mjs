import assert from "node:assert/strict";
import test from "node:test";

import { exactCouncilMatterWatch, parseCouncilMatterRef } from "../../site/council_matter_watch_scope.mjs";
import { prepareWatchFilter, sanitize } from "../src/lib/filter.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { compileSub_d1 } from "../src/lib/compile_d1.mjs";
import {
  confirmExactMatterWatch,
  removeExactMatterWatch,
} from "../src/lib/council_matter_watch_activation.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";

test("round-trip serialize/load does not invent a notice or committee scope", () => {
  const watch = exactCouncilMatterWatch({ lens: "meetings", filter: { matter_ref: "legistar:nyc:matter:78605" } });
  assert.deepEqual(Object.keys(watch.filter).sort(), ["matter_ref", "matter_scope_version"]);
  const again = exactCouncilMatterWatch({ lens: watch.lens, filter: watch.filter });
  assert.deepEqual(again.filter, watch.filter);
  assert.equal(parseCouncilMatterRef(watch.matter_ref).tenant, "nyc");
});

test("fail-closed paths never compile as all meetings", () => {
  const cases = [
    { matter_id: "" },
    { matter_ref: "legistar:albany:matter:79200" },
    { matter_ref: "legistar:nyc:matter:79200", communityBoard: "community-board:brooklyn-cb-02" },
    { matter_ref: "legistar:nyc:matter:79200", request_ids: ["20260707021"] },
    { matter_ref: "legistar:nyc:matter:79200", agency: "City Council" },
  ];
  for (const filter of cases) {
    const prepared = prepareWatchFilter("meetings", filter);
    assert.equal(prepared.ok, false, JSON.stringify(filter));
    assert.equal(compileSub({ lens: "meetings", filter: sanitize("meetings", filter) }, "2026-08-10"), null);
  }
});

test("owner isolation and removal leave the other owner's baseline in place", async () => {
  const { sqlite, DB } = matterJournalDatabase({ baselines: true });
  const env = { DB };
  const left = {
    lens: "meetings",
    filter: { matter_ref: "legistar:nyc:matter:79200", matter_scope_version: 1 },
    subscriber_id: "subscriber:left",
    watch_id: "watch:left",
  };
  const right = { ...left, subscriber_id: "subscriber:right", watch_id: "watch:right" };
  await confirmExactMatterWatch(env, left, { now: "2026-08-01T00:00:00.000Z", observations: [] });
  await confirmExactMatterWatch(env, right, { now: "2026-08-01T00:00:00.000Z", observations: [] });
  await removeExactMatterWatch(env, left, { now: "2026-08-02T00:00:00.000Z" });
  const rows = sqlite.prepare("SELECT subscriber_id, status FROM matter_watch_baseline ORDER BY subscriber_id").all()
    .map((row) => ({ subscriber_id: row.subscriber_id, status: row.status }));
  assert.deepEqual(rows, [
    { subscriber_id: "subscriber:left", status: "removed" },
    { subscriber_id: "subscriber:right", status: "active" },
  ]);
});

test("D1 compiler never exposes a fabricated matter query option", () => {
  const d1 = compileSub_d1({
    lens: "meetings",
    filter: { matter_ref: "legistar:nyc:matter:79200", matter_scope_version: 1 },
  }, "2026-08-10");
  assert.equal(d1.opts, null);
  assert.equal("matter" in (d1.opts || {}), false);
});
