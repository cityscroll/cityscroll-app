#!/usr/bin/env node
/**
 * Materialize basis-labeled contract response locations.
 *
 * City Record action addresses are fetched for the committed default contract
 * cohort, resolved through the repo's existing NYC GeoSearch pattern, then
 * joined to the committed community/council boundary layer. The output is a
 * supplemental response-logistics layer; it never overwrites performance place.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_LOCATION_BASES,
  actionAddressCandidates,
  buildContractActionLocationRow,
  pickGeoSearchMatch,
} from "../site/contract_action_location.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_PATH = join(ROOT, "site/data/money_default_open.json");
const MONEY_PATH = join(ROOT, "site/data/money_domain_observations.json");
const BOUNDARIES_PATH = join(ROOT, "site/data/district_boundaries.json");
const OUT = join(ROOT, "site/data/contract_action_address_locations.json");
const RECEIPT = join(ROOT, "docs/evidence/contracts-action-address-geo/join_receipt.json");
const CITY_RECORD = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";

const DETAIL_FIELDS = [
  "request_id", "start_date", "due_date", "agency_name", "section_name",
  "type_of_notice_description", "category_description", "short_title", "pin",
  "selection_method_description", "address_to_request", "additional_description_1",
  "additional_description_2", "additional_description_3", "other_info_1",
  "other_info_2", "other_info_3",
].join(",");

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  return { check: argv.includes("--check") };
}

function quoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function fetchCityRecordRows(ids) {
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 40) {
    const batch = ids.slice(offset, offset + 40);
    const params = new URLSearchParams({
      "$select": DETAIL_FIELDS,
      "$where": `request_id in(${batch.map(quoted).join(",")})`,
      "$limit": String(batch.length),
    });
    const response = await fetch(`${CITY_RECORD}?${params}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityScroll-contract-action-location/1.0 (+https://cityscroll.org)",
      },
    });
    if (!response.ok) throw new Error(`City Record HTTP ${response.status}`);
    rows.push(...await response.json());
  }
  const byId = new Map(rows.map((row) => [row.request_id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeCandidates(rows) {
  const unique = new Map();
  for (const row of rows) {
    for (const item of actionAddressCandidates(row)) {
      if (!unique.has(item.normalized)) unique.set(item.normalized, item);
    }
  }
  const geocodes = new Map();
  let first = true;
  for (const item of unique.values()) {
    if (item.jurisdiction === "outside_nyc") continue;
    if (!first) await delay(150);
    first = false;
    const params = new URLSearchParams({ size: "5", text: item.address });
    const response = await fetch(`${GEOSEARCH}?${params}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityScroll-contract-action-location/1.0 (+https://cityscroll.org)",
      },
    });
    if (!response.ok) continue;
    const payload = await response.json();
    const match = pickGeoSearchMatch(item, payload.features || []);
    if (match) geocodes.set(item.normalized, match);
  }
  return geocodes;
}

function countBy(items, keyFn) {
  const out = Object.create(null);
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function sourceInventory(rows) {
  const raw = (rows || []).filter((row) => String(row.address_to_request || "").trim());
  const rejected = raw.filter((row) => !actionAddressCandidates(row)
    .some((item) => item.basis === ACTION_LOCATION_BASES.SUBMISSION));
  const reason = (value) => {
    const text = String(value || "").trim();
    if (/^\.$|^-+$|^n\/?a$|^none$/i.test(text)) return "placeholder";
    if (/^https?:\/\//i.test(text) || /^passport$/i.test(text)) return "portal_or_web_destination";
    if (/\b(?:CT|NJ|PA)\b|\bGreenwich\b/i.test(text)) return "outside_nyc";
    return "not_a_street_address";
  };
  return {
    rows_with_raw_submission_destination: raw.length,
    raw_submission_destinations_rejected: rejected.length,
    by_rejection_reason: countBy(rejected, (row) => reason(row.address_to_request)),
  };
}

function summarize(rows, moneyDoc) {
  const addresses = rows.flatMap((row) => row.addresses || []);
  const resolved = addresses.filter((item) => item.resolution_status === "resolved");
  const rowsWithAddresses = rows.filter((row) => row.addresses?.length);
  const rowsResolved = rows.filter((row) => row.locations?.length);
  const moneyById = new Map((moneyDoc?.rows || []).map((row) => [row.request_id, row]));
  const supplementalResidualRows = rowsResolved.filter((row) => {
    const money = moneyById.get(row.request_id);
    return money?.place?.scope === "unlocated";
  });
  const baselineResidual = 212;
  return {
    cohort_rows: rows.length,
    rows_with_action_address: rowsWithAddresses.length,
    action_address_count: addresses.length,
    resolved_address_count: resolved.length,
    unresolved_address_count: addresses.length - resolved.length,
    rows_with_resolved_action_location: rowsResolved.length,
    resolved_fraction: addresses.length ? Number((resolved.length / addresses.length).toFixed(4)) : 0,
    by_basis_address: countBy(addresses, (item) => item.basis),
    by_basis_rows: Object.fromEntries(Object.values(ACTION_LOCATION_BASES).map((basis) => [
      basis,
      rows.filter((row) => row.addresses?.some((item) => item.basis === basis)).length,
    ])),
    by_basis_resolved: countBy(resolved, (item) => item.basis),
    by_resolution_status: countBy(addresses, (item) => item.resolution_status),
    money_location_residual_baseline: baselineResidual,
    residual_rows_with_supplemental_action_location: supplementalResidualRows.length,
    residual_if_action_location_is_shown_separately: baselineResidual - supplementalResidualRows.length,
    performance_place_residual_after_join: baselineResidual,
  };
}

function validate(doc) {
  if (doc?.schema !== "cityscroll.contract_action_address_locations.v1") {
    throw new Error("contract action-location schema mismatch");
  }
  if (!Array.isArray(doc.rows) || doc.rows.length < 20) {
    throw new Error(`expected at least 20 cohort rows, got ${doc?.rows?.length || 0}`);
  }
  const summary = summarize(doc.rows, load(MONEY_PATH));
  for (const key of [
    "cohort_rows", "rows_with_action_address", "action_address_count",
    "resolved_address_count", "rows_with_resolved_action_location",
    "residual_rows_with_supplemental_action_location",
  ]) {
    if (doc.summary?.[key] !== summary[key]) {
      throw new Error(`summary drift for ${key}: ${doc.summary?.[key]} != ${summary[key]}`);
    }
  }
  const acceptedSubmission = summary.by_basis_rows?.submission_address || 0;
  if (doc.summary.rows_with_raw_submission_destination !== acceptedSubmission
      + doc.summary.raw_submission_destinations_rejected) {
    throw new Error("raw submission inventory does not reconcile");
  }
  for (const basis of Object.values(ACTION_LOCATION_BASES)) {
    if (doc.summary.by_basis_rows?.[basis] !== summary.by_basis_rows?.[basis]) {
      throw new Error(`row-count drift for ${basis}`);
    }
  }
  for (const row of doc.rows) {
    for (const location of row.locations || []) {
      if (!location.basis || !location.basis_label) throw new Error(`missing basis on ${row.request_id}`);
      if (location.is_place_of_performance !== false) throw new Error(`performance basis leak on ${row.request_id}`);
      if (!location.community_district || !location.council_district) {
        throw new Error(`partial district resolution on ${row.request_id}`);
      }
    }
  }
  return doc.summary;
}

async function build() {
  const open = load(OPEN_PATH);
  const ids = (open.notices || []).map((row) => row.request_id).filter(Boolean);
  const details = await fetchCityRecordRows(ids);
  const geocodes = await geocodeCandidates(details);
  const boundaries = load(BOUNDARIES_PATH);
  const rows = details.map((row) => buildContractActionLocationRow(row, geocodes, boundaries));
  const summary = { ...sourceInventory(details), ...summarize(rows, load(MONEY_PATH)) };
  const builtAt = new Date().toISOString();
  const doc = {
    schema: "cityscroll.contract_action_address_locations.v1",
    built_at: builtAt,
    boundary_vintage: boundaries.boundary_vintage,
    source: {
      notices: {
        name: "City Record Online",
        dataset_id: "dg92-zbpx",
        endpoint: CITY_RECORD,
        join_key: "request_id",
      },
      geocoder: {
        name: "NYC GeoSearch",
        endpoint: GEOSEARCH,
        selection: "strict street identity plus borough; ambiguous matches abstain",
      },
      districts: {
        community_dataset_id: boundaries.sources?.community_district?.dataset_id || "5crt-au7u",
        council_dataset_id: boundaries.sources?.council_district?.dataset_id || "872g-cjhh",
        boundary_vintage: boundaries.boundary_vintage,
        method: "point_in_polygon",
      },
    },
    basis_note:
      "Action locations describe response logistics, not where contract work is performed. "
      + "The UI must name the basis and must not merge these counts into performance-place counts.",
    summary,
    rows,
  };
  validate(doc);
  return doc;
}

function receiptFor(doc) {
  return {
    schema: "cityscroll.contract_action_address_geo_receipt.v1",
    measured_at: doc.built_at,
    cohort: "40 notices in the committed default open-contract snapshot",
    sources: doc.source,
    basis_rule: doc.basis_note,
    metrics: doc.summary,
    interpretation: {
      supplemental_location:
        "Resolved action addresses support a separately labeled office/meeting/pickup map layer.",
      performance_residual:
        "Submission and response-logistics addresses do not reduce the place-of-performance residual.",
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    if (!existsSync(OUT)) throw new Error(`missing ${OUT}`);
    const doc = load(OUT);
    const summary = validate(doc);
    console.log("contract action locations ok", summary);
    return;
  }
  const doc = await build();
  mkdirSync(dirname(OUT), { recursive: true });
  mkdirSync(dirname(RECEIPT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(RECEIPT, `${JSON.stringify(receiptFor(doc), null, 2)}\n`);
  console.log("wrote", OUT, doc.summary);
  console.log("wrote", RECEIPT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export { summarize, validate };
