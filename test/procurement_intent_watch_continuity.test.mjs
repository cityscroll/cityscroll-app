import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildProspectiveProcess } from "../ontology/procurement_intent.mjs";
import { matchHistoricalIntent } from "../warehouse/lib/procurement_intent_realization_matcher.mjs";
import {
  PROCUREMENT_INTENT_EVIDENCE_STATES,
  PROCUREMENT_INTENT_FOLLOW_SOURCE,
  PROCUREMENT_INTENT_UPDATE_KIND,
  applyRealizationToWatch,
  evaluateProcurementIntentWatch,
  followProcurementIntent,
  procurementIntentWatchDeliveryEnabled,
  procurementIntentWatchDigestRows,
  releaseProcurementIntentWatch,
  renderProcurementIntentWatchUpdate,
} from "../site/procurement_intent_watch_continuity.mjs";
import { extractLensIdentity } from "../worker/src/lib/digest_outbox.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url),
  "utf8",
));

const caseById = (id) => fixtures.cases.find((item) => item.id === id);

// One statement that later realizes into two published solicitations, and one
// that realizes into exactly one. Both are the landed gold-pack positives.
const ONE_TO_MANY = caseById("compass-dycd-2025-05-19");
const ONE_TO_ONE = caseById("hra-dv-beds-2024-10-09");

const READER = "subscriber:reader-1";

const COMPASS_SOLICITATIONS = [
  {
    source_system: "city_record", source_system_id: "26026P0003", epin: "26026P0003",
    published_at: "2025-10-01", agency: "DYCD", title: "COMPASS Programs in Public Schools",
    procurement_method: "RFP", citation_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20250915017",
  },
  {
    source_system: "city_record", source_system_id: "26026P0004", epin: "26026P0004",
    published_at: "2025-10-01", agency: "Department of Youth and Community Development",
    title: "COMPASS Center-Based and Non-Public School Site Programs", procurement_method: "RFP",
  },
];

const SHELTER_SOLICITATION = {
  source_system: "passport", source_system_id: "06925P0010", epin: "06925P0010",
  published_at: "2025-03-07", agency: "HRA / DSS",
  title: "DVS 94 beds Emergency Shelter and Support Services Open Ended RFx",
  description: "Emergency shelter for domestic violence survivors, single adults and families.",
  procurement_method: "RFx",
};

function processFor(fixtureCase) {
  return buildProspectiveProcess({
    source: fixtureCase.source,
    assertion: fixtureCase.expected_future_action_assertion,
  });
}

function matchFor(fixtureCase, solicitations) {
  const process = processFor(fixtureCase);
  return {
    process,
    match: matchHistoricalIntent({
      process_ref: process.process_ref,
      stated_intent: process.stated_intent,
    }, solicitations),
  };
}

function digestContext(process) {
  return { stated_intent: process.stated_intent, source_record: process.source_record };
}

test("a watch created before publication survives the identity transition", () => {
  const { process, match } = matchFor(ONE_TO_ONE, [SHELTER_SOLICITATION]);

  // The reader follows while the object is still only a statement in the record.
  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2024-10-10",
  });
  assert.equal(followed.created, true);
  assert.equal(followed.watch.follow.source, PROCUREMENT_INTENT_FOLLOW_SOURCE);
  assert.equal(followed.watch.subject_lineage.identity_state, "prospective");
  assert.deepEqual(followed.watch.subject_lineage.realized_subject_refs, []);

  // Publication arrives. The same watch carries the publisher identity.
  const carried = applyRealizationToWatch(followed.watch, {
    match,
    observations: [SHELTER_SOLICITATION],
    asserted_at: process.stated_intent.observed_at,
    now: "2025-03-08",
  });
  assert.equal(carried.watch.watch_key, followed.watch.watch_key);
  assert.equal(carried.replaced_subject, false);
  assert.equal(carried.watch.subject_lineage.provisional_subject_ref, process.process_ref);
  assert.deepEqual(carried.watch.subject_lineage.realized_subject_refs, ["procurement:passport:06925P0010"]);
  assert.deepEqual(carried.watch.subject_lineage.cardinality, {
    intent_count: 1, realized_count: 1, relation: "one_to_one",
  });
  assert.equal(carried.watch.realizations[0].epin, "06925P0010");
  assert.equal(carried.watch.realizations[0].published_at, "2025-03-07");
  assert.equal(carried.watch.realizations[0].advance_lead_days, 149);
  assert.equal(carried.watch.realizations[0].published_before_follow, false);

  // No second watch, and no re-subscription step, exists anywhere in that path.
  const afterPublication = followProcurementIntent({
    watches: [carried.watch], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-03-09",
  });
  assert.equal(afterPublication.created, false);
  assert.equal(afterPublication.reason, "already_following");
  assert.deepEqual(afterPublication.watch, carried.watch);
});

test("a one-to-many realization keeps every published relationship on the one watch", () => {
  const { process, match } = matchFor(ONE_TO_MANY, COMPASS_SOLICITATIONS);
  assert.equal(match.realized_by.length, 2);

  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-05-20",
  });
  const carried = applyRealizationToWatch(followed.watch, {
    match,
    observations: COMPASS_SOLICITATIONS,
    asserted_at: process.stated_intent.observed_at,
    now: "2025-10-02",
  });

  assert.deepEqual(carried.watch.subject_lineage.realized_subject_refs, [
    "procurement:city_record:26026P0003",
    "procurement:city_record:26026P0004",
  ]);
  assert.deepEqual(carried.watch.subject_lineage.cardinality, {
    intent_count: 1, realized_count: 2, relation: "one_to_many",
  });
  // Neither solicitation is chosen as "the" realization, and the provisional
  // subject is still the watch's anchor.
  assert.equal(carried.watch.subject_lineage.provisional_subject_ref, process.process_ref);
  assert.deepEqual(carried.watch.realizations.map((row) => row.epin), ["26026P0003", "26026P0004"]);
  assert.equal(carried.watch.transitions.length, 2);
  assert.ok(carried.watch.transitions.every((row) => row.from_subject_ref === process.process_ref));
});

test("re-following and re-applying the same realization are both inert", () => {
  const { process, match } = matchFor(ONE_TO_MANY, COMPASS_SOLICITATIONS);
  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-05-20",
  });

  // Following twice is one watch, not two.
  const again = followProcurementIntent({
    watches: [followed.watch], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-06-01",
  });
  assert.equal(again.created, false);
  assert.equal(again.watch.watch_key, followed.watch.watch_key);
  assert.deepEqual(again.watch, followed.watch);

  const first = applyRealizationToWatch(followed.watch, {
    match, observations: COMPASS_SOLICITATIONS, asserted_at: process.stated_intent.observed_at, now: "2025-10-02",
  });
  const second = applyRealizationToWatch(first.watch, {
    match, observations: COMPASS_SOLICITATIONS, asserted_at: process.stated_intent.observed_at, now: "2025-11-15",
  });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.watch, first.watch);

  // Unfollowing is explicit, and re-following restores the same watch with its
  // lineage intact rather than starting a second discovery.
  const released = releaseProcurementIntentWatch(first.watch, { now: "2025-11-16" });
  assert.equal(released.status, "released");
  assert.deepEqual(procurementIntentWatchDigestRows(released, digestContext(process)), []);
  const refollowed = followProcurementIntent({
    watches: [released], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-11-20",
  });
  assert.equal(refollowed.created, false);
  assert.equal(refollowed.reason, "refollowed");
  assert.equal(refollowed.watch.watch_key, first.watch.watch_key);
  assert.deepEqual(refollowed.watch.realizations, first.watch.realizations);
});

test("following a process that is already published still yields one watch", () => {
  const { process, match } = matchFor(ONE_TO_ONE, [SHELTER_SOLICITATION]);

  // The reader arrives after the solicitation is out.
  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-06-01",
  });
  const carried = applyRealizationToWatch(followed.watch, {
    match, observations: [SHELTER_SOLICITATION], asserted_at: process.stated_intent.observed_at, now: "2025-06-01",
  });

  assert.equal(carried.added.length, 1);
  assert.equal(carried.watch.realizations[0].published_before_follow, true);
  assert.equal(carried.watch.subject_lineage.identity_state, "realized");
  // Still one watch: the ordering of publication and follow changes what the
  // first digest says, not how many subscriptions the reader ends up with.
  assert.equal(carried.watch.watch_key, followed.watch.watch_key);
});

test("realization never creates a watch and never crosses subjects", () => {
  const { process, match } = matchFor(ONE_TO_ONE, [SHELTER_SOLICITATION]);
  assert.throws(() => applyRealizationToWatch(null, { match, now: "2025-03-08" }), /existing explicit watch/);

  const other = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: "procurement-intent:acs-atd-2022", now: "2025-01-01",
  });
  assert.throws(
    () => applyRealizationToWatch(other.watch, { match, now: "2025-03-08" }),
    /different provisional subject/,
  );

  // Ambiguous candidates are review leads, not identity: an unaccepted match
  // leaves the lineage prospective.
  const ambiguous = applyRealizationToWatch(
    followProcurementIntent({
      watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2024-10-10",
    }).watch,
    { match: { ...match, realized_by: match.candidates.map((candidate) => ({ to: candidate.realization_ref, status: "review" })) }, now: "2025-03-08" },
  );
  assert.deepEqual(ambiguous.added, []);
  assert.equal(ambiguous.watch.subject_lineage.identity_state, "prospective");
});

test("the digest path shows the early signal, then the published identity and advance lead", () => {
  const { process, match } = matchFor(ONE_TO_MANY, COMPASS_SOLICITATIONS);
  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-05-20",
  });

  // Before publication the digest carries exactly the early signal.
  const early = procurementIntentWatchDigestRows(followed.watch, digestContext(process));
  assert.equal(early.length, 1);
  assert.equal(early[0].kind, PROCUREMENT_INTENT_UPDATE_KIND.EARLY_SIGNAL);
  assert.equal(early[0].evidence.later_observation.status, "not_yet_observed");
  assert.equal(early[0].evidence.source_fact.observed_at, "2025-05-19");
  assert.match(early[0].evidence.source_fact.span_text, /concept paper/);
  assert.equal(early[0].evidence.cityscroll_interpretation.provisional_subject_ref, process.process_ref);
  // The early signal names no publisher identity, because none exists yet.
  assert.equal(early[0].evidence.later_observation.epin, null);

  const carried = applyRealizationToWatch(followed.watch, {
    match, observations: COMPASS_SOLICITATIONS, asserted_at: process.stated_intent.observed_at, now: "2025-10-02",
  });
  const rows = procurementIntentWatchDigestRows(carried.watch, digestContext(process));
  assert.deepEqual(rows.map((row) => row.kind), [
    PROCUREMENT_INTENT_UPDATE_KIND.EARLY_SIGNAL,
    PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED,
    PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED,
  ]);
  assert.deepEqual(rows.slice(1).map((row) => row.evidence.later_observation.epin), ["26026P0003", "26026P0004"]);
  assert.deepEqual(rows.slice(1).map((row) => row.realization.advance_lead_days), [135, 135]);
  assert.match(rows[1].short_title, /26026P0003/);
  assert.match(rows[1].short_title, /135 days after the statement you followed/);

  // Every row keeps the three evidence registers apart and self-labelled.
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.evidence), PROCUREMENT_INTENT_EVIDENCE_STATES);
    for (const state of PROCUREMENT_INTENT_EVIDENCE_STATES) {
      assert.equal(row.evidence[state].evidence_state, state);
    }
    // The source fact is identical on every row: publication does not rewrite
    // what the record said.
    assert.deepEqual(row.evidence.source_fact, rows[0].evidence.source_fact);
  }

  const html = renderProcurementIntentWatchUpdate(rows[1]);
  assert.match(html, /Source fact/);
  assert.match(html, /CityScroll interpretation/);
  assert.match(html, /Later observation/);
  // No forecast or confidence copy reaches the reader.
  assert.doesNotMatch(html, /probability|likely|forecast|predict/i);
});

test("delivery is gated, and a delivered early signal is never re-sent", () => {
  const { process, match } = matchFor(ONE_TO_ONE, [SHELTER_SOLICITATION]);
  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2024-10-10",
  });

  assert.equal(procurementIntentWatchDeliveryEnabled({}), false);
  assert.equal(procurementIntentWatchDeliveryEnabled({ PROCUREMENT_INTENT_WATCH_DELIVERY: "true" }), true);
  assert.deepEqual(
    evaluateProcurementIntentWatch(followed.watch, { ...digestContext(process), deliveryEnabled: false }),
    { rows: [], markSeenIds: [] },
  );

  const first = evaluateProcurementIntentWatch(followed.watch, {
    ...digestContext(process), seen: new Set(), deliveryEnabled: true,
  });
  assert.equal(first.rows.length, 1);

  const carried = applyRealizationToWatch(followed.watch, {
    match, observations: [SHELTER_SOLICITATION], asserted_at: process.stated_intent.observed_at, now: "2025-03-08",
  });
  const second = evaluateProcurementIntentWatch(carried.watch, {
    ...digestContext(process), seen: new Set(first.markSeenIds), deliveryEnabled: true,
  });
  // Only the publication is new; the early signal is not repeated.
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].kind, PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED);

  const third = evaluateProcurementIntentWatch(carried.watch, {
    ...digestContext(process), seen: new Set([...first.markSeenIds, ...second.markSeenIds]), deliveryEnabled: true,
  });
  assert.deepEqual(third.rows, []);
});

test("the outbox deduplicates continuity rows on their own update key", () => {
  const { process, match } = matchFor(ONE_TO_MANY, COMPASS_SOLICITATIONS);
  const followed = followProcurementIntent({
    watches: [], subscriber_ref: READER, process_ref: process.process_ref, now: "2025-05-20",
  });
  const carried = applyRealizationToWatch(followed.watch, {
    match, observations: COMPASS_SOLICITATIONS, asserted_at: process.stated_intent.observed_at, now: "2025-10-02",
  });
  const rows = procurementIntentWatchDigestRows(carried.watch, digestContext(process));

  const identities = rows.map((row) => extractLensIdentity({ lens: "money", row, kind: "procurement-intent" }));
  assert.ok(identities.every((identity) => identity.identityField === "procurement_intent_update_key"));
  assert.deepEqual(identities.map((identity) => identity.itemId), rows.map((row) => row.update_key));
  assert.equal(new Set(identities.map((identity) => identity.itemId)).size, rows.length);
});
