#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  USEFULNESS_THRESHOLD,
} from "../warehouse/lib/non_council_outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const BOARD_INVENTORY_PATH = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const RECEIPT_PATH = join(
  ROOT,
  "site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-11.json",
);
const PRIOR_RECEIPT_PATH = join(
  ROOT,
  "site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-04.json",
);
const LOOKUP_PATH = join(ROOT, "site/data/non_council_outcome_lookup.json");
const OBSERVED_ON = "2026-08-11";
const GENERATED_AT = "2026-08-11T18:30:00.000Z";
/** Borough-stratified fixed sample re-measured 2026-08-11 after collectable expansion. */
const REAL_JOIN_SAMPLE = [
  {
    request_id: "20260618032",
    borough: "Bronx",
    body_id: "bronx-cb-01",
    event_date: "2026-06-25",
    disposition: "no_document_on_event_date",
    source_page: "https://www.nyc.gov/site/bronxcb1/calendar/board-meeting-minutes.page",
    notice_ulurp_tokens: [
      "260190ZSX",
      "260191ZCX",
      "260192LDX",
      "260193HAX",
      "260194ZAX",
      "260195ZAX",
      "260336ZAX",
    ],
  },
  {
    request_id: "20260603044",
    borough: "Bronx",
    body_id: "bronx-cb-06",
    event_date: "2026-06-09",
    disposition: "no_document_on_event_date",
    source_page: "https://cbbronx.cityofnewyork.us/cb6/minutes/",
    notice_ulurp_tokens: ["240206ZMX", "N240207ZRX"],
    note: "Promoted to collect on 2026-08-11; minutes index is live but no same-date full-board PDF was published for the hearing day.",
  },
  {
    request_id: "20260610003",
    borough: "Brooklyn",
    body_id: "brooklyn-cb-18",
    event_date: "2026-06-17",
    disposition: "source_inventory_only",
  },
  {
    request_id: "20260528031",
    borough: "Brooklyn",
    body_id: "brooklyn-cb-10",
    event_date: "2026-06-15",
    disposition: "source_inventory_only",
    notice_ulurp_tokens: ["260115ZMK", "260116ZRK"],
  },
  {
    request_id: "20260527036",
    borough: "Queens",
    body_id: "queens-cb-08",
    event_date: "2026-06-10",
    disposition: "same_date_document_missing_publisher_ulurp_on_notice",
    source_page: "https://www.nyc.gov/site/queenscb8/meetings/board-meeting-minutes.page",
    document_url:
      "https://www.nyc.gov/assets/queenscb8/downloads/pdf/2026/Minutes-of-Community-Board-8-Board-Meeting-held-on-June-10-2026.pdf",
    notice_ulurp_tokens: [],
  },
  {
    request_id: "20260429022",
    borough: "Queens",
    body_id: "queens-cb-11",
    event_date: "2026-05-04",
    disposition: "source_inventory_only",
    notice_ulurp_tokens: ["C250331ZMQ"],
  },
  {
    request_id: "20250909023",
    borough: "Manhattan",
    body_id: "manhattan-cb-06",
    event_date: "2025-09-30",
    disposition: "source_inventory_only",
  },
  {
    request_id: "20250328003",
    borough: "Manhattan",
    body_id: "manhattan-cb-06",
    event_date: "2025-04-09",
    disposition: "source_inventory_only",
  },
  {
    request_id: "20180926111",
    borough: "Staten Island",
    body_id: "staten-island-cb-01",
    event_date: "2018-10-09",
    disposition: "source_inventory_only",
    note: "No modern Staten Island Community Board notices resolved a body id in the 2024+ SODA window; historical body-resolvable rows retained for borough balance.",
  },
  {
    request_id: "20150714108",
    borough: "Staten Island",
    body_id: "staten-island-cb-01",
    event_date: "2015-07-21",
    disposition: "source_inventory_only",
  },
];

const BOROUGHS = [
  {
    name: "Bronx", slug: "bronx", count: 12,
    directory_url: "https://www.nyc.gov/site/communityboards/about/bronx-boards.page",
    homes: [
      "https://www.nyc.gov/site/bronxcb1/index.page",
      "https://www.nyc.gov/site/bronxcb2/index.page",
      "https://www.nyc.gov/site/bronxcb3/index.page",
      "https://www.nyc.gov/site/bronxcb4/index.page",
      "https://www.nyc.gov/site/bronxcb5/index.page",
      "https://cbbronx.cityofnewyork.us/cb6/",
      "https://www.nyc.gov/site/bronxcb7/index.page",
      "https://www.nyc.gov/site/bronxcb8/index.page",
      "https://www.nyc.gov/site/bronxcb9/index.page",
      "https://www.nyc.gov/site/bronxcb10/index.page",
      "https://www.nyc.gov/site/bronxcb11/index.page",
      "https://www.nyc.gov/site/bronxcb12/index.page",
    ],
  },
  {
    name: "Brooklyn", slug: "brooklyn", count: 18,
    directory_url: "https://www.nyc.gov/site/communityboards/about/brooklyn-boards.page",
    homes: [
      "https://www.nyc.gov/site/brooklyncb1/index.page",
      "https://www.nyc.gov/site/brooklyncb2/index.page",
      "https://www.nyc.gov/site/brooklyncb3/index.page",
      "https://www.nyc.gov/site/brooklyncb4/index.page",
      "https://www.nyc.gov/site/brooklyncb5/index.page",
      "https://www.nyc.gov/site/brooklyncb6/index.page",
      "https://www.nyc.gov/site/brooklyncb7/index.page",
      "https://www.brooklyncb8.org/",
      "https://www.nyc.gov/site/brooklyncb9/index.page",
      "https://cbbrooklyn.cityofnewyork.us/cb10/",
      "https://www.brooklyncb11.org/",
      "https://www.nyc.gov/site/brooklyncb12/index.page",
      "https://www.nyc.gov/site/brooklyncb13/index.page",
      "https://cb14brooklyn.com/",
      "https://www.nyc.gov/site/brooklyncb15/index.page",
      "https://www.nyc.gov/site/brooklyncb16/index.page",
      "https://cbbrooklyn.cityofnewyork.us/cb17/",
      "https://www.nyc.gov/site/brooklyncb18/index.page",
    ],
  },
  {
    name: "Manhattan", slug: "manhattan", count: 12,
    directory_url: "https://www.nyc.gov/site/communityboards/about/manhattan-boards.page",
    homes: [
      "https://www.nyc.gov/site/manhattancb1/index.page",
      "https://cbmanhattan.cityofnewyork.us/cb2/",
      "https://www.nyc.gov/site/manhattancb3/index.page",
      "https://cbmanhattan.cityofnewyork.us/cb4/",
      "https://www.cb5.org/",
      "https://cbsix.org/",
      "https://www.nyc.gov/site/manhattancb7/index.page",
      "https://www.cb8m.com/",
      "https://www.cb9m.org/",
      "https://cbmanhattan.cityofnewyork.us/cb10/",
      "https://www.cb11m.org/",
      "https://cbmanhattan.cityofnewyork.us/cb12/",
    ],
  },
  {
    name: "Queens", slug: "queens", count: 14,
    directory_url: "https://www.nyc.gov/site/communityboards/about/queens-boards.page",
    homes: [
      "https://www.nyc.gov/site/queenscb1/index.page",
      "https://www.nyc.gov/site/queenscb2/index.page",
      "https://queenscb3.cityofnewyork.us/",
      "https://www.nyc.gov/site/queenscb4/index.page",
      "https://www.nyc.gov/site/queenscb5/index.page",
      "https://www.nyc.gov/site/queenscb6/index.page",
      "https://www.nyc.gov/site/queenscb7/index.page",
      "https://www.nyc.gov/site/queenscb8/index.page",
      "https://www.nyc.gov/site/queenscb9/index.page",
      "https://www.nyc.gov/site/queenscb10/index.page",
      "https://www.nyc.gov/site/queenscb11/index.page",
      "https://www.nyc.gov/site/queenscb12/index.page",
      "https://www.nyc.gov/site/queenscb13/index.page",
      "https://www.nyc.gov/site/queenscb14/index.page",
    ],
  },
  {
    name: "Staten Island", slug: "staten-island", count: 3,
    directory_url: "https://www.nyc.gov/site/communityboards/about/staten-island-boards.page",
    homes: [
      "https://www.nyc.gov/site/statenislandcb1/index.page",
      "https://www.nyc.gov/site/statenislandcb2/index.page",
      "https://www.nyc.gov/site/statenislandcb3/index.page",
    ],
  },
];

const KNOWN_SOURCES = {
  "bronx-cb-01": {
    source_url: "https://www.nyc.gov/site/bronxcb1/calendar/board-meeting-minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2006, latest_year: 2025 },
  },
  "bronx-cb-02": {
    source_url: "https://www.nyc.gov/site/bronxcb2/meetings/minutes.page",
    format: "html_pdf", update_cadence: "irregular", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2019, latest_year: 2021 },
  },
  "bronx-cb-03": {
    source_url: "https://www.nyc.gov/site/bronxcb3/minutes/board-meeting-minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2018, latest_year: 2026 },
  },
  "bronx-cb-04": {
    source_url: "https://www.nyc.gov/site/bronxcb4/meetings/board-meeting-minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2024, latest_year: 2026 },
  },
  "bronx-cb-05": {
    source_url: "https://www.nyc.gov/site/bronxcb5/minutes/general-board-meeting-minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2018, latest_year: 2026 },
  },
  "bronx-cb-06": {
    source_url: "https://cbbronx.cityofnewyork.us/cb6/minutes/",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2021, latest_year: 2026 },
  },
  "bronx-cb-12": {
    source_url: "https://www.nyc.gov/site/bronxcb12/minutes/minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2018, latest_year: 2026 },
  },
  "brooklyn-cb-08": {
    source_url: "https://www.brooklyncb8.org/downloads/minutes/",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2000, latest_year: 2026 },
  },
  "brooklyn-cb-11": {
    source_url: "https://www.brooklyncb11.org/minutes/",
    format: "html_docx", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2013, latest_year: 2026 },
  },
  "brooklyn-cb-13": {
    source_url: "https://www.nyc.gov/site/brooklyncb13/minutes/minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2018, latest_year: 2026 },
  },
  "brooklyn-cb-14": {
    source_url: "https://cb14brooklyn.com/board-meeting-minutes/",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2000, latest_year: 2025 },
  },
  "manhattan-cb-02": {
    source_url: "https://cbmanhattan.cityofnewyork.us/cb2/minutes/",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2020, latest_year: 2026 },
  },
  "manhattan-cb-03": {
    source_url: "https://www.nyc.gov/site/manhattancb3/minutes/meeting-vote-records.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "yes",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2002, latest_year: 2026 },
  },
  "manhattan-cb-04": {
    source_url: "https://cbmanhattan.cityofnewyork.us/cb4/archives/",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2002, latest_year: 2026 },
  },
  "queens-cb-03": {
    source_url: "https://queenscb3.cityofnewyork.us/board-meeting-minutes/",
    format: "html", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2023, latest_year: 2026 },
  },
  "queens-cb-08": {
    source_url: "https://www.nyc.gov/site/queenscb8/meetings/board-meeting-minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2012, latest_year: 2026 },
  },
  "staten-island-cb-03": {
    source_url: "https://www.nyc.gov/site/statenislandcb3/meetings/general-board-minutes.page",
    format: "html_pdf", update_cadence: "monthly", full_board_votes: "unknown",
    archive_depth: { status: "observed_page_year_span", earliest_year: 2023, latest_year: 2026 },
  },
};

const BOROUGH_PRESIDENTS = [
  ["Bronx", "bronx", "https://bronxboropres.nyc.gov/"],
  ["Brooklyn", "brooklyn", "https://www.brooklynbp.nyc.gov/"],
  ["Manhattan", "manhattan", "https://www.manhattanbp.nyc.gov/"],
  ["Queens", "queens", "https://queensbp.nyc.gov/"],
  ["Staten Island", "staten-island", "https://www.statenislandusa.com/"],
];

function unknownArchiveDepth() {
  return { status: "unknown", earliest_year: null, latest_year: null };
}

function sourceRows() {
  const rows = [];
  for (const borough of BOROUGHS) {
    if (borough.homes.length !== borough.count) throw new Error(`home count mismatch: ${borough.name}`);
    for (let index = 0; index < borough.count; index += 1) {
      const district = index + 1;
      const bodyId = `${borough.slug}-cb-${String(district).padStart(2, "0")}`;
      const known = KNOWN_SOURCES[bodyId] || {};
      rows.push({
        body_id: bodyId,
        body_type: "community_board",
        borough: borough.name,
        district,
        name: `${borough.name} Community Board ${district}`,
        directory_url: borough.directory_url,
        homepage_url: borough.homes[index],
        source_url: known.source_url || null,
        format: known.format || "unknown",
        update_cadence: known.update_cadence || "unknown",
        archive_depth: known.archive_depth || unknownArchiveDepth(),
        full_board_votes: known.full_board_votes || "unknown",
        status: known.source_url ? "collect" : "inventory_only",
        adapter: known.source_url ? "html_document_index_v1" : null,
        observed_on: OBSERVED_ON,
      });
    }
  }
  for (const [borough, slug, homepageUrl] of BOROUGH_PRESIDENTS) {
    rows.push({
      body_id: `${slug}-bp`,
      body_type: "borough_president",
      borough,
      district: null,
      name: `${borough} Borough President`,
      directory_url: null,
      homepage_url: homepageUrl,
      source_url: null,
      format: "unknown",
      update_cadence: "irregular",
      archive_depth: unknownArchiveDepth(),
      full_board_votes: "no",
      status: "inventory_only",
      adapter: null,
      observed_on: OBSERVED_ON,
    });
  }
  return rows;
}

function buildArtifacts() {
  const inventory = JSON.parse(readFileSync(BOARD_INVENTORY_PATH, "utf8"));
  const inventoryById = new Map((inventory.boards || []).map((row) => [row.id, row]));
  const sources = sourceRows().map((row) => {
    if (row.body_type !== "community_board") return row;
    const board = inventoryById.get(row.body_id);
    if (!board) throw new Error(`board source inventory missing ${row.body_id}`);
    return {
      ...row,
      source_roles: {
        upcoming_meetings: { ...(board.upcoming || {}), source_type: "upcoming_meetings" },
        minutes: { ...(board.minutes || {}), source_type: "minutes" },
      },
    };
  });
  const collectCount = sources.filter((row) => row.status === "collect").length;
  const registry = {
    schema: "cityscroll.non_council_outcome_source_registry.v1",
    observed_on: OBSERVED_ON,
    title: "Official non-Council minutes and vote sources",
    coverage: {
      community_boards: { inventoried: 59, total: 59, collectable_sources: collectCount },
      borough_presidents: { inventoried: 5, total: 5, collectable_sources: 0 },
      presentation_scope: "board_level",
      citywide_complete: false,
    },
    policy: {
      source_urls_are_explicit: true,
      source_role_urls_are_explicit: true,
      source_role_inventory: "source_roles.upcoming_meetings and source_roles.minutes",
      no_url_inference: true,
      unmatched_rows_remain_unmatched: true,
      inventory_only_is_not_absent_publication: true,
      join_bridge_enabled: false,
      join_method: "exact_body_date_publisher_ulurp",
      relation_contracts: {
        has_member: {
          source_contract: "cityscroll.community_board_member_source_contract.v1",
          edge_schema: "cityscroll.community_board_member_edge.v1",
          required_evidence: [
            "exact_board_publisher_identity",
            "exact_member_publisher_identity",
            "exact_relation_date",
            "retained_source_document",
          ],
          status: "unknown_until_sourced",
        },
        issues_recommendation: {
          source_contract: "cityscroll.community_board_recommendation_source_contract.v1",
          edge_schema: "cityscroll.community_board_recommendation_edge.v1",
          required_evidence: [
            "exact_board_publisher_identity",
            "exact_recommendation_publisher_identity",
            "exact_relation_date",
            "retained_source_document",
          ],
          status: "unknown_until_sourced",
        },
      },
      matter_key_policy: "publisher_ulurp_identifiers_only",
      usefulness_threshold: 0.3,
      precision_promotion_bar: 1.0,
      join_bridge_receipt: "verification_receipts/non_council_minutes_votes_2026-08-11.json",
      prior_join_bridge_receipt: "verification_receipts/non_council_minutes_votes_2026-08-04.json",
      precision_review_receipt: "warehouse/receipts/proof/rc3_non_council_outcome_precision_2026-08-05.json",
    },
    sources,
  };
  const rate = { joined: 0, total: REAL_JOIN_SAMPLE.length, rate: 0 };
  const receipt = {
    schema: "cityscroll.non_council_outcomes.verification_receipt.v1",
    observed_on: OBSERVED_ON,
    usefulness_threshold: USEFULNESS_THRESHOLD,
    precision_promotion_bar: 1.0,
    join_method: "exact_body_date_publisher_ulurp",
    source_inventory: {
      bodies_inventoried: 64,
      community_boards: 59,
      borough_presidents: 5,
      explicitly_collectable_pages: collectCount,
      prior_collectable_pages: 8,
      collectable_expansion_observed_on: OBSERVED_ON,
      citywide_complete: false,
    },
    join_measurement: {
      universe:
        "City Record Community Boards notices with event_date and a body resolvable from the published notice text (151 modern notices observed in the 2024+ window; 134 body-resolvable).",
      sample:
        "Latest two body-resolvable notices per borough as of 2026-08-11 after collectable expansion; exact body + meeting date + publisher ULURP identifiers only. Staten Island modern window had zero body-resolvable rows, so two historical body-resolvable rows keep the borough stratum.",
      sample_by_borough: { Bronx: 2, Brooklyn: 2, Manhattan: 2, Queens: 2, "Staten Island": 2 },
      cases: REAL_JOIN_SAMPLE,
      rates: {
        exact_body_date_publisher_ulurp: rate,
        // Compat alias for older detectors that still read the 2026-08-04 key.
        strict_body_date_matter: rate,
      },
    },
    false_positive_review: {
      reviewed_pairs: 1,
      accepted: 0,
      rejected: 1,
      rejection_reasons: { publisher_ulurp_absent_from_notice: 1 },
      note:
        "Queens CB8 published same-date minutes for 20260527036, but the City Record notice exposed no publisher ULURP token and the minutes text contained none. A date-only match was rejected. Bronx CB6 was promoted to collect; its 2026-06-09 ULURP hearing still lacked a same-date full-board PDF.",
    },
    verdict:
      "Below usefulness threshold (0/10 = 0%): stop the notice-to-minutes outcome bridge. Collectable inventory expanded from 8 to 17 verified minutes indexes on 2026-08-11; publish no outcome edge until a new dated receipt clears 30% usefulness and 100% reviewed precision.",
    adapter_decisions: {
      html_document_index_v1: "metadata_and_text_only_for_explicit_registry_rows",
      exact_body_date_publisher_ulurp_join: "killed_below_threshold",
      strict_body_date_matter_join: "killed_below_threshold",
      guessed_url_or_universal_parser: "killed",
      reason:
        "Page layouts and publication practices remain heterogeneous; expanding collectable indexes did not clear the usefulness gate on the fixed borough-stratified sample.",
    },
    collection_policy: {
      host_side: true,
      checkpointed: true,
      minimum_delay_seconds: 1.2,
      honest_user_agent: true,
      stop_on_403: true,
      document_text: "PDF/DOCX text layer only; no OCR; binaries are not retained.",
    },
    prior_receipt: {
      path: "verification_receipts/non_council_minutes_votes_2026-08-04.json",
      joined: 0,
      total: 10,
      rate: 0,
      collectable_pages: 8,
    },
  };
  const lookup = {
    schema: "cityscroll.non_council_outcome_lookup.v1",
    generated_at: GENERATED_AT,
    coverage: {
      scope: "fixed_sample_not_citywide",
      presentation: "board_level",
      notices_seen: REAL_JOIN_SAMPLE.length,
      notices_matched: 0,
      match_rate: 0,
      honest_absent: true,
      join_bridge_enabled: false,
    },
    notices: {},
  };
  return { registry, receipt, lookup, priorReceiptPath: PRIOR_RECEIPT_PATH };
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOrCheck(path, value, check) {
  const next = serialized(value);
  if (check) {
    const current = readFileSync(path, "utf8");
    if (current !== next) throw new Error(`${path.slice(ROOT.length + 1)} is stale`);
    return;
  }
  writeFileSync(path, next);
}

const check = process.argv.includes("--check");
const artifacts = buildArtifacts();
writeOrCheck(REGISTRY_PATH, artifacts.registry, check);
writeOrCheck(RECEIPT_PATH, artifacts.receipt, check);
writeOrCheck(LOOKUP_PATH, artifacts.lookup, check);
// Keep the 2026-08-04 kill sample as historical evidence; do not rewrite it.
if (!check) {
  try {
    readFileSync(PRIOR_RECEIPT_PATH, "utf8");
  } catch {
    throw new Error("missing prior receipt non_council_minutes_votes_2026-08-04.json");
  }
}
console.log(check ? "non-Council source artifacts current" : "wrote non-Council source artifacts");
