import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  councilMatterChoiceMarkup,
  councilMatterDigestRows,
  councilMatterFollowHref,
  councilMatterFollowMarkup,
  councilMatterWatchSummaryHtml,
  exactCouncilMatterWatch,
  latestObservedAction,
  parseCouncilMatterRef,
} from "../../site/council_matter_watch.mjs";
import {
  buildFollowingViewModel,
  followingUrlFromWatch,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../../site/following_view.mjs";
import { sanitize, prepareWatchFilter } from "../src/lib/filter.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { compileSub_d1, subToD1Opts } from "../src/lib/compile_d1.mjs";
import { describeFilter } from "../src/lib/confirm_email.mjs";
import {
  compileExactCouncilMatter,
  confirmExactMatterWatch,
  d1DispatchExactCouncilMatter,
  eligibleMatterWatchRows,
  removeExactMatterWatch,
  sodaQueryContainsMatterField,
} from "../src/lib/council_matter_watch_activation.mjs";
import { subscriptionKey, buildSubscription, deriveSubscriberId, deriveWatchId } from "../src/lib/subscriptions.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const outboxSql = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const MATTER = "legistar:nyc:matter:79200";
const FIVE = ["79201", "79203", "79202", "79204", "79205"];

const IDENTITY = Object.freeze({
  matter_ref: MATTER,
  source_system: "legistar",
  tenant: "nyc",
  matter_id: "79200",
});

function watchInput() {
  return { lens: "meetings", filter: { matter_ref: MATTER, matter_scope_version: 1 } };
}

test("A1: matter 79200 keeps the same NYC Legistar identity at every boundary", async () => {
  const parsed = parseCouncilMatterRef("79200");
  assert.deepEqual(parsed, IDENTITY);
  const validated = exactCouncilMatterWatch({ lens: "meetings", matter_id: "79200" });
  assert.equal(validated.status, "ok");
  assert.equal(validated.matter_ref, MATTER);
  const prepared = prepareWatchFilter("meetings", { matter_ref: "legistar:nyc:matter:79200" });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.filter, { matter_ref: MATTER, matter_scope_version: 1 });
  const conflicting = sanitize("meetings", { matter_ref: MATTER, keywords: ["all meetings"] });
  assert.equal(conflicting.matter_ref, "invalid");
  assert.equal(compileSub({ lens: "meetings", filter: conflicting }, "2026-08-10"), null);
  const exactSanitized = sanitize("meetings", { matter_ref: MATTER, matter_scope_version: 1 });
  assert.deepEqual(exactSanitized, { matter_ref: MATTER, matter_scope_version: 1 });
  const href = councilMatterFollowHref(validated);
  const loaded = watchFromFollowingParams(new URL(href).searchParams);
  assert.equal(loaded.lens, "meetings");
  assert.equal(loaded.filter.matter_ref, MATTER);
  const sub = buildSubscription({ email: "reader@example.com", lens: loaded.lens, filter: loaded.filter });
  const key = await subscriptionKey(sub);
  assert.match(key, /^sub:/);
  const compiled = compileSub(sub, "2026-08-10");
  assert.equal(compiled.kind, "council-matter");
  assert.equal(compiled.matter_ref, MATTER);
  assert.equal(compiled.nativeReader, "matter-observation-journal");
  const rows = councilMatterDigestRows({ matter_ref: MATTER, confirmed: false });
  assert.ok(rows.every((row) => row.matter_ref === MATTER && row.matter_id === "79200"));
  assert.equal(describeFilter("meetings", exactSanitized), "New York City Council matter 79200 — exact matter");
});

test("A2: five-matter hearing requires an explicit choice and following one excludes the others", () => {
  const hearing = snapshot.by_notice["20260707021"];
  assert.deepEqual((hearing.matters || []).map((row) => String(row.matter_id)), FIVE);
  const html = councilMatterChoiceMarkup(hearing.matters);
  for (const id of FIVE) {
    assert.match(html, new RegExp(`data-matter-id="${id}"`));
    assert.match(html, new RegExp(`matter%3A${id}`));
  }
  assert.doesNotMatch(html, /Follow all five|Follow this hearing/i);
  const choice = html;
  assert.equal(new Set([...choice.matchAll(/data-matter-id="(\d+)"/g)].map((row) => row[1])).size, 5);
  const one = councilMatterDigestRows({ matter_ref: "legistar:nyc:matter:79201" });
  const ids = new Set(one.map((row) => row.matter_id));
  assert.deepEqual([...ids], ["79201"]);
  assert.equal(one.some((row) => FIVE.slice(1).includes(row.matter_id)), false);
});

test("A3: malformed, unknown-tenant, unsupported-version, and conflicting filters fail closed", () => {
  assert.equal(exactCouncilMatterWatch({ lens: "meetings", matter_id: "not-a-number" }).status, "unsupported");
  assert.equal(exactCouncilMatterWatch({ lens: "meetings", filter: { tenant: "chicago", matter_id: "79200" } }).status, "unsupported");
  assert.equal(exactCouncilMatterWatch({ lens: "meetings", filter: { matter_ref: MATTER, matter_scope_version: 2 } }).status, "unsupported");
  assert.equal(exactCouncilMatterWatch({ lens: "meetings", filter: { matter_ref: MATTER, keywords: ["hearings"] } }).status, "unsupported");
  assert.equal(prepareWatchFilter("meetings", { matter_ref: "abc" }).ok, false);
  const compiled = compileSub({ lens: "meetings", filter: { matter_ref: "invalid", matter_scope_version: 0 } }, "2026-08-10");
  assert.equal(compiled, null);
  const ordinary = compileSub({ lens: "meetings", filter: { borough: "Brooklyn" } }, "2026-08-10");
  assert.equal(ordinary?.kind, "meetings");
});

test("A4: neither compiler path sends a matter field to City Record SODA", () => {
  const sub = watchInput();
  const soda = compileSub(sub, "2026-08-10");
  assert.equal(soda.soda, false);
  assert.equal(soda.url, null);
  assert.deepEqual(soda.params, {});
  assert.equal(sodaQueryContainsMatterField(soda), false);
  assert.equal(compileExactCouncilMatter(sub, "2026-08-10").nativeReader, "matter-observation-journal");
  const d1 = compileSub_d1(sub, "2026-08-10");
  assert.equal(d1.nativeReader, "matter-observation-journal");
  assert.equal(d1.soda, false);
  assert.equal(d1.opts, null);
  assert.equal(subToD1Opts(sub, "2026-08-10"), null);
  const unsupported = d1DispatchExactCouncilMatter({ lens: "meetings", filter: { matter_ref: "nope" } });
  assert.equal(unsupported.unsupported, true);
  assert.equal(unsupported.soda, false);
});

test("A5: confirmation baselines preexisting history and only later observations are eligible", async () => {
  const { DB } = matterJournalDatabase({ baselines: true });
  const env = { DB };
  const record = buildSubscription({ email: "owner-a@example.com", lens: "meetings", filter: watchInput().filter });
  record.subscriber_id = await deriveSubscriberId(record.email);
  record.watch_id = await deriveWatchId("sub:owner-a-79200");
  const early = [{
    observation_id: "obs-early",
    matter_id: "79200",
    event_id: "22509",
    acquired_at: "2026-07-22T00:00:00.000Z",
    observed_at: "2026-07-22",
    action_name: "Heard",
    semantic_revision: "early",
  }];
  const first = await confirmExactMatterWatch(env, record, {
    now: "2026-08-01T00:00:00.000Z",
    observations: early,
  });
  assert.equal(first.created, true);
  assert.deepEqual(first.baseline.observation_ids, ["obs-early"]);
  const gated = await eligibleMatterWatchRows(env, record, { observations: early });
  assert.deepEqual(gated, []);
  const later = [...early, {
    observation_id: "obs-later",
    matter_id: "79200",
    event_id: "22510",
    acquired_at: "2026-08-11T00:00:00.000Z",
    observed_at: "2026-08-11",
    action_name: "Laid Over by Subcommittee",
    semantic_revision: "later",
  }];
  const stillGated = await eligibleMatterWatchRows({ ...env, MATTER_WATCH_DELIVERY: "1" }, record, { observations: later });
  assert.equal(stillGated.length, 1);
  assert.equal(stillGated[0].observation_id, "obs-later");
  const replay = await eligibleMatterWatchRows({ ...env, MATTER_WATCH_DELIVERY: "1" }, record, { observations: later });
  assert.equal(replay.length, 1);
});

test("A6: owner isolation, idempotent confirm, meetings/rules compatibility, and feature gate", async () => {
  const { DB } = matterJournalDatabase({ baselines: true });
  const env = { DB };
  const ownerA = buildSubscription({ email: "a@example.com", lens: "meetings", filter: watchInput().filter });
  ownerA.subscriber_id = await deriveSubscriberId(ownerA.email);
  ownerA.watch_id = await deriveWatchId("sub:a");
  const ownerB = buildSubscription({ email: "b@example.com", lens: "meetings", filter: watchInput().filter });
  ownerB.subscriber_id = await deriveSubscriberId(ownerB.email);
  ownerB.watch_id = await deriveWatchId("sub:b");
  const first = await confirmExactMatterWatch(env, ownerA, { now: "2026-08-01T00:00:00.000Z", observations: [] });
  const again = await confirmExactMatterWatch(env, ownerA, { now: "2026-08-02T00:00:00.000Z", observations: [] });
  assert.equal(again.created, false);
  assert.equal(again.baseline.baseline_id, first.baseline.baseline_id);
  const other = await confirmExactMatterWatch(env, ownerB, { now: "2026-08-01T00:00:00.000Z", observations: [] });
  assert.equal(other.created, true);
  assert.notEqual(other.baseline.baseline_id, first.baseline.baseline_id);
  const meetings = compileSub({ lens: "meetings", filter: { when: "week" } }, "2026-08-10");
  assert.equal(meetings.kind, "meetings");
  const rules = compileSub({ lens: "rules", filter: { request_ids: ["20260408025"] } }, "2026-08-10");
  assert.ok(rules);
  const gated = compileExactCouncilMatter(watchInput(), "2026-08-10");
  assert.equal(gated.kind, "council-matter");
  const skipped = await eligibleMatterWatchRows(env, ownerA, { observations: [] });
  assert.deepEqual(skipped, []);
});

test("A7: unresolved identities cannot activate; removal cancels exclusive items; refollow is a fresh baseline", async () => {
  const { sqlite, DB } = matterJournalDatabase({ baselines: true });
  sqlite.exec(outboxSql);
  const env = { DB };
  assert.equal(
    exactCouncilMatterWatch({ lens: "meetings", matter_id: "999999999" }).status,
    "ok",
  );
  await assert.rejects(
    () => confirmExactMatterWatch(env, {
      lens: "meetings",
      filter: { matter_ref: "legistar:nyc:matter:999999999", matter_scope_version: 1 },
      subscriber_id: "subscriber:x",
      watch_id: "watch:x",
    }),
    /not in the retained roster/,
  );
  const record = buildSubscription({ email: "c@example.com", lens: "meetings", filter: watchInput().filter });
  record.subscriber_id = await deriveSubscriberId(record.email);
  record.watch_id = await deriveWatchId("sub:c");
  const first = await confirmExactMatterWatch(env, record, {
    now: "2026-08-01T00:00:00.000Z",
    observations: [{ observation_id: "old", matter_id: "79200", acquired_at: "2026-07-01T00:00:00.000Z" }],
  });
  sqlite.prepare(`
    INSERT INTO digest_outbox_items
      (watch_id, subscriber_id, item_id, lens, item_kind, payload_json,
       source_observed_at, first_owed_at, owed_origin, status, delivered_at)
    VALUES (?, ?, ?, 'meetings', 'council-matter', '{}', '2026-08-11', '2026-08-11T00:00:00.000Z', 'test', 'owed', NULL)
  `).run(record.watch_id, record.subscriber_id, "item:exclusive");
  sqlite.prepare(`
    INSERT INTO digest_outbox_items
      (watch_id, subscriber_id, item_id, lens, item_kind, payload_json,
       source_observed_at, first_owed_at, owed_origin, status, delivered_at)
    VALUES (?, ?, ?, 'meetings', 'council-matter', '{}', '2026-08-11', '2026-08-11T00:00:00.000Z', 'test', 'owed', NULL)
  `).run("watch:other", record.subscriber_id, "item:shared-other-watch");
  const removed = await removeExactMatterWatch(env, record, { now: "2026-08-12T00:00:00.000Z" });
  assert.equal(removed.removed, true);
  assert.equal(removed.cancelled, 1);
  const statuses = Object.fromEntries(
    sqlite.prepare("SELECT item_id, status FROM digest_outbox_items").all()
      .map((row) => [row.item_id, row.status]),
  );
  assert.equal(statuses["item:exclusive"], "cancelled");
  assert.equal(statuses["item:shared-other-watch"], "owed");
  const refollow = await confirmExactMatterWatch(env, record, {
    now: "2026-08-20T00:00:00.000Z",
    observations: [
      { observation_id: "old", matter_id: "79200", acquired_at: "2026-07-01T00:00:00.000Z" },
      { observation_id: "mid", matter_id: "79200", acquired_at: "2026-08-15T00:00:00.000Z" },
    ],
  });
  assert.equal(refollow.created, true);
  assert.notEqual(refollow.baseline.baseline_id, first.baseline.baseline_id);
  assert.ok(refollow.baseline.observation_ids.includes("mid"));
});

test("Following restore and matter document keep native follow links", () => {
  const href = followingUrlFromWatch(watchInput(), { frequency: "weekly" });
  const parsed = watchFromFollowingParams(new URL(href, "https://cityscroll.org").searchParams);
  assert.equal(parsed.filter.matter_ref, MATTER);
  const view = buildFollowingViewModel(parsed);
  const page = renderFollowingDocument(view);
  assert.match(page, /Council matter 79200/);
  assert.match(page, /latest observed official action|No later official action has been located/i);
  assert.match(page, /<details class="matter-watch-source">/);
  const summary = councilMatterWatchSummaryHtml(watchInput(), { stale: true });
  assert.match(summary, /last known history is still shown/i);
  const html = councilMatterFollowMarkup({ lens: "meetings", matter_id: "79200" });
  assert.match(html, /data-matter-id="79200"/);
  assert.match(html, /Follow /);
  assert.match(html, /legistar%3Anyc%3Amatter%3A79200/);
  const latest = latestObservedAction("79200");
  assert.ok(latest);
});
