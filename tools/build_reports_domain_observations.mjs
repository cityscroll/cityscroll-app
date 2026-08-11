#!/usr/bin/env node
/**
 * Densify report / study / plan City Record observations for mandate
 * filing-receipt joins.
 *
 *   node tools/build_reports_domain_observations.mjs
 *   node tools/build_reports_domain_observations.mjs --check
 *   node tools/build_reports_domain_observations.mjs --from-fixture
 *   node tools/build_reports_domain_observations.mjs --limit 200 --window 900
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  REPORTS_DOMAIN_SCHEMA,
  buildReportsDomainDocument,
  isReportPublicationRow,
} from "../site/reports_domain_observations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/reports_domain_observations.json");
const FIXTURE = join(ROOT, "test/fixtures/reports_domain_observations.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const SELECT = [
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "section_name",
  "short_title",
  "additional_description_1",
  "additional_description_2",
].join(",");

function parseArgs(argv) {
  const out = { check: false, fromFixture: false, limit: 250, windowDays: 900 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--from-fixture") out.fromFixture = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]) || 250;
    else if (argv[i] === "--window") out.windowDays = Number(argv[++i]) || 900;
  }
  return out;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function sodaFetch(where, limit) {
  const url = new URL(SODA);
  url.searchParams.set("$select", SELECT);
  url.searchParams.set("$where", where);
  url.searchParams.set("$order", "start_date DESC");
  url.searchParams.set("$limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`City Record SODA HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("City Record SODA returned non-array");
  return rows;
}

async function fetchReportRows({ limit, windowDays }) {
  const since = isoDaysAgo(windowDays);
  // Two narrow SoQL windows — pure isReportPublicationRow is the final gate.
  const windows = [
    `start_date > '${since}' AND upper(section_name) = 'SPECIAL MATERIALS'`,
    `start_date > '${since}' AND upper(short_title) like '%ANNUAL REPORT%'`,
  ];
  const byId = new Map();
  for (const where of windows) {
    const raw = await sodaFetch(where, Math.max(limit, 100));
    for (const row of raw) {
      if (!row?.request_id || byId.has(String(row.request_id))) continue;
      if (!isReportPublicationRow(row)) continue;
      byId.set(String(row.request_id), row);
    }
  }
  return [...byId.values()]
    .sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")))
    .slice(0, limit);
}

export function writeReportsDomainArtifacts({
  check = false,
  fromFixture = false,
  limit = 250,
  windowDays = 900,
  rows = null,
} = {}) {
  return (async () => {
    if (check) {
      if (!existsSync(OUT)) {
        console.error("missing site/data/reports_domain_observations.json");
        process.exit(1);
      }
      const doc = JSON.parse(readFileSync(OUT, "utf8"));
      if (doc.schema !== REPORTS_DOMAIN_SCHEMA) {
        console.error(`unexpected schema ${doc.schema}`);
        process.exit(1);
      }
      if (!Array.isArray(doc.rows) || doc.rows.length < 1) {
        console.error("reports_domain_observations has no rows");
        process.exit(1);
      }
      console.log(
        `ok reports_domain_observations rows=${doc.row_count} agencies=${doc.agency_count}`,
      );
      return doc;
    }

    let sourceRows = rows;
    let sourceMeta = null;
    if (!sourceRows) {
      if (fromFixture) {
        if (!existsSync(FIXTURE)) {
          throw new Error(`missing fixture ${FIXTURE}`);
        }
        const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
        sourceRows = Array.isArray(fixture.rows) ? fixture.rows : fixture;
        sourceMeta = { system: "fixture", path: "test/fixtures/reports_domain_observations.json" };
      } else {
        sourceRows = await fetchReportRows({ limit, windowDays });
        sourceMeta = {
          system: "city_record",
          dataset: "dg92-zbpx",
          window_days: windowDays,
          limit,
        };
      }
    }

    const doc = buildReportsDomainDocument(sourceRows, {
      retrievedAt: new Date().toISOString(),
      windowDays,
      source: sourceMeta,
    });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(
      `wrote site/data/reports_domain_observations.json rows=${doc.row_count} agencies=${doc.agency_count}`,
    );
    return doc;
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeReportsDomainArtifacts(parseArgs(process.argv)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
