#!/usr/bin/env node
/**
 * Kill sample + corpus census for meeting-person-votes credibility.
 *
 * Measures whether public meeting-outcomes materialization retains Legistar
 * person-level roll-call rows (by_person) when the publisher supplies them.
 * Usefulness ≥30% on the vote-bearing cohort and 95% person retention on
 * roll_call stages are the ship bars; empty by_person on voice/laid-over
 * hearings is honest absence, not a class-(b) "city does not publish" claim.
 *
 *   node tools/measure_meeting_person_votes.mjs --live
 *   node tools/measure_meeting_person_votes.mjs --check
 *   node tools/measure_meeting_person_votes.mjs --fixture
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_DIR = path.join(ROOT, "site/data/legistar_sources/verification_receipts");
const RECEIPT_PATH = path.join(RECEIPT_DIR, "meeting_person_votes_2026-08-11.json");
const API = process.env.MEETING_OUTCOMES_API || "https://api.cityscroll.org/meeting-outcomes";
const USEFULNESS = 0.3;
const PRECISION = 0.95;

const SCHEMA = "cityscroll.meeting_person_votes_receipt.v1";

function parseArgs(argv) {
  const out = { live: false, check: false, fixture: false, write: true };
  for (const a of argv) {
    if (a === "--live") out.live = true;
    else if (a === "--check") out.check = true;
    else if (a === "--fixture") out.fixture = true;
    else if (a === "--no-write") out.write = false;
  }
  return out;
}

function voteStats(record) {
  let rollCallStages = 0;
  let rollCallWithPeople = 0;
  let tallyOnlyStages = 0;
  let byPersonPeople = 0;
  let voteStages = 0;
  for (const item of record?.agenda_items || []) {
    for (const matter of item?.matters || []) {
      const votes = Array.isArray(matter.votes)
        ? matter.votes
        : (matter.votes ? [matter.votes] : []);
      for (const vote of votes) {
        if (!vote) continue;
        voteStages += 1;
        const people = Array.isArray(vote.by_person) ? vote.by_person : [];
        const hasPeople = people.some((p) => p?.person_id && p?.person_name);
        if (vote.vote_identity === "roll_call") {
          rollCallStages += 1;
          if (hasPeople) {
            rollCallWithPeople += 1;
            byPersonPeople += people.filter((p) => p?.person_id && p?.person_name).length;
          }
        } else if (vote.vote_identity === "tally_only") {
          tallyOnlyStages += 1;
        } else if (hasPeople) {
          rollCallStages += 1;
          rollCallWithPeople += 1;
          byPersonPeople += people.filter((p) => p?.person_id && p?.person_name).length;
        }
      }
    }
  }
  return {
    vote_stages: voteStages,
    roll_call_stages: rollCallStages,
    roll_call_with_people: rollCallWithPeople,
    tally_only_stages: tallyOnlyStages,
    by_person_people: byPersonPeople,
    has_by_person: byPersonPeople > 0,
    has_votes: voteStages > 0,
  };
}

export function measureMeetingPersonVotes(records = [], {
  observedAt = new Date().toISOString(),
  source = "fixture",
} = {}) {
  const matched = (records || []).filter((row) => row?.join?.matched === true);
  const rows = [];
  let withByPerson = 0;
  let withVotes = 0;
  let rollCallStages = 0;
  let rollCallWithPeople = 0;

  for (const record of matched) {
    const stats = voteStats(record);
    if (stats.has_votes) withVotes += 1;
    if (stats.has_by_person) withByPerson += 1;
    rollCallStages += stats.roll_call_stages;
    rollCallWithPeople += stats.roll_call_with_people;
    rows.push({
      request_id: String(record.request_id || record.notice?.request_id || ""),
      event_id: String(record.council_event?.event_id || record.event_id || "") || null,
      agency: String(record.notice?.agency || record.council_event?.body_name || "") || null,
      has_by_person: stats.has_by_person,
      has_votes: stats.has_votes,
      roll_call_stages: stats.roll_call_stages,
      by_person_people: stats.by_person_people,
    });
  }

  const usefulnessDenom = withVotes > 0 ? withVotes : matched.length;
  const usefulnessNum = withByPerson;
  const usefulnessRate = usefulnessDenom > 0 ? usefulnessNum / usefulnessDenom : 0;
  const retentionRate = rollCallStages > 0 ? rollCallWithPeople / rollCallStages : null;
  const matchedRate = matched.length > 0 ? withByPerson / matched.length : 0;
  const usefulnessPass = usefulnessRate >= USEFULNESS;
  const precisionPass = retentionRate == null ? false : retentionRate >= PRECISION;
  // Ship when vote-bearing cohort clears usefulness and every roll_call stage
  // retains persons. When no roll_call stages exist, do not invent a pass.
  const bridgeStatus = usefulnessPass && precisionPass
    ? "accepted"
    : (matched.length ? "stopped" : "empty");

  return {
    schema: SCHEMA,
    measured_at: observedAt.slice(0, 10),
    observed_at: observedAt,
    source: {
      system: "meeting-outcomes",
      read_model: "meeting-outcomes:materialized:v3",
      via: source,
      public_source: "Legistar EventItems/{id}/Votes",
    },
    thresholds: {
      usefulness: USEFULNESS,
      precision: PRECISION,
    },
    cohort: {
      total_records: (records || []).length,
      matched_council_notices: matched.length,
      matched_with_any_votes: withVotes,
      matched_with_by_person: withByPerson,
      roll_call_stages: rollCallStages,
      roll_call_with_people: rollCallWithPeople,
      distinct_roll_call_events: new Set(
        rows.filter((r) => r.has_by_person && r.event_id).map((r) => r.event_id),
      ).size,
    },
    rates: {
      by_person_of_matched: Number(matchedRate.toFixed(4)),
      by_person_of_vote_bearing: withVotes > 0
        ? Number((withByPerson / withVotes).toFixed(4))
        : null,
      roll_call_person_retention: retentionRate == null
        ? null
        : Number(retentionRate.toFixed(4)),
    },
    bridge_status: bridgeStatus,
    usefulness_pass: usefulnessPass,
    precision_pass: precisionPass,
    policy: {
      empty_by_person_without_roll_call: "honest_absence",
      invent_persons: false,
      class_b_not_published_for_empty_by_person: false,
      reader_register:
        "Show named roll call when by_person is retained; omit the person panel when the publisher issued no roll call.",
    },
    sample_notices: rows
      .filter((r) => r.has_by_person)
      .map((r) => r.request_id)
      .filter(Boolean)
      .sort(),
    rows,
    verdict: {
      credibility_red_flag: false,
      classification: bridgeStatus === "accepted" ? "healthy" : "investigate",
      note: bridgeStatus === "accepted"
        ? "Person votes retain when Legistar publishes roll call; empty by_person is not a false city-does-not-publish mask."
        : "Below usefulness or precision bar — do not claim citywide person roll call.",
    },
  };
}

async function fetchAllRecords() {
  const all = [];
  let offset = 0;
  while (offset < 2000) {
    const res = await fetch(`${API}?limit=100&offset=${offset}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`meeting-outcomes HTTP ${res.status} at offset=${offset}`);
    const body = await res.json();
    const page = Array.isArray(body?.records) ? body.records : [];
    all.push(...page);
    offset += page.length;
    const total = Number(body?.pagination?.total || 0);
    if (!page.length || (Number.isFinite(total) && offset >= total)) break;
  }
  return all;
}

function loadFixtureRecords() {
  const fixturePath = path.join(
    ROOT,
    "worker/test/fixtures/entity-intelligence/meeting_outcomes_materialized_v2.json",
  );
  if (!existsSync(fixturePath)) {
    throw new Error(`missing fixture ${path.relative(ROOT, fixturePath)}`);
  }
  const doc = JSON.parse(readFileSync(fixturePath, "utf8"));
  return Array.isArray(doc.records) ? doc.records : [];
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    if (!existsSync(RECEIPT_PATH)) {
      console.error(`missing ${path.relative(ROOT, RECEIPT_PATH)}`);
      process.exit(1);
    }
    const receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
    if (receipt.schema !== SCHEMA) {
      console.error(`unexpected schema ${receipt.schema}`);
      process.exit(1);
    }
    if (receipt.bridge_status !== "accepted") {
      console.error(`bridge_status is ${receipt.bridge_status}, expected accepted`);
      process.exit(1);
    }
    if (!receipt.usefulness_pass || !receipt.precision_pass) {
      console.error("receipt failed usefulness or precision gate");
      process.exit(1);
    }
    if (receipt.verdict?.credibility_red_flag) {
      console.error("receipt still marks a credibility red flag");
      process.exit(1);
    }
    console.log(
      `ok ${path.relative(ROOT, RECEIPT_PATH)} by_person_of_vote_bearing=${receipt.rates?.by_person_of_vote_bearing} retention=${receipt.rates?.roll_call_person_retention}`,
    );
    return;
  }

  const run = async () => {
    let records;
    let source;
    if (args.live) {
      records = await fetchAllRecords();
      source = "live_api";
    } else {
      records = loadFixtureRecords();
      source = "fixture";
    }
    const measured = measureMeetingPersonVotes(records, {
      observedAt: "2026-08-11T18:00:00.000Z",
      source,
    });

    if (args.write && args.live) {
      mkdirSync(RECEIPT_DIR, { recursive: true });
      writeFileSync(RECEIPT_PATH, `${JSON.stringify(measured, null, 2)}\n`);
      console.log(`wrote ${path.relative(ROOT, RECEIPT_PATH)}`);
    }

    console.log(JSON.stringify({
      bridge_status: measured.bridge_status,
      cohort: measured.cohort,
      rates: measured.rates,
      usefulness_pass: measured.usefulness_pass,
      precision_pass: measured.precision_pass,
      sample_notices: measured.sample_notices,
    }, null, 2));

    if (args.live && measured.bridge_status !== "accepted") {
      process.exitCode = 2;
    }
  };

  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
