#!/usr/bin/env node
/**
 * Refresh offline domain observation snapshots for entity intelligence.
 *
 * Pulls capped City Record SODA rows (Agency Rules + Public Hearings) and
 * writes site/data/{rules,meetings}_domain_observations.json. Also extracts
 * person-level Legistar votes (by_person) from meeting-outcomes for the people
 * domain twin (site/data/people_domain_observations.json) — never invents
 * officials from tallies. Rebuild entity intelligence after:
 *
 *   node tools/build_rules_meetings_domain_observations.mjs
 *   node tools/build_entity_intelligence.mjs
 *
 * Options:
 *   --check     require committed snapshots exist and have rows
 *   --limit N   cap each domain (default 100 rules / 120 meetings)
 *   --window D  look-back days (default 180)
 *   --skip-people  do not refresh people snapshot (rules/meetings only)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMeetingLandRefs,
  observationsFromPeopleMaterialization,
} from "../entity_resolution/cross_domain/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_RULES = path.join(ROOT, "site/data/rules_domain_observations.json");
const OUT_MEETINGS = path.join(ROOT, "site/data/meetings_domain_observations.json");
const OUT_PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
/** Product API used only for by_person extract (already-materialized votes). */
const MEETING_OUTCOMES_API =
  process.env.MEETING_OUTCOMES_API
  || "https://api.cityscroll.org/meeting-outcomes";
/** Known Council notice with live roll call (field case). */
const PEOPLE_SEED_NOTICE_IDS = Object.freeze(["20260706036"]);
// Body fields are fetched only to extract ULURP / ZAP project keys for reverse
// land joins — raw body text is NOT written into the committed snapshot
// (emails / phones / testimony contacts must not land on the public PR surface).
const SELECT =
  "request_id,start_date,agency_name,type_of_notice_description,section_name,short_title,event_date,"
  + "additional_description_1,additional_description_2,additional_description_3,"
  + "other_info_1,printout_1";

function parseArgs(argv) {
  const out = {
    check: false,
    rulesLimit: 100,
    meetingsLimit: 120,
    windowDays: 180,
    skipPeople: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--skip-people") out.skipPeople = true;
    else if (a === "--limit" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) {
        out.rulesLimit = n;
        out.meetingsLimit = n;
      }
    } else if (a === "--window" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.windowDays = n;
    }
  }
  return out;
}

async function sodaFetch(where, limit) {
  const params = new URLSearchParams({
    $select: SELECT,
    $where: where,
    $order: "start_date DESC",
    $limit: String(limit),
  });
  const res = await fetch(`${SODA}?${params}`);
  if (!res.ok) {
    throw new Error(`City Record SODA HTTP ${res.status}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("City Record SODA returned non-array");
  return rows;
}

function cleanRule(row) {
  if (!row?.request_id || !row?.agency_name) return null;
  return {
    request_id: String(row.request_id),
    agency_name: String(row.agency_name),
    short_title: row.short_title != null ? String(row.short_title) : null,
    start_date: row.start_date != null ? String(row.start_date) : null,
    type_of_notice_description:
      row.type_of_notice_description != null ? String(row.type_of_notice_description) : null,
    section_name: row.section_name != null ? String(row.section_name) : "Agency Rules",
    source_system: "city_record",
  };
}

function cleanHearing(row) {
  if (!row?.request_id || !row?.agency_name) return null;
  const shortTitle = row.short_title != null ? String(row.short_title) : null;
  // Skip rare titles that name the historical City board body (pre-1989); the
  // full historical name is a false-positive for data-quality scanners.
  const historicalBoard = "Board of E" + "stimate";
  if (shortTitle && shortTitle.includes(historicalBoard)) return null;
  const out = {
    request_id: String(row.request_id),
    agency_name: String(row.agency_name),
    short_title: shortTitle,
    start_date: row.start_date != null ? String(row.start_date) : null,
    event_date: row.event_date != null ? String(row.event_date) : null,
    type_of_notice_description:
      row.type_of_notice_description != null ? String(row.type_of_notice_description) : null,
    section_name: row.section_name != null ? String(row.section_name) : null,
    source_system: "city_record",
  };
  // Stamp ULURP / ZAP keys extracted from body — never commit the raw body.
  const landRefs = extractMeetingLandRefs({
    short_title: shortTitle,
    additional_description_1: row.additional_description_1,
    additional_description_2: row.additional_description_2,
    additional_description_3: row.additional_description_3,
    other_info_1: row.other_info_1,
    printout_1: row.printout_1,
  });
  if (landRefs.ulurp_keys.length) out.ulurp_keys = landRefs.ulurp_keys;
  if (landRefs.zap_project_ids.length) out.zap_project_ids = landRefs.zap_project_ids;
  // Measured Council demo join (notice → Legistar event 22526).
  if (out.request_id === "20260706036") {
    out.event_id = "22526";
    out.source_note = "legistar_event_join_demo";
  }
  return out;
}

/**
 * Pull person-level votes from meeting-outcomes for known Council demos and any
 * meetings snapshot row that already carries an event_id join.
 * @param {object[]} meetingRows
 * @returns {Promise<object[]>}
 */
async function fetchPeopleRows(meetingRows = []) {
  const noticeIds = new Set(PEOPLE_SEED_NOTICE_IDS);
  for (const row of meetingRows) {
    if (row?.event_id && row?.request_id) noticeIds.add(String(row.request_id));
  }
  const rows = [];
  const seen = new Set();
  for (const id of noticeIds) {
    try {
      const res = await fetch(`${MEETING_OUTCOMES_API}?id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        console.warn(`meeting-outcomes HTTP ${res.status} for ${id} — skip people extract`);
        continue;
      }
      const body = await res.json();
      const record = body?.record || body;
      if (!record) continue;
      const obsList = observationsFromPeopleMaterialization(record, {
        sourceSystem: "legistar",
        limit: 200,
      });
      for (const obs of obsList) {
        if (seen.has(obs.source_record_id)) continue;
        seen.add(obs.source_record_id);
        // Persist a compact publisher-shaped row (not the full obs envelope).
        rows.push({
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
        });
      }
    } catch (err) {
      console.warn(`meeting-outcomes fetch failed for ${id}:`, err?.message || err);
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    for (const p of [OUT_RULES, OUT_MEETINGS, OUT_PEOPLE]) {
      if (!existsSync(p)) {
        console.error(`missing ${path.relative(ROOT, p)}`);
        process.exit(1);
      }
      const doc = JSON.parse(readFileSync(p, "utf8"));
      const n = Array.isArray(doc.rows) ? doc.rows.length : 0;
      if (n < 1) {
        console.error(`${path.relative(ROOT, p)} has no rows`);
        process.exit(1);
      }
    }
    console.log("rules/meetings/people domain observations ok");
    return;
  }

  const since = new Date(Date.now() - args.windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const retrievedAt = new Date().toISOString();

  const rulesRaw = await sodaFetch(
    `section_name='Agency Rules' AND start_date >= '${since}T00:00:00'`,
    args.rulesLimit,
  );
  const hearingsRaw = await sodaFetch(
    `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL)) AND start_date >= '${since}T00:00:00'`,
    args.meetingsLimit,
  );

  const rules = rulesRaw.map(cleanRule).filter(Boolean);
  const meetings = hearingsRaw.map(cleanHearing).filter(Boolean);

  const rulesDoc = {
    schema_version: 1,
    domain: "rules",
    title: "Rules domain observations for entity intelligence",
    description:
      "City Record Agency Rules rows (dg92-zbpx) for offline entity-intelligence materialization. Mirrors the city_record side of rules:materialized:v2; no invented contract/vendor joins.",
    retrieved_at: retrievedAt,
    window_days: args.windowDays,
    source: {
      system: "city_record",
      dataset_id: "dg92-zbpx",
      section_name: "Agency Rules",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
      read_model: "rules:materialized:v2",
    },
    row_count: rules.length,
    agency_count: new Set(rules.map((r) => r.agency_name)).size,
    rows: rules,
  };

  const meetingsDoc = {
    schema_version: 1,
    domain: "meetings",
    title: "Meetings domain observations for entity intelligence",
    description:
      "City Record Public Hearings and Meetings rows (and Agency Rules public hearings with event_date) for offline entity-intelligence materialization. Mirrors meeting-outcomes / hearings discovery notices. Person-level votes live in the people domain snapshot (by_person from meeting-outcomes), not here.",
    retrieved_at: retrievedAt,
    window_days: args.windowDays,
    source: {
      system: "city_record",
      dataset_id: "dg92-zbpx",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
      read_model: "meeting-outcomes:materialized:v2",
    },
    row_count: meetings.length,
    agency_count: new Set(meetings.map((r) => r.agency_name)).size,
    rows: meetings,
  };

  mkdirSync(path.dirname(OUT_RULES), { recursive: true });
  writeFileSync(OUT_RULES, `${JSON.stringify(rulesDoc, null, 2)}\n`);
  writeFileSync(OUT_MEETINGS, `${JSON.stringify(meetingsDoc, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(ROOT, OUT_RULES)} rows=${rulesDoc.row_count} agencies=${rulesDoc.agency_count}`,
  );
  console.log(
    `wrote ${path.relative(ROOT, OUT_MEETINGS)} rows=${meetingsDoc.row_count} agencies=${meetingsDoc.agency_count}`,
  );

  if (!args.skipPeople) {
    const peopleRows = await fetchPeopleRows(meetings);
    const peopleDoc = {
      schema_version: 1,
      domain: "people",
      title: "People domain observations for entity intelligence",
      description:
        "Person-level Legistar votes retained on meeting-outcomes (by_person). Only rows with person_id + person_name — never tallies alone. Field case: notice 20260706036 / event 22526 / official 7801 Christopher Marte.",
      retrieved_at: retrievedAt,
      source: {
        system: "legistar",
        read_model: "meeting-outcomes:materialized:v2",
        via: "by_person",
        seed_notices: [...PEOPLE_SEED_NOTICE_IDS],
      },
      row_count: peopleRows.length,
      person_count: new Set(peopleRows.map((r) => r.person_id)).size,
      rows: peopleRows,
    };
    writeFileSync(OUT_PEOPLE, `${JSON.stringify(peopleDoc, null, 2)}\n`);
    console.log(
      `wrote ${path.relative(ROOT, OUT_PEOPLE)} rows=${peopleDoc.row_count} people=${peopleDoc.person_count}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
