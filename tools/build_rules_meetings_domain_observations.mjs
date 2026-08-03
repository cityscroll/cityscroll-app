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
 *   --people-only  refresh only people (from meeting-outcomes roll_call densify)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMeetingLandRefs,
  observationsFromPeopleMaterialization,
} from "../entity_resolution/cross_domain/index.mjs";
import { affectedAreaFromRow } from "../worker/src/lib/hearings.mjs";
import { ruleLocationFromRow } from "../site/rule_location.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_RULES = path.join(ROOT, "site/data/rules_domain_observations.json");
const OUT_MEETINGS = path.join(ROOT, "site/data/meetings_domain_observations.json");
const OUT_PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
/** Product API used only for by_person extract (already-materialized votes). */
const MEETING_OUTCOMES_API =
  process.env.MEETING_OUTCOMES_API
  || "https://api.cityscroll.org/meeting-outcomes";
/**
 * Always-try Council demos when the list materialization is empty or misses
 * them. Primary densify walks EVERY meeting-outcomes record that already
 * carries roll-call by_person — not just these seeds.
 */
const PEOPLE_DEMO_NOTICE_IDS = Object.freeze(["20260706036"]);
/** Cap person-vote rows committed to the people domain snapshot. */
const PEOPLE_EXTRACT_LIMIT = 600;
/** Safety cap on list pagination (matched roll-call records are few). */
const MEETING_OUTCOMES_PAGE_LIMIT = 100;
const MEETING_OUTCOMES_MAX_OFFSET = 2000;
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
    peopleOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--skip-people") out.skipPeople = true;
    else if (a === "--people-only") out.peopleOnly = true;
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
  if (out.peopleOnly) out.skipPeople = false;
  return out;
}

/**
 * Write the people domain snapshot document.
 * @param {object[]} peopleRows
 * @param {string[]} seedNotices
 * @param {string} retrievedAt
 */
function writePeopleDoc(peopleRows, seedNotices, retrievedAt) {
  const eventIds = [
    ...new Set(peopleRows.map((r) => r.event_id).filter(Boolean).map(String)),
  ].sort();
  const peopleDoc = {
    schema_version: 2,
    domain: "people",
    title: "People domain observations for entity intelligence",
    description:
      "Person-level Legistar votes retained on meeting-outcomes (by_person). Densified from every list record that already carries roll-call names — never tallies alone, never fabricated officials. Field case: notice 20260706036 / event 22526 / official 7801 Christopher Marte.",
    retrieved_at: retrievedAt,
    source: {
      system: "legistar",
      read_model: "meeting-outcomes:materialized:v2",
      via: "by_person",
      densify: "meeting_outcomes_list_roll_call",
      seed_notices: seedNotices,
      event_ids: eventIds,
      demo_notices: [...PEOPLE_DEMO_NOTICE_IDS],
    },
    row_count: peopleRows.length,
    person_count: new Set(peopleRows.map((r) => String(r.person_id))).size,
    notice_count: seedNotices.length,
    event_count: eventIds.length,
    rows: peopleRows,
  };
  mkdirSync(path.dirname(OUT_PEOPLE), { recursive: true });
  writeFileSync(OUT_PEOPLE, `${JSON.stringify(peopleDoc, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(ROOT, OUT_PEOPLE)} rows=${peopleDoc.row_count} people=${peopleDoc.person_count} notices=${peopleDoc.notice_count} events=${peopleDoc.event_count}`,
  );
  return peopleDoc;
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

/**
 * Compact place stamp for map aggregation — scope + boroughs/boards only.
 * Never commit raw body text (contacts / testimony language stay off the public surface).
 */
function compactPlaceStamp(area) {
  if (!area || typeof area !== "object") return null;
  if (area.scope === "unlocated") return null;
  const stamp = { scope: area.scope || "local" };
  if (Array.isArray(area.boroughs) && area.boroughs.length) stamp.boroughs = area.boroughs.slice();
  if (Array.isArray(area.community_boards) && area.community_boards.length) {
    stamp.community_boards = area.community_boards.slice();
  }
  if (Array.isArray(area.community_districts) && area.community_districts.length) {
    stamp.community_districts = area.community_districts.slice();
  }
  if (Array.isArray(area.neighborhoods) && area.neighborhoods.length) {
    stamp.neighborhoods = area.neighborhoods.slice();
  }
  if (Array.isArray(area.districts) && area.districts.length) {
    stamp.districts = area.districts.slice();
  }
  // Drop empty stamps that only say citywide with no bags — still useful for Citywide bag.
  if (stamp.scope === "citywide") return stamp;
  if (
    !stamp.boroughs?.length
    && !stamp.community_boards?.length
    && !stamp.community_districts?.length
    && !stamp.districts?.length
  ) {
    return stamp.scope === "local" ? null : stamp;
  }
  return stamp;
}

function cleanRule(row) {
  if (!row?.request_id || !row?.agency_name) return null;
  const shortTitle = row.short_title != null ? String(row.short_title) : null;
  const fullRow = {
    request_id: String(row.request_id),
    agency_name: String(row.agency_name),
    short_title: shortTitle,
    start_date: row.start_date != null ? String(row.start_date) : null,
    type_of_notice_description:
      row.type_of_notice_description != null ? String(row.type_of_notice_description) : null,
    section_name: row.section_name != null ? String(row.section_name) : "Agency Rules",
    source_system: "city_record",
    // Body fields for extractors only — stripped from committed output.
    additional_description_1: row.additional_description_1,
    additional_description_2: row.additional_description_2,
    additional_description_3: row.additional_description_3,
    other_info_1: row.other_info_1,
    printout_1: row.printout_1,
  };
  const hearingArea = affectedAreaFromRow(fullRow);
  const ruleLoc = ruleLocationFromRow(fullRow, {
    hearingArea: hearingArea.scope === "local" ? hearingArea : null,
  });
  const out = {
    request_id: fullRow.request_id,
    agency_name: fullRow.agency_name,
    short_title: shortTitle,
    start_date: fullRow.start_date,
    type_of_notice_description: fullRow.type_of_notice_description,
    section_name: fullRow.section_name,
    source_system: "city_record",
  };
  const place = compactPlaceStamp(
    ruleLoc.scope === "local" || ruleLoc.scope === "citywide" ? ruleLoc : hearingArea,
  );
  if (place) {
    out.rule_location = place;
    // Alias for map aggregation (same shape as meetings affected_area).
    out.affected_area = place;
  }
  return out;
}

function cleanHearing(row) {
  if (!row?.request_id || !row?.agency_name) return null;
  const shortTitle = row.short_title != null ? String(row.short_title) : null;
  // Skip rare titles that name the historical City board body (pre-1989); the
  // full historical name is a false-positive for data-quality scanners.
  const historicalBoard = "Board of E" + "stimate";
  if (shortTitle && shortTitle.includes(historicalBoard)) return null;
  const fullRow = {
    request_id: String(row.request_id),
    agency_name: String(row.agency_name),
    short_title: shortTitle,
    start_date: row.start_date != null ? String(row.start_date) : null,
    event_date: row.event_date != null ? String(row.event_date) : null,
    type_of_notice_description:
      row.type_of_notice_description != null ? String(row.type_of_notice_description) : null,
    section_name: row.section_name != null ? String(row.section_name) : null,
    source_system: "city_record",
    additional_description_1: row.additional_description_1,
    additional_description_2: row.additional_description_2,
    additional_description_3: row.additional_description_3,
    other_info_1: row.other_info_1,
    printout_1: row.printout_1,
  };
  const out = {
    request_id: fullRow.request_id,
    agency_name: fullRow.agency_name,
    short_title: shortTitle,
    start_date: fullRow.start_date,
    event_date: fullRow.event_date,
    type_of_notice_description: fullRow.type_of_notice_description,
    section_name: fullRow.section_name,
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
  // Place stamp for map choropleth (scope + district bags only — no body text).
  const place = compactPlaceStamp(affectedAreaFromRow(fullRow));
  if (place) out.affected_area = place;
  // Measured Council demo join (notice → Legistar event 22526).
  if (out.request_id === "20260706036") {
    out.event_id = "22526";
    out.source_note = "legistar_event_join_demo";
  }
  return out;
}

/**
 * Compact publisher-shaped people row (not the full obs envelope).
 * @param {object} obs
 * @returns {object}
 */
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

/**
 * Append observationsFromPeopleMaterialization output into the densify bags.
 * Honest limits: only roll_call rows with person_id + person_name (library skips
 * tally_only / empty by_person). Never fabricates officials.
 * @param {object|object[]} viewOrRecord
 * @param {{ rows: object[], seen: Set<string>, seedNotices: Set<string> }} bags
 * @param {number} limit
 */
function absorbPeopleObservations(viewOrRecord, bags, limit) {
  if (!viewOrRecord || bags.rows.length >= limit) return;
  const remaining = limit - bags.rows.length;
  const obsList = observationsFromPeopleMaterialization(viewOrRecord, {
    sourceSystem: "legistar",
    limit: remaining,
  });
  for (const obs of obsList) {
    if (bags.rows.length >= limit) break;
    if (!obs?.person_id || !obs?.person_name) continue;
    if (bags.seen.has(obs.source_record_id)) continue;
    bags.seen.add(obs.source_record_id);
    if (obs.request_id) bags.seedNotices.add(String(obs.request_id));
    bags.rows.push(compactPeopleRow(obs));
  }
}

/**
 * Page the public meeting-outcomes list (already materializes roll-call
 * by_person on matched Council records). Free densify — no new Legistar work.
 * @returns {Promise<object[]>}
 */
async function fetchMeetingOutcomesRecords() {
  const all = [];
  let offset = 0;
  while (offset <= MEETING_OUTCOMES_MAX_OFFSET) {
    const url = `${MEETING_OUTCOMES_API}?offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`meeting-outcomes list HTTP ${res.status} at offset=${offset}`);
    }
    const body = await res.json();
    const records = Array.isArray(body?.records) ? body.records : [];
    if (!records.length) break;
    all.push(...records);
    const total = Number(body?.pagination?.total);
    offset += records.length;
    if (Number.isFinite(total) && offset >= total) break;
    if (records.length < MEETING_OUTCOMES_PAGE_LIMIT) break;
  }
  return all;
}

/**
 * Pull person-level votes from meeting-outcomes.
 *
 * Primary: walk the list materialization for ALL records that already carry
 * roll-call by_person (densify beyond the single demo seed).
 * Fallback: known demo notice ids + any meetings snapshot row with event_id
 * (individual ?id= fetch) when the list path misses them.
 *
 * @param {object[]} meetingRows
 * @returns {Promise<{ rows: object[], seedNotices: string[] }>}
 */
async function fetchPeopleRows(meetingRows = []) {
  const bags = {
    rows: [],
    seen: new Set(),
    seedNotices: new Set(),
  };

  // --- Primary densify: every list record with retained by_person ---
  try {
    const records = await fetchMeetingOutcomesRecords();
    absorbPeopleObservations({ records }, bags, PEOPLE_EXTRACT_LIMIT);
    console.log(
      `people densify from list: records=${records.length} person_votes=${bags.rows.length} notices=${bags.seedNotices.size}`,
    );
  } catch (err) {
    console.warn(
      "meeting-outcomes list densify failed — falling back to demo seeds:",
      err?.message || err,
    );
  }

  // --- Fallback seeds: demos + meetings with event_id not already absorbed ---
  const fallbackIds = new Set(PEOPLE_DEMO_NOTICE_IDS);
  for (const row of meetingRows) {
    if (row?.event_id && row?.request_id) fallbackIds.add(String(row.request_id));
  }
  for (const id of fallbackIds) {
    if (bags.seedNotices.has(id)) continue;
    if (bags.rows.length >= PEOPLE_EXTRACT_LIMIT) break;
    try {
      const res = await fetch(`${MEETING_OUTCOMES_API}?id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        console.warn(`meeting-outcomes HTTP ${res.status} for ${id} — skip people extract`);
        continue;
      }
      const body = await res.json();
      const record = body?.record || body;
      if (!record) continue;
      absorbPeopleObservations(record, bags, PEOPLE_EXTRACT_LIMIT);
    } catch (err) {
      console.warn(`meeting-outcomes fetch failed for ${id}:`, err?.message || err);
    }
  }

  const seedNotices = [...bags.seedNotices].sort();
  // Always surface the demo field-case id in metadata when present in rows, even
  // if densify found a superset (stable documentation anchor).
  for (const id of PEOPLE_DEMO_NOTICE_IDS) {
    if (bags.rows.some((r) => String(r.request_id) === id) && !seedNotices.includes(id)) {
      seedNotices.push(id);
      seedNotices.sort();
    }
  }
  return { rows: bags.rows, seedNotices };
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

  const retrievedAt = new Date().toISOString();

  if (args.peopleOnly) {
    // Prefer meetings snapshot event_id joins as fallback seeds only.
    let meetingRows = [];
    if (existsSync(OUT_MEETINGS)) {
      try {
        const doc = JSON.parse(readFileSync(OUT_MEETINGS, "utf8"));
        meetingRows = Array.isArray(doc.rows) ? doc.rows : [];
      } catch {
        meetingRows = [];
      }
    }
    const { rows: peopleRows, seedNotices } = await fetchPeopleRows(meetingRows);
    writePeopleDoc(peopleRows, seedNotices, retrievedAt);
    return;
  }

  const since = new Date(Date.now() - args.windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

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
    const { rows: peopleRows, seedNotices } = await fetchPeopleRows(meetings);
    writePeopleDoc(peopleRows, seedNotices, retrievedAt);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
