/**
 * Prove continuing coverage and recoverability for exact Council-matter follow-through.
 *
 *   node --test worker/test/council_matter_coverage_recovery.test.mjs
 *
 * Frozen snapshot counts are the expected-result oracle. Synthetic faults are
 * labelled durability tests. No test contacts a publisher except through the
 * collector adapter fixture, and no test preloads a later event into the state
 * that claims to discover it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ALERT_CLASS,
  DEFAULT_REFRESH_CADENCE_MS,
  FROZEN_LATER_EVENT_WATCHES,
  RECOVERY_PLAYBOOK,
  deriveFrozenCoverageOracle,
  evaluateDeployedCoverageCanary,
  receiptContainsResidentEmail,
  withholdLaterMatterPackets,
} from "../../site/matter_coverage_recovery.mjs";
import { createPublisherFetch } from "./helpers/matter_exact_refresh_oracle.mjs";
import {
  DATA_VINTAGE,
  ORACLE,
  SNAPSHOT,
  START,
  coverageRecoveryDatabase,
  catalogFromSnapshot,
  runDeliveryLagFault,
  runFrozenCoverageReplay,
  runPublicationLagFault,
  runStaleRefreshFault,
} from "./helpers/matter_coverage_recovery_oracle.mjs";
import { refreshExactMatterRoster, ROSTER_KIND, upsertRosterEntry } from "../src/lib/matter_exact_refresh.mjs";
import { retainSnapshotMatterObservations } from "../src/lib/matter_observation_journal.mjs";
import { projectMatterCoverageReceipt } from "../src/lib/matter_coverage_recovery.mjs";
import { renderMatterCoverageRecoveryOperatorHtml } from "../src/lib/matter_coverage_recovery_operator_view.mjs";
function loadManifest() {
  return JSON.parse(
    readFileSync(new URL("../../docs/evidence/matter-coverage-recovery/manifest.json", import.meta.url), "utf8"),
  );
}

test("frozen oracle derives 64/79 independently of the matter-document builder", () => {
  const oracle = deriveFrozenCoverageOracle(SNAPSHOT);
  assert.equal(oracle.materialized_matters, 64);
  assert.equal(oracle.distinct_appearances, 79);
  assert.equal(oracle.raw_appearances, 81);
  assert.equal(oracle.two_event_histories, 15);
  assert.equal(oracle.single_event_histories, 49);
  assert.equal(oracle.later_event_watches, 15);
  assert.deepEqual(oracle.two_event_matter_ids, FROZEN_LATER_EVENT_WATCHES.map((row) => row.matter_id).sort());
  const withheld = withholdLaterMatterPackets(SNAPSHOT, oracle);
  let laterStillPresent = 0;
  for (const record of Object.values(withheld.by_notice)) {
    const eventId = String(record?.event?.event_id || "");
    for (const matter of record.matters || []) {
      if (oracle.later_watch_keys.includes(`${matter.matter_id}:${eventId}`)) laterStillPresent += 1;
    }
  }
  assert.equal(laterStillPresent, 0);
});

test("A1-A3: withheld later packets yield 64/79/15/15/0 across day 181, day 365, restart, and partial failure", async () => {
  const replay = await runFrozenCoverageReplay({ restart: true, partialFailure: true });
  try {
    assert.equal(replay.counts.materialized_matters, 64);
    assert.equal(replay.counts.distinct_appearances, 79);
    assert.equal(replay.counts.later_event_discoveries, 15);
    assert.equal(replay.counts.logical_later_updates, 15);
    assert.equal(replay.counts.replay_duplicates, 0);
    assert.equal(replay.beforeRelease.later, 0);
    assert.equal(replay.discovered.length, 15);
    assert.equal(new Set(replay.updateKeys).size, 15);
    assert.equal(replay.counts.recovered_updates_181, 0);
    assert.equal(replay.counts.recovered_updates_365, 0);
    assert.equal(replay.acceptance.obligations.A1.status, "pass");
    assert.equal(replay.acceptance.obligations.A2.status, "pass");
    assert.equal(replay.acceptance.obligations.A3.status, "pass");
    assert.ok(replay.collector_requests.every((row) => row.path.startsWith("/v1/nyc/")));
    assert.ok(replay.collector_requests.every((row) => !/dg92-zbpx|cityofnewyork/i.test(row.path)));
    assert.equal(replay.durability, false);
  } finally {
    replay.sqlite.close();
  }
});

test("A4: operational receipts expose health fields without resident email addresses", async () => {
  const replay = await runFrozenCoverageReplay({ restart: false, partialFailure: false });
  try {
    const receipt = replay.receipt;
    assert.equal(typeof receipt.active_watches, "number");
    assert.equal(typeof receipt.due_matters, "number");
    assert.equal(typeof receipt.last_complete_refresh_age_ms, "number");
    assert.equal(typeof receipt.deferred_work, "number");
    assert.equal(typeof receipt.failure_class, "string");
    assert.equal(typeof receipt.retained_counts.matters, "number");
    assert.equal(typeof receipt.publication_lag_ms, "number");
    assert.equal(typeof receipt.pending_outbox_items, "number");
    assert.equal(typeof receipt.failed_outbox_items, "number");
    assert.equal(receiptContainsResidentEmail(receipt), false);
    const html = renderMatterCoverageRecoveryOperatorHtml({ receipt }, { route: "/operator/matter-coverage/healthy/" });
    assert.match(html, /Active watches/);
    assert.match(html, /Due matters/);
    assert.match(html, /Last complete refresh age/);
    assert.match(html, /Deferred work/);
    assert.match(html, /Publication lag/);
    assert.match(html, /Pending outbox items/);
    assert.doesNotMatch(html, /@example\.com/);
    assert.doesNotMatch(html, /subscribe@|notify me/i);
  } finally {
    replay.sqlite.close();
  }
});

test("A5: stale refresh, publication lag, and pending delivery alerts recover", async () => {
  const stale = await runStaleRefreshFault();
  assert.equal(stale.durability, true);
  assert.ok(stale.before.alerts.some((row) => row.id === ALERT_CLASS.STALE_REFRESH && row.owner === "site owner"));
  assert.equal(stale.before.alerts.some((row) => row.id === ALERT_CLASS.STALE_REFRESH), true);
  assert.equal(stale.after.alerts.some((row) => row.id === ALERT_CLASS.STALE_REFRESH), false);

  const publication = await runPublicationLagFault();
  assert.equal(publication.durability, true);
  assert.ok(publication.before.alerts.some((row) => row.id === ALERT_CLASS.PUBLICATION_LAG && row.owner === "site owner"));
  assert.ok(publication.before.unpublished_eligible_changes >= 1);
  assert.equal(publication.after.unpublished_eligible_changes, 0);
  assert.equal(publication.after.alerts.some((row) => row.id === ALERT_CLASS.PUBLICATION_LAG), false);

  const delivery = await runDeliveryLagFault();
  assert.equal(delivery.durability, true);
  assert.ok(delivery.before.alerts.some((row) => row.id === ALERT_CLASS.DELIVERY_LAG && row.owner === "site owner"));
  assert.ok(delivery.before.pending_outbox_items >= 10);
  assert.equal(delivery.after.pending_outbox_items, 0);
  assert.equal(delivery.after.alerts.some((row) => row.id === ALERT_CLASS.DELIVERY_LAG), false);
});

test("A6: acceptance-keyed evidence index covers every obligation without named live record gates", () => {
  const manifest = loadManifest();
  assert.equal(manifest.schema, "cityscroll.matter_coverage_recovery_evidence.v1");
  assert.equal(manifest.data_vintage, DATA_VINTAGE);
  assert.equal(manifest.acceptance.schema, "cityscroll.matter_coverage_acceptance.v1");
  for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A7"]) {
    assert.equal(manifest.acceptance.obligations[id].status, "pass", id);
  }
  assert.equal(manifest.canary.named_live_record_gate, false);
  assert.equal(manifest.canary.ok, true);
  assert.notEqual(manifest.canary.kind, "live-named-record");
  assert.match(manifest.image_directory, /^\.artifacts\//);
  assert.ok(manifest.files.some((file) => file.viewport[0] === 390));
  assert.ok(manifest.files.some((file) => file.viewport[0] === 1440));
  assert.ok(manifest.revision);
  assert.equal(manifest.replay_counts.materialized_matters, 64);
  assert.equal(manifest.replay_counts.distinct_appearances, 79);
});

test("A7: recovery playbook documents token, budget, cursor, publication, delivery, and rollback owners", () => {
  for (const key of ["token_recovery", "budget_backlog", "cursor_recovery", "failed_publication", "replay_safe_delivery", "feature_rollback"]) {
    assert.equal(RECOVERY_PLAYBOOK[key].owner, "site owner");
    assert.ok(RECOVERY_PLAYBOOK[key].action.length > 20);
  }
  const html = renderMatterCoverageRecoveryOperatorHtml({
    receipt: { failure_class: ALERT_CLASS.NONE, playbook: RECOVERY_PLAYBOOK, alerts: [] },
  });
  assert.match(html, /token recovery/i);
  assert.match(html, /budget backlog/i);
  assert.match(html, /cursor recovery/i);
  assert.match(html, /failed publication/i);
  assert.match(html, /replay-safe delivery/i);
  assert.match(html, /feature rollback/i);
  assert.match(html, /Cards stay proposed/);
});

test("durability: token failure keeps last-good history and budget backlog stays partial", async () => {
  const { sqlite, env } = coverageRecoveryDatabase();
  const withheld = withholdLaterMatterPackets(SNAPSHOT, ORACLE);
  await retainSnapshotMatterObservations(env, withheld, { acquiredAt: START.toISOString() });
  await upsertRosterEntry(env, { matterId: "78605", kind: ROSTER_KIND.activeWatch, now: START });
  await upsertRosterEntry(env, { matterId: "78606", kind: ROSTER_KIND.activeWatch, now: START });
  const catalog = catalogFromSnapshot(withheld);
  const forbidden = await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl: createPublisherFetch(catalog, { status: 403 }).fetchImpl,
    maxMatters: 2,
    maxRequests: 20,
  });
  assert.notEqual(forbidden.status, "complete");
  const before = await projectMatterCoverageReceipt(env, { now: START });
  assert.ok(before.retained_counts.matters >= 1);
  const budget = await refreshExactMatterRoster(env, {
    now: new Date(START.getTime() + DEFAULT_REFRESH_CADENCE_MS + 60_000),
    fetchImpl: createPublisherFetch(catalog).fetchImpl,
    maxMatters: 1,
    maxRequests: 40,
  });
  assert.notEqual(budget.current, true);
  sqlite.close();
});

test("bounded canary uses population floors, not fixed live record ids", () => {
  const canary = evaluateDeployedCoverageCanary({
    deployment_kind: "local-rehearsal",
    active_watches: 10,
    retained_counts: { matters: 64 },
    pending_outbox_items: 0,
    failed_outbox_items: 0,
    live_required_record_ids: [],
  });
  assert.equal(canary.ok, true);
  assert.equal(canary.named_live_record_gate, false);
  const blocked = evaluateDeployedCoverageCanary({ live_required_record_ids: ["78605"] });
  assert.equal(blocked.ok, false);
});
