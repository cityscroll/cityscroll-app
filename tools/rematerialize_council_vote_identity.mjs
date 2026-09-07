#!/usr/bin/env node
/**
 * Reacquire item-level Council roll-call records and rebuild the committed
 * meeting-outcomes snapshot's vote evidence from them.
 *
 * Why this exists as its own pass: the published snapshot was materialized by a
 * pipeline that keyed roll-call summaries by matter alone. A matter that is
 * heard twice — a hearing in March and an approval in April — therefore carried
 * one meeting's roster on both dates, and an agenda item on which no roll call
 * was taken carried a full roster that was never cast. Those rows cannot be
 * corrected by reasoning over themselves; the only honest repair is to go back
 * to the publisher's own item-level records and rebuild from them.
 *
 * What it does:
 *   1. Reads every present notice in site/data/meeting_outcomes_snapshot.json.
 *   2. Refetches Events/{id}/EventItems and EventItems/{id}/Votes for the events
 *      those notices are joined to, from the authenticated NYC Council Legistar
 *      Web API (client `nyc`).
 *   3. Runs the production assembly and compaction code — the same modules the
 *      Worker uses — so the repaired snapshot is what the next materialization
 *      will produce rather than a hand-patched approximation.
 *   4. Writes a dated source receipt naming every event, event item, matter,
 *      action, and published vote value it saw, plus what changed.
 *
 * Credential: LEGISTAR_API_TOKEN, or LEGISTAR_API_TOKEN_FILE naming a file that
 * holds only the token. The value is never logged, echoed, or written into any
 * artifact this tool produces.
 *
 * The downstream projections are rebuilt by their own builders afterwards:
 *   node tools/build_legislative_matter_documents.mjs
 *   node tools/build_person_votes_lookup.mjs
 *
 * Usage:
 *   node tools/rematerialize_council_vote_identity.mjs               # rewrite snapshot + receipt
 *   node tools/rematerialize_council_vote_identity.mjs --dry-run     # report only
 *   node tools/rematerialize_council_vote_identity.mjs --events 22567,22526
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEETING_OUTCOMES_VIEW_VERSION,
  assembleAgenda,
  indexVoteSummaries,
  normalizeCouncilAgendaItem,
} from "../worker/src/lib/meeting_outcomes.mjs";
import {
  fetchLegistarEventItems,
  fetchLegistarItemVoteRows,
  summarizeLegistarVotes,
} from "../worker/src/lib/legistar_client.mjs";
import { compactMeetingOutcomeRecord } from "../site/meeting_outcomes_static.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const RECEIPT_DIR = path.join(ROOT, "site/data/legistar_sources/verification_receipts");

const CLEAN = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const bucket = key(row);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

function readToken() {
  const file = process.env.LEGISTAR_API_TOKEN_FILE;
  if (file) {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  return CLEAN(process.env.LEGISTAR_API_TOKEN) || null;
}

/** A stable fingerprint of one appearance's vote evidence, for before/after comparison. */
export function voteFingerprint(matter) {
  const votes = matter?.votes;
  if (!votes) return "no_roll_call_recorded";
  const people = (Array.isArray(votes.by_person) ? votes.by_person : [])
    .map((person) => `${person.person_id}:${person.vote_bucket}`)
    .sort()
    .join(",");
  return `${votes.result || "—"}|${votes.yes ?? "—"}/${votes.no ?? "—"}/${votes.abstain ?? "—"}/${votes.absent ?? "—"}|${people}`;
}

/**
 * Reacquire one event's items and roll calls and return the production-shaped
 * agenda for it.
 */
async function reacquireEvent({ eventId, token, fetchImpl }) {
  const rawItems = await fetchLegistarEventItems({ eventId, token, fetchImpl });
  const items = rawItems.map(normalizeCouncilAgendaItem).filter((item) => item.event_id);
  const summaries = [];
  const observed = [];
  const people = [];
  for (const raw of rawItems) {
    if (!raw?.EventItemId) continue;
    const itemId = String(raw.EventItemId);
    const matterId = CLEAN(raw.EventItemMatterId) || null;
    const rows = matterId
      ? await fetchLegistarItemVoteRows({ itemId, token, fetchImpl })
      : [];
    const summary = rows.length
      ? summarizeLegistarVotes(rows, {
        matterId,
        agendaItemId: itemId,
        eventItemId: itemId,
        eventId: String(eventId),
      })
      : null;
    if (summary) {
      summaries.push({
        matter_id: matterId,
        event_id: String(eventId),
        event_item_id: itemId,
        ...summary,
      });
    }
    if (matterId) {
      observed.push({
        event_id: String(eventId),
        event_item_id: itemId,
        matter_id: matterId,
        matter_file: CLEAN(raw.EventItemMatterFile) || null,
        action: CLEAN(raw.EventItemActionName) || null,
        roll_call_rows: rows.length,
        vote_state: summary ? "roll_call_recorded" : "no_roll_call_recorded",
        published_vote_values: summary ? summary.published_vote_values : [],
      });
    }
    for (const person of summary?.by_person || []) {
      // One person row per publisher vote row, addressed by the agenda item it
      // was cast on. Two actions on one matter at one meeting stay two rows.
      people.push({
        person_id: person.person_id,
        person_name: person.person_name,
        vote: person.vote_value || null,
        vote_bucket: person.vote_bucket,
        vote_participation: person.vote_participation,
        matter_id: matterId,
        matter_file: CLEAN(raw.EventItemMatterFile) || null,
        matter_title: CLEAN(raw.EventItemMatterName) || null,
        event_id: String(eventId),
        event_item_id: itemId,
        action: CLEAN(raw.EventItemActionName) || null,
        source_system: "legistar",
      });
    }
  }
  const agendaItems = assembleAgenda(items, indexVoteSummaries(summaries, items));
  return { agendaItems, observed, people, item_count: rawItems.length };
}

/**
 * The notice, agency and date each event is published under. The publisher's
 * event id is the join key; a people row that cannot name its notice keeps a
 * null rather than borrowing another event's.
 */
export function buildEventContext({ snapshot, peopleDoc }) {
  const context = new Map();
  for (const row of peopleDoc?.rows || []) {
    const eventId = CLEAN(row?.event_id);
    if (!eventId || context.has(eventId)) continue;
    context.set(eventId, {
      request_id: CLEAN(row.request_id) || null,
      event_date: CLEAN(row.event_date) || null,
      agency_name: CLEAN(row.agency_name) || "City Council",
    });
  }
  for (const [requestId, record] of Object.entries(snapshot?.by_notice || {})) {
    const eventId = CLEAN(record?.event?.event_id);
    if (!eventId || record?.snapshot_state !== "present") continue;
    const prior = context.get(eventId) || {};
    context.set(eventId, {
      request_id: prior.request_id || CLEAN(requestId) || null,
      event_date: prior.event_date || CLEAN(record.event.date) || null,
      agency_name: prior.agency_name || CLEAN(record.event.name) || "City Council",
    });
  }
  return context;
}

export async function rematerialize({
  snapshot,
  peopleDoc = null,
  token,
  fetchImpl = fetch,
  eventFilter = null,
} = {}) {
  const notices = Object.entries(snapshot.by_notice || {})
    .filter(([, record]) => record?.snapshot_state === "present" && record?.event?.event_id);
  const byEvent = new Map();
  const observations = [];
  const changes = [];
  const eventContext = buildEventContext({ snapshot, peopleDoc });

  const load = async (eventId) => {
    if (byEvent.has(eventId)) return byEvent.get(eventId);
    const bag = await reacquireEvent({ eventId, token, fetchImpl });
    byEvent.set(eventId, bag);
    observations.push(...bag.observed);
    return bag;
  };

  for (const [requestId, record] of notices) {
    const eventId = String(record.event.event_id);
    if (eventFilter && !eventFilter.has(eventId)) continue;
    await load(eventId);
    const { agendaItems } = byEvent.get(eventId);
    const rebuilt = compactMeetingOutcomeRecord({
      request_id: requestId,
      join: { matched: true },
      council_event: {
        event_id: eventId,
        body_name: record.event.name,
        event_date: record.event.date,
        event_url: record.event.url,
      },
      agenda_items: agendaItems,
    });
    if (!rebuilt) continue;

    const before = new Map((record.matters || []).map((matter) => [
      CLEAN(matter.matter_file || matter.matter_id),
      matter,
    ]));
    for (const matter of rebuilt.matters || []) {
      const key = CLEAN(matter.matter_file || matter.matter_id);
      const priorFingerprint = before.has(key) ? voteFingerprint(before.get(key)) : "not_previously_published";
      const nextFingerprint = voteFingerprint(matter);
      if (priorFingerprint !== nextFingerprint) {
        changes.push({
          request_id: requestId,
          event_id: eventId,
          event_date: record.event.date,
          matter_id: matter.matter_id,
          matter_file: matter.matter_file,
          before: priorFingerprint,
          after: nextFingerprint,
        });
      }
    }
    // Keep the notice's own event projection; only the vote evidence is rebuilt.
    record.matters = rebuilt.matters;
  }

  // Person-level rows for every event the people artifact already covers, so
  // its published population is rebuilt from item-level records rather than
  // from the read model that carried the collision.
  const peopleEventIds = [...new Set([
    ...(peopleDoc?.source?.event_ids || []).map((id) => CLEAN(id)),
    ...(peopleDoc?.rows || []).map((row) => CLEAN(row?.event_id)),
  ])].filter(Boolean).sort();
  for (const eventId of peopleEventIds) {
    if (eventFilter && !eventFilter.has(eventId)) continue;
    await load(eventId);
  }

  const peopleRows = [];
  for (const eventId of [...byEvent.keys()].sort()) {
    const context = eventContext.get(eventId) || {};
    for (const row of byEvent.get(eventId).people) {
      peopleRows.push({
        ...row,
        request_id: context.request_id || null,
        agency_name: context.agency_name || "City Council",
        event_date: context.event_date || null,
      });
    }
  }

  return {
    observations,
    changes,
    peopleRows,
    events: [...byEvent.keys()].sort(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const eventArg = args.includes("--events") ? args[args.indexOf("--events") + 1] : null;
  const eventFilter = eventArg
    ? new Set(eventArg.split(",").map((value) => CLEAN(value)).filter(Boolean))
    : null;

  const token = readToken();
  if (!token) {
    console.error("LEGISTAR_API_TOKEN (or LEGISTAR_API_TOKEN_FILE) is required to reacquire item-level records.");
    process.exit(2);
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const peopleDoc = JSON.parse(readFileSync(PEOPLE, "utf8"));
  const peopleBefore = {
    rows: peopleDoc.rows.length,
    people: new Set(peopleDoc.rows.map((row) => CLEAN(row.person_id))).size,
    events: new Set(peopleDoc.rows.map((row) => CLEAN(row.event_id))).size,
    by_published_value: countBy(peopleDoc.rows, (row) => CLEAN(row.vote) || "(no label published)"),
    by_bucket: countBy(peopleDoc.rows, (row) => CLEAN(row.vote_bucket) || "(unset)"),
  };
  const { observations, changes, peopleRows, events } = await rematerialize({
    snapshot,
    peopleDoc,
    token,
    eventFilter,
  });
  const peopleAfter = {
    rows: peopleRows.length,
    people: new Set(peopleRows.map((row) => CLEAN(row.person_id))).size,
    events: new Set(peopleRows.map((row) => CLEAN(row.event_id))).size,
    event_items: new Set(peopleRows.map((row) => CLEAN(row.event_item_id))).size,
    by_published_value: countBy(peopleRows, (row) => CLEAN(row.vote) || "(no label published)"),
    by_bucket: countBy(peopleRows, (row) => CLEAN(row.vote_bucket) || "(unset)"),
  };

  const rollCallItems = observations.filter((row) => row.vote_state === "roll_call_recorded");
  const valueCounts = new Map();
  for (const row of observations) {
    for (const entry of row.published_vote_values || []) {
      valueCounts.set(entry.vote_value, (valueCounts.get(entry.vote_value) || 0) + entry.rows);
    }
  }
  const receipt = {
    schema: "cityscroll.metric_receipt.v1",
    metric: "council_vote_event_item_binding",
    measured_at: new Date().toISOString().slice(0, 10),
    subject: "Council roll-call evidence bound to its publisher event and event item",
    source: {
      system: "legistar",
      endpoints: ["Events/{id}/EventItems", "EventItems/{id}/Votes"],
      client: "nyc",
      basis: "Authenticated item-level reacquisition; no summary is attached to an agenda item it was not recorded on.",
    },
    scope: {
      events: events.length,
      matter_bearing_event_items: observations.length,
      event_items_with_roll_call: rollCallItems.length,
      event_items_without_roll_call: observations.length - rollCallItems.length,
      retained_vote_rows: observations.reduce(
        (sum, row) => sum + row.roll_call_rows,
        0,
      ),
    },
    published_vote_values: [...valueCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([vote_value, rows]) => ({ vote_value, rows })),
    corrected_appearances: changes,
    person_rows: {
      before: peopleBefore,
      after: peopleAfter,
      basis: "Before is the published people artifact. After is one row per publisher vote row, addressed by event item. Counts move because rows that were copied onto meetings where no roll call was taken are gone, and rows the matter-keyed map dropped are back.",
    },
    event_items: observations,
    product_surfaces: [
      "worker/src/lib/meeting_outcomes.mjs#indexVoteSummaries",
      "entity_resolution/officials/index.mjs#voteBucket",
      "site/meeting_outcomes_static.mjs#compactVotes",
      "tools/build_legislative_matter_documents.mjs",
    ],
  };
  const receiptPath = path.join(
    RECEIPT_DIR,
    `council_vote_event_identity_${receipt.measured_at}.json`,
  );

  console.log(`events=${events.length} matter-bearing items=${observations.length} with roll call=${rollCallItems.length} corrected appearances=${changes.length}`);
  for (const change of changes) {
    console.log(`  ${change.event_date} event ${change.event_id} matter ${change.matter_id}: ${change.before} -> ${change.after}`);
  }
  const retrievedAt = new Date().toISOString();
  const nextPeople = {
    ...peopleDoc,
    retrieved_at: retrievedAt,
    description:
      "Person-level Legistar votes reacquired from the publisher's own item-level records. Every row names the event item it was cast on, keeps the publisher's own vote label, and is classified without folding a recorded absence into an abstention. Exact numeric person ids only; fuzzy/name-only identity rows are excluded.",
    source: {
      ...peopleDoc.source,
      read_model: `meeting-outcomes:materialized:v${MEETING_OUTCOMES_VIEW_VERSION}`,
      via: "event_item_votes",
      densify: "authenticated_event_item_reacquisition",
      event_ids: [...new Set(peopleRows.map((row) => CLEAN(row.event_id)))].sort(),
      eligible_event_ids: [...new Set(peopleRows.map((row) => CLEAN(row.event_id)))].sort(),
      seed_notices: [...new Set(peopleRows.map((row) => CLEAN(row.request_id)).filter(Boolean))].sort(),
    },
    row_count: peopleRows.length,
    person_count: peopleAfter.people,
    notice_count: new Set(peopleRows.map((row) => CLEAN(row.request_id)).filter(Boolean)).size,
    event_count: peopleAfter.events,
    event_item_count: peopleAfter.event_items,
    rows: peopleRows,
  };

  console.log(`people rows ${peopleBefore.rows} -> ${peopleAfter.rows}`);
  if (dryRun) {
    console.log(`published vote values before: ${JSON.stringify(peopleBefore.by_published_value)}`);
    console.log(`published vote values after:  ${JSON.stringify(peopleAfter.by_published_value)}`);
    console.log(`buckets after: ${JSON.stringify(peopleAfter.by_bucket)}`);
    console.log("--dry-run: nothing written");
    return;
  }
  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(PEOPLE, `${JSON.stringify(nextPeople, null, 2)}\n`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`people rows ${peopleBefore.rows} -> ${peopleAfter.rows} across ${peopleAfter.events} events / ${peopleAfter.event_items} event items`);
  console.log(`published vote values after: ${JSON.stringify(peopleAfter.by_published_value)}`);
  console.log(`wrote ${path.relative(ROOT, SNAPSHOT)}, ${path.relative(ROOT, PEOPLE)} and ${path.relative(ROOT, receiptPath)}`);
  console.log("next: node tools/build_legislative_matter_documents.mjs && node tools/build_person_votes_lookup.mjs");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
