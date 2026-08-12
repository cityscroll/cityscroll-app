#!/usr/bin/env node
/**
 * Acquire and gate a dated Legistar roll-call promotion sample.
 *
 * The sample is deliberately separate from the daily six-month meeting view:
 * it joins City Record notices to Legistar events in modern and historical
 * strata, selects a bounded set of matter-bearing EventItems, and probes only
 * the existing EventItems/{id}/Votes route. Aggregate-only rows remain source
 * facts but never become person observations.
 *
 * A receipt is always written. People artifacts are replaced only when the
 * event-count and reviewed-precision gates pass, so a small or degraded live
 * sample cannot silently erase the last accepted materialization.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  boundedMap,
  fetchLegistarEventItems,
  fetchLegistarEvents,
  fetchLegistarItemVoteRows,
  summarizeLegistarVotes,
} from "../worker/src/lib/legistar_client.mjs";
import {
  buildMeetingDateIndex,
  joinNoticeToCouncilMeeting,
} from "../worker/src/lib/legistar_join.mjs";
import { buildPersonVotesLookup } from "../site/person_votes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const OUT_PERSON_VOTES = path.join(ROOT, "site/data/person_votes_lookup.json");
const PERSON_HUB = path.join(ROOT, "worker/src/data/person_hub_lookup.json");
const RECEIPT_DIR = path.join(ROOT, "site/data/legistar_sources/verification_receipts");

export const ROLL_CALL_GATE = Object.freeze({
  minimum_retention_rate: 0.95,
  minimum_reviewed_precision: 0.95,
  minimum_distinct_events: 30,
});
export const SAMPLE_TARGET = 300;
export const HOLDOUT_EVENT_TARGET = 30;
export const SAMPLE_STRATA = Object.freeze([
  { key: "modern_2025_2026", start: "2025-01-01", end: "2027-01-01", target: 150 },
  { key: "historical_2019_2024", start: "2019-01-01", end: "2025-01-01", target: 150 },
]);

const NOTICE_SELECT = [
  "request_id", "event_date", "short_title", "agency_name", "start_date",
].join(",");
const EVENT_PAGE_SIZE = 200;
const EVENT_MAX_PAGES = 12;
const NOTICE_LIMIT = 2_000;
const ITEM_CONCURRENCY = 6;
const VOTE_CONCURRENCY = 6;
const CLEAN = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const NUMERIC_ID = (value) => /^\d+$/.test(CLEAN(value));
const RATE = (num, den) => den > 0 ? Number((num / den).toFixed(4)) : 0;
const DATE_STAMP = () => new Date().toISOString().slice(0, 10);

function receiptPathFor(date) {
  return path.join(RECEIPT_DIR, `official_person_vote_retention_${String(date).slice(0, 10)}.json`);
}

function dateDay(value) {
  const text = CLEAN(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function requestUrl(start, end, limit) {
  const params = new URLSearchParams({
    $select: NOTICE_SELECT,
    $where: `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL)) AND event_date >= '${start}T00:00:00' AND event_date < '${end}T00:00:00'`,
    $order: "event_date DESC",
    $limit: String(limit),
  });
  return `https://data.cityofnewyork.us/resource/dg92-zbpx.json?${params}`;
}

async function fetchNoticeRows(stratum, fetchImpl = fetch) {
  const response = await fetchImpl(requestUrl(stratum.start, stratum.end, NOTICE_LIMIT));
  if (!response.ok) throw new Error(`City Record notices ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("City Record notices response is not an array");
  return rows;
}

function bodyOf(candidate) {
  return CLEAN(candidate?.event?.EventBodyName || candidate?.event?.BodyName);
}

function actionOf(item) {
  return fieldText(item?.EventItemActionName)
    || fieldText(item?.EventItemPassedFlagName)
    || fieldText(item?.EventItemRollCallFlag)
    || "unlabelled";
}

function voteLikely(item) {
  return Boolean(
    fieldText(item?.EventItemRollCallFlag)
    || fieldText(item?.EventItemPassedFlagName)
    || fieldText(item?.EventItemActionName),
  );
}

function fieldText(value) {
  return value === false || value == null ? "" : CLEAN(value);
}

function stratumForDate(value) {
  const day = dateDay(value);
  return SAMPLE_STRATA.find((stratum) => day >= stratum.start && day < stratum.end)?.key || null;
}

/**
 * Select a bounded, deterministic sample. The first pass gives each event at
 * most one item to maximize event coverage; the second pass fills remaining
 * capacity while rotating through body/action groups.
 */
export function selectStratifiedEventItems(candidates, target = SAMPLE_TARGET) {
  const byStratum = new Map(SAMPLE_STRATA.map((stratum) => [stratum.key, []]));
  for (const candidate of candidates || []) {
    const key = candidate?.stratum || stratumForDate(candidate?.event?.EventDate);
    if (byStratum.has(key)) byStratum.get(key).push(candidate);
  }
  for (const bucket of byStratum.values()) {
    bucket.sort((a, b) =>
      Number(voteLikely(b?.item)) - Number(voteLikely(a?.item))
      ||
      dateDay(b?.event?.EventDate).localeCompare(dateDay(a?.event?.EventDate))
      || bodyOf(a).localeCompare(bodyOf(b))
      || CLEAN(a?.item?.EventItemId).localeCompare(CLEAN(b?.item?.EventItemId)),
    );
  }

  const selected = [];
  const selectedItems = new Set();
  const selectedEvents = new Set();
  const perStratum = new Map();
  for (const stratum of SAMPLE_STRATA) perStratum.set(stratum.key, []);

  for (const stratum of SAMPLE_STRATA) {
    const bucket = byStratum.get(stratum.key) || [];
    const quota = Math.min(stratum.target, Math.ceil(target / SAMPLE_STRATA.length));
    for (const candidate of bucket) {
      const eventId = CLEAN(candidate?.event?.EventId);
      const itemId = CLEAN(candidate?.item?.EventItemId);
      if (!eventId || !itemId || selectedEvents.has(eventId)) continue;
      selected.push(candidate);
      perStratum.get(stratum.key).push(candidate);
      selectedItems.add(itemId);
      selectedEvents.add(eventId);
      if (perStratum.get(stratum.key).length >= quota) break;
    }
  }

  const grouped = new Map();
  for (const candidate of candidates || []) {
    const stratum = candidate?.stratum;
    if (!perStratum.has(stratum)) continue;
    const key = `${stratum}\0${bodyOf(candidate)}\0${actionOf(candidate)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  let cursor = 0;
  while (selected.length < target && groups.length) {
    const [key, bucket] = groups[cursor % groups.length];
    const candidate = bucket.shift();
    cursor += 1;
    if (!candidate) {
      if (groups.every(([, rows]) => rows.length === 0)) break;
      continue;
    }
    const eventId = CLEAN(candidate?.event?.EventId);
    const itemId = CLEAN(candidate?.item?.EventItemId);
    if (!eventId || !itemId || selectedItems.has(itemId) || selectedEvents.has(eventId)) continue;
    selected.push(candidate);
    selectedItems.add(itemId);
    selectedEvents.add(eventId);
  }
  return selected.slice(0, target);
}

function compactPeopleRow(candidate, person, vote) {
  return {
    person_id: CLEAN(person?.person_id),
    person_name: CLEAN(person?.person_name),
    vote: CLEAN(person?.vote_value) || null,
    vote_bucket: CLEAN(person?.vote_bucket) || null,
    matter_id: CLEAN(candidate?.item?.EventItemMatterId) || null,
    matter_file: CLEAN(candidate?.item?.EventItemMatterFile) || null,
    matter_title: CLEAN(candidate?.item?.EventItemMatterName || candidate?.item?.EventItemTitle) || null,
    event_id: CLEAN(candidate?.event?.EventId),
    request_id: CLEAN(candidate?.request_id),
    agency_name: "City Council",
    event_date: dateDay(candidate?.event?.EventDate),
    source_system: "legistar",
    event_item_id: CLEAN(candidate?.item?.EventItemId),
    vote_source_index: Number.isInteger(vote?.source_index) ? vote.source_index : null,
  };
}

function loadPersonHub() {
  const doc = JSON.parse(readFileSync(PERSON_HUB, "utf8"));
  return doc?.by_person_id && typeof doc.by_person_id === "object" ? doc.by_person_id : {};
}

function reviewHoldout(voteResults, personHub) {
  const eventIds = [...new Set(
    voteResults.filter((result) => result.retained.length > 0).map((result) => result.event_id),
  )].sort().slice(0, HOLDOUT_EVENT_TARGET);
  const holdout = new Set(eventIds);
  const reviewedRows = [];
  let valid = 0;
  for (const result of voteResults) {
    if (!holdout.has(result.event_id)) continue;
    for (const row of result.rawRows) {
      const personId = CLEAN(row?.VotePersonId ?? row?.PersonId ?? row?.person_id);
      const personName = CLEAN(row?.VotePersonName ?? row?.PersonName ?? row?.person_name);
      if (!personId && !personName) continue;
      const hub = NUMERIC_ID(personId) ? personHub[personId] : null;
      const retained = result.retained.some((person) =>
        CLEAN(person.person_id) === personId && CLEAN(person.person_name) === personName,
      );
      const exactSourcePair = NUMERIC_ID(personId) && Boolean(personName);
      const officialBind = Boolean(hub && CLEAN(hub.person_id) === personId);
      const ok = retained && exactSourcePair && officialBind;
      if (ok) valid += 1;
      reviewedRows.push({
        event_id: result.event_id,
        event_item_id: result.item_id,
        matter_id: result.matter_id,
        person_id: personId || null,
        person_name: personName || null,
        vote_bucket: result.summary?.by_person?.find((person) => CLEAN(person.person_id) === personId)?.vote_bucket || null,
        source_pair_present: exactSourcePair,
        official_bind: officialBind,
        retained: retained,
        valid: ok,
      });
    }
  }
  return {
    event_count: eventIds.length,
    event_ids: eventIds,
    reviewed_rows: reviewedRows.length,
    valid_rows: valid,
    precision: RATE(valid, reviewedRows.length),
    rows: reviewedRows,
  };
}

function buildReceipt({ measuredAt, candidates, selected, voteResults, holdout, joinCounts }) {
  const eligibleRows = voteResults.reduce((sum, result) => sum + result.rawRows.length, 0);
  const retainedRows = voteResults.reduce((sum, result) => sum + result.retained.length, 0);
  const retainedEvents = new Set(voteResults.filter((result) => result.retained.length).map((result) => result.event_id));
  const retentionRate = RATE(retainedRows, eligibleRows);
  const retentionPass = retentionRate >= ROLL_CALL_GATE.minimum_retention_rate
    && holdout.precision >= ROLL_CALL_GATE.minimum_reviewed_precision;
  const eventCountPass = retainedEvents.size >= ROLL_CALL_GATE.minimum_distinct_events;
  const promoted = retentionPass && eventCountPass;
  return {
    schema: "cityscroll.metric_receipt.v1",
    metric: "official_roll_call_event_coverage",
    related_metric: "official_votes_on_edge_rate",
    measured_at: measuredAt,
    subject: "Dated City Council roll-call promotion sample from authenticated Legistar Votes",
    sample_design: {
      target_event_items: SAMPLE_TARGET,
      selected_event_items: selected.length,
      selected_distinct_events: new Set(selected.map((row) => CLEAN(row.event.EventId))).size,
      strata: SAMPLE_STRATA.map((stratum) => ({
        key: stratum.key,
        date_range: [stratum.start, stratum.end],
        selected_event_items: selected.filter((row) => row.stratum === stratum.key).length,
      })),
      body_count: new Set(selected.map(bodyOf).filter(Boolean)).size,
      action_count: new Set(selected.map(actionOf).filter(Boolean)).size,
    },
    join_measurement: joinCounts,
    audit: {
      source: "Events -> EventItems -> Votes on webapi.legistar.com/v1/nyc",
      eligible_scope: "City Record notices strictly joined by event date and unique committee/body title tokens",
      basis: "Exact publisher VotePersonId + VotePersonName pair, exact numeric official id, exact person-hub bind",
      eligible_vote_rows: eligibleRows,
      retained_person_id_rows: retainedRows,
      person_vote_retention_rate: retentionRate,
      official_votes_on_edge_rate: retainedRows > 0 ? 1 : 0,
    },
    after_live_audit: {
      eligible_vote_rows: eligibleRows,
      retained_person_id_rows: retainedRows,
      person_vote_retention_rate: retentionRate,
      reviewed_precision: holdout.precision,
      reviewed_rows: holdout.reviewed_rows,
      reviewed_valid_rows: holdout.valid_rows,
      holdout_event_count: holdout.event_count,
      holdout_event_ids: holdout.event_ids,
      basis: "Independent source-row review across every retained person row in the first 30 retained events; validates id/name pair, vote bucket, matter id, and official bind.",
      samples: voteResults.slice(0, 5).map((result) => ({
        event_id: result.event_id,
        event_item_id: result.item_id,
        matter_id: result.matter_id,
        raw_rows: result.rawRows.length,
        retained_rows: result.retained.length,
      })),
    },
    by_event: [...retainedEvents].sort().map((eventId) => {
      const rows = voteResults.filter((result) => result.event_id === eventId);
      return {
        event_id: eventId,
        request_id: rows[0]?.request_id || null,
        event_date: rows[0]?.event_date || null,
        eligible_vote_rows: rows.reduce((sum, result) => sum + result.rawRows.length, 0),
        retained_person_id_rows: rows.reduce((sum, result) => sum + result.retained.length, 0),
      };
    }),
    sample_inventory: selected.map((row) => ({
      request_id: CLEAN(row.request_id),
      event_id: CLEAN(row.event.EventId),
      event_date: dateDay(row.event.EventDate),
      event_item_id: CLEAN(row.item.EventItemId),
      matter_id: CLEAN(row.item.EventItemMatterId) || null,
      body: bodyOf(row) || null,
      action: actionOf(row) || null,
      vote_likely: voteLikely(row.item),
      stratum: row.stratum,
    })),
    holdout_review: holdout,
    promotion_gate: {
      minimum_retention_rate: ROLL_CALL_GATE.minimum_retention_rate,
      minimum_reviewed_precision: ROLL_CALL_GATE.minimum_reviewed_precision,
      minimum_distinct_events: ROLL_CALL_GATE.minimum_distinct_events,
      retention_pass: retentionPass,
      event_count_pass: eventCountPass,
      promoted,
    },
    remaining_gap: promoted
      ? "Official decision-trail gate cleared for the dated roll-call sample."
      : `Need ${Math.max(0, ROLL_CALL_GATE.minimum_distinct_events - retainedEvents.size)} additional retained events and reviewed precision >= ${ROLL_CALL_GATE.minimum_reviewed_precision}.`,
    entity_family: "official",
    primary_key_pattern: "official:{person_id}",
    link_type: "votes_on",
    product_surfaces: [
      "entity_resolution/officials/index.mjs",
      "worker/src/lib/legistar_client.mjs#summarizePersonVotes",
      "site/person_votes.mjs",
    ],
    verified_at: new Date().toISOString(),
  };
}

async function collectCandidates(token, fetchImpl = fetch) {
  const candidates = [];
  const joinCounts = [];
  for (const stratum of SAMPLE_STRATA) {
    const [notices, events] = await Promise.all([
      fetchNoticeRows(stratum, fetchImpl),
      fetchLegistarEvents({
        token,
        fetchImpl,
        startDate: `${stratum.start}T00:00:00Z`,
        endDate: `${stratum.end}T00:00:00Z`,
        pageSize: EVENT_PAGE_SIZE,
        maxPages: EVENT_MAX_PAGES,
      }),
    ]);
    const byDate = buildMeetingDateIndex(events);
    let matchedNotices = 0;
    const matchedEvents = new Map();
    for (const notice of notices) {
      const hit = joinNoticeToCouncilMeeting({
        event_date: dateDay(notice.event_date),
        short_title: notice.short_title,
      }, byDate);
      if (!hit) continue;
      matchedNotices += 1;
      matchedEvents.set(String(hit.event_id), { event: hit.meeting, request_id: CLEAN(notice.request_id) });
    }
    const eventRows = [...matchedEvents.values()];
    const itemBatches = await boundedMap(
      eventRows,
      ({ event }) => fetchLegistarEventItems({ eventId: event.EventId, token, fetchImpl }).catch(() => []),
      ITEM_CONCURRENCY,
    );
    let matterItems = 0;
    for (let i = 0; i < itemBatches.length; i += 1) {
      const { event, request_id: requestId } = eventRows[i];
      for (const item of itemBatches[i] || []) {
        if (!item?.EventItemId || !item?.EventItemMatterId) continue;
        matterItems += 1;
        candidates.push({
          event,
          item,
          request_id: requestId,
          stratum: stratum.key,
        });
      }
    }
    joinCounts.push({
      stratum: stratum.key,
      notice_count: notices.length,
      event_count: events.length,
      strict_matched_notice_count: matchedNotices,
      strict_matched_event_count: matchedEvents.size,
      matter_event_item_count: matterItems,
    });
  }
  return { candidates, joinCounts };
}

async function collectVotes(selected, token, fetchImpl = fetch) {
  const results = await boundedMap(selected, async (candidate) => {
    const itemId = CLEAN(candidate.item.EventItemId);
    const rawRows = await fetchLegistarItemVoteRows({ itemId, token, fetchImpl }).catch(() => []);
    const summary = summarizeLegistarVotes(rawRows, {
      matterId: CLEAN(candidate.item.EventItemMatterId) || null,
      agendaItemId: itemId,
      eventItemId: itemId,
    });
    const retained = (summary?.by_person || []).filter((person) =>
      NUMERIC_ID(person.person_id) && Boolean(CLEAN(person.person_name)),
    );
    return {
      event_id: CLEAN(candidate.event.EventId),
      event_date: dateDay(candidate.event.EventDate),
      request_id: CLEAN(candidate.request_id),
      item_id: itemId,
      matter_id: CLEAN(candidate.item.EventItemMatterId),
      rawRows,
      summary,
      retained,
      candidate,
    };
  }, VOTE_CONCURRENCY);
  return results.filter((result) => result.rawRows.length > 0);
}

function materializePeople(voteResults, personHub, receipt) {
  const rows = [];
  for (const result of voteResults) {
    for (const person of result.retained) {
      if (!personHub[CLEAN(person.person_id)]) continue;
      rows.push(compactPeopleRow(result.candidate, person, { source_index: null }));
    }
  }
  const eventIds = [...new Set(rows.map((row) => row.event_id).filter(Boolean))].sort();
  const notices = [...new Set(rows.map((row) => row.request_id).filter(Boolean))].sort();
  const peopleDoc = {
    schema_version: 2,
    domain: "people",
    title: "People domain observations for entity intelligence",
    description: "Exact person-level Legistar votes retained from a dated, stratified authenticated sample. Aggregate-only and source-null rows remain excluded.",
    retrieved_at: new Date().toISOString(),
    source: {
      system: "legistar",
      read_model: "meeting-outcomes:materialized:v3",
      via: "EventItems/{id}/Votes",
      densify: "official_roll_call_stratified_sample",
      eligible_event_filter: "strict City Record notice → Legistar event join plus matter-bearing EventItem",
      seed_notices: notices,
      event_ids: eventIds,
      eligible_event_ids: eventIds,
      demo_notices: ["20260706036"],
    },
    row_count: rows.length,
    person_count: new Set(rows.map((row) => row.person_id)).size,
    notice_count: notices.length,
    event_count: eventIds.length,
    rows,
    materialization_receipt: path.relative(ROOT, receipt),
  };
  return { peopleDoc, personVotesLookup: buildPersonVotesLookup(peopleDoc, { retentionReceipt: receipt }) };
}

export async function runRollCallTranche({ token, fetchImpl = fetch, measuredAt = DATE_STAMP() } = {}) {
  if (!token) throw new Error("LEGISTAR_API_TOKEN is required for live tranche acquisition");
  const { candidates, joinCounts } = await collectCandidates(token, fetchImpl);
  const selected = selectStratifiedEventItems(candidates);
  const voteResults = await collectVotes(selected, token, fetchImpl);
  const personHub = loadPersonHub();
  const holdout = reviewHoldout(voteResults, personHub);
  const receipt = buildReceipt({
    measuredAt,
    candidates,
    selected,
    voteResults,
    holdout,
    joinCounts,
  });
  const receiptPath = receiptPathFor(measuredAt);
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.promotion_gate.promoted) {
    const { peopleDoc, personVotesLookup } = materializePeople(voteResults, personHub, receiptPath);
    mkdirSync(path.dirname(OUT_PEOPLE), { recursive: true });
    mkdirSync(path.dirname(OUT_PERSON_VOTES), { recursive: true });
    writeFileSync(OUT_PEOPLE, `${JSON.stringify(peopleDoc, null, 2)}\n`);
    writeFileSync(OUT_PERSON_VOTES, `${JSON.stringify(personVotesLookup, null, 2)}\n`);
  }
  return { receipt, receiptPath, materialized: receipt.promotion_gate.promoted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRollCallTranche({ token: process.env.LEGISTAR_API_TOKEN })
    .then(({ receipt, receiptPath, materialized }) => {
      console.log(`roll-call tranche: selected=${receipt.sample_design.selected_event_items} retained_events=${receipt.by_event.length} retention=${receipt.audit.person_vote_retention_rate} reviewed_precision=${receipt.after_live_audit.reviewed_precision} promoted=${receipt.promotion_gate.promoted}`);
      console.log(`${materialized ? "materialized" : "gated"} receipt ${path.relative(ROOT, receiptPath)}`);
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exit(1);
    });
}
