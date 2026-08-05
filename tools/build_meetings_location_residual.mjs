#!/usr/bin/env node
/**
 * Re-measure the fixed 2026-08-04 Meetings no_place_signal residual.
 *
 * The tool fetches only the 24 source IDs in the dated baseline, runs the
 * existing meeting location chain with the committed neighborhood gazetteer,
 * and writes a compact receipt without raw notice bodies or contact details.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { meetingPlaceFromRow } from "../worker/src/lib/hearings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site/data/meetings_location_residual_receipt.json");
const SOURCES = path.join(ROOT, "site/data/meetings_location_residual_sources.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const BASELINE_IDS = Object.freeze([
  "20260213011", "20260213012", "20260213013", "20260213014", "20260213015",
  "20260504036", "20260504037", "20260504038", "20260504039", "20260513032",
  "20260513033", "20260513034", "20260513035", "20260515001", "20260521019",
  "20260522019", "20260528032", "20260529027", "20260605045", "20260610007",
  "20260624001", "20260624005", "20260625034", "20260715002",
]);
const CAUSES = Object.freeze([
  "body_place_omitted",
  "neighborhood_alias_missed",
  "venue_usable_weak_pin",
  "virtual_only",
  "external_board_page_needed",
]);
const SELECT = [
  "request_id", "start_date", "agency_name", "type_of_notice_description",
  "section_name", "short_title", "event_date", "street_address_1",
  "street_address_2", "city", "state", "zip_code", "building_name",
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "printout_1",
].join(",");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function bump(bag, key) {
  bag[key] = (bag[key] || 0) + 1;
}

function classify(place) {
  if (place.unlocated_reason === "body_place_omitted") return "body_place_omitted";
  if (place.unlocated_reason === "external_board_page_needed") return "external_board_page_needed";
  if (place.unlocated_reason === "virtual_only" || place.virtual_only) return "virtual_only";
  if (place.derivation?.methods?.includes("neighborhood_place")) return "neighborhood_alias_missed";
  if (place.derivation?.role === "venue") return "venue_usable_weak_pin";
  throw new Error(`unclassified residual result: ${JSON.stringify(place)}`);
}

function validateReceipt(receipt) {
  if (receipt?.schema !== "cityscroll.meetings_location_residual.v1") {
    throw new Error("meetings residual receipt schema mismatch");
  }
  if (receipt.baseline?.total !== 24 || receipt.cases?.length !== 24) {
    throw new Error("meetings residual receipt must retain the fixed 24-row baseline");
  }
  const classified = Object.values(receipt.classification_counts || {})
    .reduce((sum, value) => sum + Number(value || 0), 0);
  if (classified !== 24) throw new Error(`meetings residual classifications total ${classified}, expected 24`);
  if (receipt.result?.joined + receipt.result?.honest_absent !== 24) {
    throw new Error("meetings residual result must account for all 24 rows");
  }
  if (receipt.honesty_review?.agency_headquarters_used !== 0) {
    throw new Error("meetings residual receipt must not use agency headquarters");
  }
  if (receipt.source_registry_review?.citywide_complete !== false) {
    throw new Error("non-Council registry must remain explicitly partial");
  }
  if (receipt.followup?.baseline_total !== 11 || receipt.followup?.cases?.length !== 11) {
    throw new Error("Meetings residual follow-up must retain the fixed 11-row tail");
  }
  if (receipt.followup?.result?.virtual_only !== 2 || receipt.followup?.result?.honest_residual !== 9) {
    throw new Error("Meetings residual follow-up result mismatch");
  }
  if (receipt.followup.cases.some((row) => !row.source_locator || !row.terminal_classification)) {
    throw new Error("every Meetings residual follow-up case needs a terminal classification and source locator");
  }
  for (const row of receipt.cases) {
    if (!BASELINE_IDS.includes(String(row.request_id))) {
      throw new Error(`unexpected meetings residual id ${row.request_id}`);
    }
    if (!CAUSES.includes(row.cause)) throw new Error(`unexpected residual cause ${row.cause}`);
  }
}

async function fetchBaselineRows() {
  const params = new URLSearchParams({
    $select: SELECT,
    $where: `request_id in (${BASELINE_IDS.map((id) => `'${id}'`).join(",")})`,
    $order: "request_id",
    $limit: "50",
  });
  const response = await fetch(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`City Record SODA HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== BASELINE_IDS.length) {
    throw new Error(`City Record returned ${Array.isArray(rows) ? rows.length : "non-array"} fixed residual rows`);
  }
  return rows;
}

async function buildReceipt() {
  const neighborhoodGazetteer = readJson("site/data/neighborhood_gazetteer.json");
  const sourceRegistry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const registryReceipt = readJson(
    "site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-04.json",
  );
  const residualSources = readJson("site/data/meetings_location_residual_sources.json");
  const rows = await fetchBaselineRows();
  const classificationCounts = Object.fromEntries(CAUSES.map((cause) => [cause, 0]));
  const joinedByMethod = Object.create(null);
  const honestAbsentByReason = Object.create(null);
  const cases = [];

  for (const row of rows) {
    const place = meetingPlaceFromRow(row, { neighborhoodGazetteer });
    const cause = classify(place);
    bump(classificationCounts, cause);
    const joined = place.scope !== "unlocated";
    const method = joined
      ? place.derivation?.methods?.[0] || place.source || "located"
      : place.unlocated_reason || "no_place_signal";
    bump(joined ? joinedByMethod : honestAbsentByReason, method);
    cases.push({
      request_id: String(row.request_id),
      cause,
      status: joined ? "joined" : "honest_absent",
      method,
      role: place.derivation?.role || null,
      confidence: place.derivation?.confidence ?? 0,
      boroughs: place.boroughs || [],
      community_districts: place.community_districts || [],
    });
  }

  const joined = cases.filter((row) => row.status === "joined").length;
  const followupCases = residualSources.cases.map((source) => {
    const prior = cases.find((row) => row.request_id === String(source.request_id));
    if (!prior || prior.status !== "honest_absent") {
      throw new Error(`follow-up source is not in the fixed 11-row tail: ${source.request_id}`);
    }
    return {
      request_id: String(source.request_id),
      prior_reason: prior.method,
      terminal_classification: source.terminal_classification,
      status: source.terminal_classification === "virtual_only" ? "virtual_only" : "honest_residual",
      method: source.terminal_classification,
      source_locator: source.source_locator,
      source_label: source.source_label || "City Record notice detail",
    };
  });
  const receipt = {
    schema: "cityscroll.meetings_location_residual.v1",
    observed_on: new Date().toISOString().slice(0, 10),
    source: {
      system: "city_record",
      dataset_id: "dg92-zbpx",
      fixed_request_ids: BASELINE_IDS.length,
    },
    baseline: {
      measured_on: "2026-08-04",
      total: 24,
      joined: 0,
      no_place_signal: 24,
    },
    classification_counts: classificationCounts,
    result: {
      joined,
      total: cases.length,
      rate: joined / cases.length,
      honest_absent: cases.length - joined,
      joined_by_method: joinedByMethod,
      honest_absent_by_reason: honestAbsentByReason,
    },
    followup: {
      observed_on: residualSources.observed_on,
      baseline_total: followupCases.length,
      before: {
        located: 108,
        virtual_only: 3,
        unlocated: 11,
        unlocated_by_reason: {
          external_board_page_needed: 9,
          body_place_omitted: 2,
        },
      },
      result: {
        virtual_only: followupCases.filter((row) => row.status === "virtual_only").length,
        honest_residual: followupCases.filter((row) => row.status === "honest_residual").length,
      },
      after: {
        located: 110,
        virtual_only: 5,
        unlocated: 9,
        unlocated_by_reason: { multi_event_directory: 9 },
      },
      cases: followupCases,
    },
    source_registry_review: {
      bodies_inventoried: sourceRegistry.sources?.length || 0,
      citywide_complete: registryReceipt.source_inventory?.citywide_complete === true,
      candidate_residual_rows: classificationCounts.external_board_page_needed,
      accepted_specific_body_matches: 0,
      disposition:
        "The generic Board Meetings rows list multiple bodies and venues without one specific board key; the partial registry therefore supplies no geography for these rows.",
    },
    honesty_review: {
      agency_headquarters_used: cases.filter((row) => row.method === "agency_hq").length,
      synthetic_rows: 0,
      raw_notice_bodies_committed: false,
      partial_registry_presented_as_citywide: false,
    },
    cases,
  };
  validateReceipt(receipt);
  return receipt;
}

async function main() {
  if (process.argv.includes("--check")) {
    if (!existsSync(OUT) || !existsSync(SOURCES)) throw new Error("missing Meetings residual artifact");
    validateReceipt(JSON.parse(readFileSync(OUT, "utf8")));
    console.log("meetings location residual receipt ok");
    return;
  }
  const receipt = await buildReceipt();
  writeFileSync(OUT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(ROOT, OUT)} joined=${receipt.result.joined}/${receipt.result.total} honest_absent=${receipt.result.honest_absent}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
