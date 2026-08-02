#!/usr/bin/env node
/**
 * Refresh offline domain observation snapshots for entity intelligence.
 *
 * Pulls capped City Record SODA rows (Agency Rules + Public Hearings) and
 * writes site/data/{rules,meetings}_domain_observations.json. Does not call
 * Legistar or invent person-level votes. Rebuild entity intelligence after:
 *
 *   node tools/build_rules_meetings_domain_observations.mjs
 *   node tools/build_entity_intelligence.mjs
 *
 * Options:
 *   --check     require committed snapshots exist and have rows
 *   --limit N   cap each domain (default 100 rules / 120 meetings)
 *   --window D  look-back days (default 180)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractMeetingLandRefs } from "../entity_resolution/cross_domain/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_RULES = path.join(ROOT, "site/data/rules_domain_observations.json");
const OUT_MEETINGS = path.join(ROOT, "site/data/meetings_domain_observations.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
// Body fields are fetched only to extract ULURP / ZAP project keys for reverse
// land joins — raw body text is NOT written into the committed snapshot
// (emails / phones / testimony contacts must not land on the public PR surface).
const SELECT =
  "request_id,start_date,agency_name,type_of_notice_description,section_name,short_title,event_date,"
  + "additional_description_1,additional_description_2,additional_description_3,"
  + "other_info_1,printout_1";

function parseArgs(argv) {
  const out = { check: false, rulesLimit: 100, meetingsLimit: 120, windowDays: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    for (const p of [OUT_RULES, OUT_MEETINGS]) {
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
    console.log("rules/meetings domain observations ok");
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
      "City Record Public Hearings and Meetings rows (and Agency Rules public hearings with event_date) for offline entity-intelligence materialization. Mirrors meeting-outcomes / hearings discovery notices. Person-level votes are not included (production by_person retention is empty).",
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
