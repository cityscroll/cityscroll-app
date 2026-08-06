#!/usr/bin/env node
/**
 * Build a broader live-legistar official roll-call tranche.
 *
 * The job is designed for CI operator execution with LEGISTAR_API_TOKEN set.
 * It materializes:
 * - site/data/people_domain_observations.json (exact numeric official ids only)
 * - site/data/person_votes_lookup.json (precomputed official index)
 * - a dated official_person_vote_retention receipt
 *
 * Identity boundary:
 * - exact numeric person ids only
 * - no fuzzy/name-only rows become facts
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMeetingOutcomesView } from "../worker/src/lib/meeting_outcomes.mjs";
import { observationsFromPeopleMaterialization } from "../entity_resolution/cross_domain/object_links.mjs";
import { buildPersonVotesLookup } from "../site/person_votes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const OUT_PERSON_VOTES = path.join(ROOT, "site/data/person_votes_lookup.json");
const RECEIPT_DIR = path.join(ROOT, "site/data/legistar_sources/verification_receipts");
const RETENTION_GATE = Object.freeze({
  minimum_retention_rate: 0.95,
  minimum_distinct_events: 30,
});
const PEOPLE_EXTRACT_LIMIT = 30_000;

const CLEAN = (value) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : value == null
      ? ""
      : String(value).trim();
const IS_EXACT_NUMERIC_ID = (value) => /^\d+$/.test(CLEAN(value));
const ROUND_RATE = (num, den) => den > 0 ? Number((num / den).toFixed(4)) : null;
const DATE_STAMP = () => new Date().toISOString().slice(0, 10);
const SAFE_STAMP = (value) => String(value || DATE_STAMP()).replace(/-/g, "_");

function receiptPathFor(date) {
  return path.join(RECEIPT_DIR, `official_person_vote_retention_${String(date).slice(0, 10)}.json`);
}

function buildLiveRollCallReceipt(view = {}, measuredAt = DATE_STAMP()) {
  const records = Array.isArray(view?.records) ? view.records : [];
  const byEvent = new Map();
  let retainedRows = 0;
  let eligibleRows = 0;
  const sampleRows = [];
  const matchedSamples = {
    retention_sample: null,
    event_matter_id: null,
  };

  for (const record of records) {
    if (!record?.join?.matched) continue;
    const eventId = CLEAN(record?.council_event?.event_id);
    const requestId = CLEAN(record?.request_id);
    if (!eventId) continue;

    const eventDate = CLEAN(record?.council_event?.event_date || record?.notice?.event_date);

    let eventEligibleRows = 0;
    let eventRetainedRows = 0;
    let eventFirstNumericPerson = null;

    for (const item of Array.isArray(record?.agenda_items) ? record.agenda_items : []) {
      const matters = Array.isArray(item?.matters) ? item.matters : [];
      for (const matter of matters) {
        if (!matter || !Array.isArray(matter?.votes) || !matter.votes.length) continue;
        const matterId = CLEAN(matter?.matter_id);
        for (const vote of matter.votes) {
          const eligible = Number(vote?.person_count);
          if (!Number.isFinite(eligible) || eligible <= 0) continue;

          const byPerson = Array.isArray(vote?.by_person) ? vote.by_person : [];
          const retained = byPerson.filter((person) => IS_EXACT_NUMERIC_ID(person?.person_id)).length;
          const eventPersonRows = byPerson.filter((person) => IS_EXACT_NUMERIC_ID(person?.person_id));
          if (!eventFirstNumericPerson && eventPersonRows.length > 0) {
            const first = eventPersonRows[0];
            eventFirstNumericPerson = {
              matter_id: matterId || null,
              person_name: CLEAN(first?.person_name || first?.VotePersonName || first?.PersonName),
              person_bucket: CLEAN(first?.vote_bucket || first?.VoteValueName || first?.VoteValue),
            };
            matchedSamples.event_matter_id = eventFirstNumericPerson.matter_id;
            if (!matchedSamples.retention_sample) {
              matchedSamples.retention_sample = {
                event_id: eventId,
                request_id: requestId,
                matter_id: eventFirstNumericPerson.matter_id,
                first_person: eventFirstNumericPerson.person_name,
                first_bucket: eventFirstNumericPerson.person_bucket,
              };
            }
          }

          eventEligibleRows += eligible;
          eventRetainedRows += retained;
          eligibleRows += eligible;
          retainedRows += retained;
        }
      }
    }

    if (eventEligibleRows > 0) {
      byEvent.set(eventId, {
        request_id: requestId,
        event_id: eventId,
        event_date: eventDate || null,
        eligible_vote_rows: eventEligibleRows,
        retained_person_id_rows: eventRetainedRows,
        person_vote_retention_rate: ROUND_RATE(eventRetainedRows, eventEligibleRows),
        sample_matter_id: eventFirstNumericPerson?.matter_id || null,
        first_person: eventFirstNumericPerson?.person_name || null,
        first_bucket: eventFirstNumericPerson?.person_bucket || null,
      });
    }
  }

  const byEventArray = [...byEvent.values()].sort((a, b) =>
    (b.event_date || "").localeCompare(a.event_date || "")
    || String(b.event_id).localeCompare(String(a.event_id))
  );
  for (let i = 0; i < byEventArray.length && sampleRows.length < 5; i++) {
    sampleRows.push({
      request_id: byEventArray[i].request_id,
      event_id: byEventArray[i].event_id,
      event_date: byEventArray[i].event_date,
      eligible_vote_rows: byEventArray[i].eligible_vote_rows,
      retained_person_id_rows: byEventArray[i].retained_person_id_rows,
      person_vote_retention_rate: byEventArray[i].person_vote_retention_rate,
      sample_matter_id: byEventArray[i].sample_matter_id,
      first_person: byEventArray[i].first_person,
      first_bucket: byEventArray[i].first_bucket,
    });
  }

  const eligibleEventCount = byEventArray.length;
  const retentionRate = ROUND_RATE(retainedRows, eligibleRows) || 0;
  const eventCountPass = eligibleEventCount >= RETENTION_GATE.minimum_distinct_events;
  const retentionPass = retentionRate >= RETENTION_GATE.minimum_retention_rate;
  const promoted = Boolean(eventCountPass && retentionPass);
  const eventRowsNeeded = Math.max(0, RETENTION_GATE.minimum_distinct_events - eligibleEventCount);
  const requiredRetainedRows = RETENTION_GATE.minimum_retention_rate > 0 && eligibleRows > 0
    ? Math.ceil(eligibleRows * RETENTION_GATE.minimum_retention_rate)
    : 0;
  const rowsNeeded = Math.max(0, requiredRetainedRows - retainedRows);
  const sampledEventId = matchedSamples.retention_sample?.event_id || "";
  const sampledNoticeId = matchedSamples.retention_sample?.request_id || "";

  return {
    schema: "cityscroll.metric_receipt.v1",
    metric: "official_roll_call_event_coverage",
    related_metric: "official_votes_on_edge_rate",
    measured_at: measuredAt,
    subject: "City Council roll-call person rows on live authenticated meeting-outcomes materialization",
    audit: {
      source: "Events -> EventItems -> Votes on webapi.legistar.com/v1/nyc",
      eligible_scope:
        "City Record public hearing notices joined to City Council events where meeting-outcomes includes matter vote summaries",
      basis:
        "Exact numeric person_id only; no fuzzy name-only identity rows are retained",
      sample: `events=${eligibleEventCount}, eligible_rows=${eligibleRows}, retained_rows=${retainedRows}`,
      finding:
        "Authenticated Events -> EventItems -> Votes fetch is the retention gate source.",
      sample_event_id: sampledEventId || "",
      sample_notice_id: sampledNoticeId || "",
      sample_event_item_id: null,
      sample_event_matter_id: matchedSamples.event_matter_id || null,
      raw_person_fields_present: ["VotePersonId", "VotePersonName"],
      raw_person_fields_absent: ["PersonId", "PersonName"],
      person_vote_retention_rate: retentionRate,
      official_votes_on_edge_rate: retainedRows > 0 ? 1 : 0,
      retained_person_id_rows: retainedRows,
      eligible_vote_rows: eligibleRows,
    },
    after_live_audit: {
      person_vote_retention_rate: retentionRate,
      official_votes_on_edge_rate: retainedRows > 0 ? 1 : 0,
      sample: `events=${eligibleEventCount}, eligible_rows=${eligibleRows}, retained_rows=${retainedRows}`,
      basis:
        "Authenticated Events -> EventItems -> Votes audit with strict numeric identity for person_id. Retention is per-row and denominators are published vote-row counts (person_count), not by_person counts.",
      samples: sampleRows,
      required_retained_rows_for_gate: requiredRetainedRows,
      retained_rows_shortfall: rowsNeeded,
    },
    [`after_live_audit_${SAFE_STAMP(measuredAt)}`]: {
      person_vote_retention_rate: retentionRate,
      official_votes_on_edge_rate: retainedRows > 0 ? 1 : 0,
      sample: `events=${eligibleEventCount}, eligible_rows=${eligibleRows}, retained_rows=${retainedRows}`,
      basis:
        "Authenticated Events -> EventItems -> Votes audit with strict numeric identity for person_id. Retention is per-row and denominators are published vote-row counts (person_count), not by_person counts.",
      samples: sampleRows,
      required_retained_rows_for_gate: requiredRetainedRows,
      retained_rows_shortfall: rowsNeeded,
    },
    by_event: byEventArray,
    source_count: {
      total_records: Array.isArray(records) ? records.length : 0,
      event_rows_with_retained_by_person: eligibleEventCount,
    },
    promotion_gate: {
      minimum_retention_rate: RETENTION_GATE.minimum_retention_rate,
      minimum_distinct_events: RETENTION_GATE.minimum_distinct_events,
      retention_pass: retentionPass,
      event_count_pass: eventCountPass,
      promoted,
    },
    remaining_gap: promoted
      ? "Official constellation gate cleared for both retention and event-count bars."
      : `Need ${eventRowsNeeded} additional eligible retained roll-call events and ${rowsNeeded} additional retained rows for 95% row retention.`,
    entity_family: "official",
    primary_key_pattern: "official:{person_id}",
    link_type: "votes_on",
    product_surfaces: [
      "entity_resolution/officials/index.mjs",
      "worker/src/lib/legistar_client.mjs#summarizePersonVotes",
      "worker/src/lib/meeting_outcomes.mjs",
      "entity_resolution/cross_domain/object_links.mjs",
    ],
    verified_at: new Date().toISOString(),
  };
}

function compactPeopleRow(obs) {
  return {
    person_id: obs.person_id,
    person_name: obs.person_name,
    vote: obs.vote,
    vote_bucket: obs.vote_bucket,
    matter_id: obs.matter_id,
    matter_file: obs.matter_file,
    matter_title: obs.matter_title,
    event_id: obs.event_id,
    request_id: obs.request_id,
    agency_name: obs.agency_name || "City Council",
    event_date: obs.when,
    source_system: "legistar",
  };
}

async function main() {
  const token = process.env.LEGISTAR_API_TOKEN;
  if (!token) {
    throw new Error("LEGISTAR_API_TOKEN is required for live tranche acquisition");
  }

  const measuredAt = DATE_STAMP();
  const view = await buildMeetingOutcomesView({ token, env: process.env });

  const receipt = buildLiveRollCallReceipt(view, measuredAt);
  const receiptPath = receiptPathFor(measuredAt);
  const eligibleEventIds = (receipt.by_event || []).map((event) => String(event.event_id).trim()).filter(Boolean);

  const observedPeople = observationsFromPeopleMaterialization(view, {
    sourceSystem: "legistar",
    limit: PEOPLE_EXTRACT_LIMIT,
  });
  const peopleRows = observedPeople
    .filter((obs) => obs && IS_EXACT_NUMERIC_ID(obs.person_id))
    .map(compactPeopleRow);
  const seedNotices = [...new Set(
    peopleRows.map((row) => CLEAN(row.request_id)).filter(Boolean),
  )].sort();
  const eventIds = [...new Set(peopleRows.map((row) => CLEAN(row.event_id)).filter(Boolean))].sort();

  const peopleDoc = {
    schema_version: 2,
    domain: "people",
    title: "People domain observations for entity intelligence",
    description:
      "Person-level Legistar votes retained on live authenticated meeting-outcomes materialization. This snapshot is filtered to exact numeric person ids only, and excludes fuzzy/name-only identity rows.",
    retrieved_at: new Date().toISOString(),
    source: {
      system: "legistar",
      read_model: "meeting-outcomes:materialized:v3",
      via: "by_person",
      densify: "meeting_outcomes_live_roll_call",
      eligible_event_filter: "city_council_roll_call_events_with_vote_rows",
      seed_notices: seedNotices,
      event_ids: eventIds,
      eligible_event_ids: [...new Set([...eligibleEventIds, ...eventIds])].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
      demo_notices: ["20260706036"],
    },
    row_count: peopleRows.length,
    person_count: new Set(peopleRows.map((row) => String(row.person_id))).size,
    notice_count: seedNotices.length,
    event_count: eventIds.length,
    rows: peopleRows,
  };

  const personVotesLookup = buildPersonVotesLookup(peopleDoc, {
    retentionReceipt: receipt,
  });

  mkdirSync(path.dirname(OUT_PEOPLE), { recursive: true });
  mkdirSync(path.dirname(OUT_PERSON_VOTES), { recursive: true });
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(OUT_PEOPLE, `${JSON.stringify(peopleDoc, null, 2)}\n`);
  writeFileSync(OUT_PERSON_VOTES, `${JSON.stringify(personVotesLookup, null, 2)}\n`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const retainedRate = receipt.after_live_audit?.person_vote_retention_rate;
  console.log(
    `roll-call tranche: eligible_events=${receipt.by_event?.length || 0}, eligible_rows=${receipt.audit?.eligible_vote_rows}, retained_rows=${receipt.audit?.retained_person_id_rows}, retention_rate=${retainedRate == null ? "n/a" : retainedRate}`,
  );
  console.log(`wrote receipt ${path.relative(ROOT, receiptPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
