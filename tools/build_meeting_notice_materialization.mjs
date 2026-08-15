#!/usr/bin/env node

/**
 * Build the complete current City Record meeting notice input used by the
 * static meeting read model. The meeting route consumes only the committed
 * artifact; this script is the source refresh operation.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceSignalsFromHtml } from "../site/hearing_logistics.mjs";
import { CITY_RECORD_MEETING_PREDICATE, eligibleCityRecordMeetings } from "../site/city_record_meeting.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "site/data/meeting_notice_materialization.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const CITY_RECORD_SOURCE_URL = "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx";
const DETAIL_HOST = "https://a856-cityrecord.nyc.gov/RequestDetail/";
const SELECT = [
  "request_id", "start_date", "event_date", "agency_name", "type_of_notice_description",
  "section_name", "short_title", "street_address_1", "street_address_2", "building_name",
  "city", "state", "zip_code", "additional_description_1", "additional_description_2",
  "additional_description_3", "other_info_1", "other_info_2", "other_info_3", "printout_1",
  "printout_2", "printout_3", "contact_name", "contact_phone", "email", "address_to_request",
  "category_description", "selection_method_description", "document_links",
].join(",");

function asOf(argv) {
  const index = argv.indexOf("--as-of");
  const value = index >= 0 ? argv[index + 1] : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("--as-of must be YYYY-MM-DD");
  return value;
}

function outputRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

async function fetchCityRecordRows(date) {
  const rows = [];
  for (let offset = 0; ; offset += 1_000) {
    const url = new URL(SODA);
    url.searchParams.set("$select", SELECT);
    url.searchParams.set(
      "$where",
      `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings')) AND event_date >= '${date}T00:00:00'`,
    );
    url.searchParams.set("$order", "event_date ASC, request_id ASC");
    url.searchParams.set("$limit", "1000");
    url.searchParams.set("$offset", String(offset));
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`City Record SODA HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("City Record SODA returned a non-array");
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
}

async function enrichNotice(row) {
  const id = String(row.request_id || "").trim();
  if (!id) return row;
  try {
    const sourceUrl = `${DETAIL_HOST}${encodeURIComponent(id)}`;
    const response = await fetch(sourceUrl, { headers: { Accept: "text/html" } });
    if (!response.ok) return row;
    const signals = sourceSignalsFromHtml(await response.text(), sourceUrl);
    const attachments = signals.sourceLinks.filter((url) => /\/Search\/GetFile\?/i.test(url));
    return {
      ...row,
      ...(row.additional_description_1 || !signals.body ? {} : { additional_description_1: signals.body }),
      ...(signals.sourceLinks.length ? { source_links: signals.sourceLinks } : {}),
      ...(attachments.length && !row.document_links ? { document_links: attachments } : {}),
    };
  } catch {
    return row;
  }
}

async function refresh(date) {
  const fetched = await fetchCityRecordRows(date);
  const eligible = eligibleCityRecordMeetings(fetched);
  const enriched = [];
  for (let index = 0; index < eligible.length; index += 4) {
    enriched.push(...await Promise.all(eligible.slice(index, index + 4).map(enrichNotice)));
  }
  const generatedAt = new Date().toISOString();
  return {
    schema: "cityscroll.city_record_meeting_notice_materialization.v1",
    generated_at: generatedAt,
    as_of: date,
    source: {
      system: "city_record",
      dataset_id: "dg92-zbpx",
      url: CITY_RECORD_SOURCE_URL,
      detail_url_template: `${DETAIL_HOST}{request_id}`,
      delivery: "build-time",
    },
    predicate: CITY_RECORD_MEETING_PREDICATE,
    row_count: enriched.length,
    rows: enriched,
  };
}

const check = process.argv.includes("--check");
const date = asOf(process.argv.slice(2));
if (check) {
  if (!existsSync(OUT)) throw new Error(`missing ${OUT}`);
  const artifact = JSON.parse(readFileSync(OUT, "utf8"));
  const rows = eligibleCityRecordMeetings(outputRows(artifact));
  if (!rows.length || rows.length !== artifact.row_count) throw new Error("meeting notice materialization is empty or predicate coverage drifted");
  console.log(`Meeting notice materialization is current rows=${rows.length} as_of=${artifact.as_of}`);
} else {
  const artifact = await refresh(date);
  writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote ${OUT} rows=${artifact.row_count} as_of=${artifact.as_of}`);
}
