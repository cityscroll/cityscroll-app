#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  materializeCommunityBoardAdoptedBudget,
  validateCommunityBoardAdoptedBudget,
} from "../site/community_board_adopted_budget.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY = join(ROOT, "site/data/community_board_financial_identity_crosswalk.json");
const IDENTITY_RECEIPT = join(ROOT, "warehouse/receipts/proof/community_board_financial_identity_latest.json");
const OUTPUT = join(ROOT, "site/data/community_board_adopted_budget.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/community_board_adopted_budget_latest.json");
const DATASET = "mwzb-yiwb";
const SODA = `https://data.cityofnewyork.us/resource/${DATASET}.json`;
const VIEWS = `https://data.cityofnewyork.us/api/views/${DATASET}.json`;

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function soda(params) {
  const response = await fetch(`${SODA}?${new URLSearchParams(params)}`);
  if (!response.ok) throw new Error(`SODA ${DATASET} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function datasetUpdatedISO() {
  const response = await fetch(VIEWS);
  if (!response.ok) return null;
  const metadata = await response.json();
  return typeof metadata.rowsUpdatedAt === "number" ? new Date(metadata.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
}

async function fetchRows(slice) {
  const rows = [];
  const limit = 50_000;
  for (let offset = 0; ; offset += limit) {
    const page = await soda({
      $select: "*",
      $where: `fiscal_year=${Number(slice.fiscal_year)} AND publication_date='${String(slice.publication_date).replaceAll("'", "''")}' AND upper(agency_name) like '%COMMUNITY BOARD%'`,
      $limit: String(limit),
      $offset: String(offset),
    });
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}

function buildReceipt(readModel, identityReceipt) {
  return {
    schema: "cityscroll.community_board_adopted_budget_receipt.v1",
    workstream_card: "CB-MONEY-01",
    status: "complete",
    generated_at: readModel.source.observed_at,
    source: readModel.source,
    identity_artifact: {
      path: "site/data/community_board_financial_identity_crosswalk.json",
      sha256: sha256(`${readFileSync(IDENTITY, "utf8").replace(/\n?$/, "\n")}`),
      receipt_schema: identityReceipt.schema,
      identity_source_slice: identityReceipt.sources?.expense_budget?.query_slice || null,
    },
    measurement: {
      candidate_rows: readModel.coverage.candidate_rows,
      pinned_slice_rows: readModel.coverage.slice_rows,
      accepted_rows: readModel.coverage.accepted_rows,
      accepted_board_facts: readModel.coverage.accepted_board_facts,
      board_fy_coverage: readModel.rows.map(({ board_id, fiscal_year, adopted_amount }) => ({ board_id, fiscal_year, adopted_amount })),
      duplicate_rows_suppressed: readModel.coverage.duplicate_rows_suppressed,
      unmatched_rows: readModel.unmatched_rows,
      unmatched_rows_reported: readModel.coverage.unmatched_rows_reported,
      component_semantic_checks: readModel.component_checks,
      reproducible_aggregation: readModel.aggregation,
      provenance_carried_to_read_model: readModel.rows.every((row) => row.provenance?.dataset_id === DATASET && row.source_vintage && row.binding_status === "accepted"),
    },
    hard_rules: {
      exact_cb_money_00_binding_required: true,
      adopted_distinct_from_current_modified: true,
      one_explicit_fiscal_year_publication_slice: true,
      duplicate_source_rows_do_not_double_count: true,
      unmatched_rows_are_reported_not_dropped: true,
      unsupported_components_are_not_published_as_verified: true,
    },
    read_model: "site/data/community_board_adopted_budget.json",
  };
}

function check() {
  const readModel = json(OUTPUT);
  const validation = validateCommunityBoardAdoptedBudget(readModel);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const receipt = json(RECEIPT);
  if (receipt.schema !== "cityscroll.community_board_adopted_budget_receipt.v1") throw new Error("invalid adopted budget receipt");
  if (receipt.measurement?.provenance_carried_to_read_model !== true) throw new Error("adopted budget provenance gate is not clear");
  const identityHash = sha256(`${readFileSync(IDENTITY, "utf8").replace(/\n?$/, "\n")}`);
  if (receipt.identity_artifact?.sha256 !== identityHash) throw new Error("CB-MONEY-00 identity artifact changed; rebuild adopted budget facts");
  if (receipt.identity_artifact?.identity_source_slice?.fiscal_year !== readModel.source.pinned_slice.fiscal_year
      || receipt.identity_artifact?.identity_source_slice?.publication_date !== readModel.source.pinned_slice.publication_date) {
    throw new Error("adopted budget source slice does not match CB-MONEY-00");
  }
  console.log(`community board adopted budget ok: facts=${readModel.rows.length} FY=${readModel.source.pinned_slice.fiscal_year} unmatched=${readModel.unmatched_rows.length}`);
}

if (process.argv.includes("--check")) {
  check();
} else {
  const identity = json(IDENTITY);
  const identityReceipt = json(IDENTITY_RECEIPT);
  const slice = identityReceipt.sources?.expense_budget?.query_slice;
  if (!slice?.fiscal_year || !slice?.publication_date) throw new Error("CB-MONEY-00 receipt does not provide an explicit Expense Budget slice");
  const rows = await fetchRows(slice);
  const observedAt = new Date().toISOString();
  const readModel = materializeCommunityBoardAdoptedBudget({
    rows,
    registry: identity,
    identityReceipt,
    fiscalYear: slice.fiscal_year,
    publicationDate: slice.publication_date,
    sourceVintage: identityReceipt.sources.expense_budget.source_vintage || await datasetUpdatedISO(),
    observedAt,
  });
  const validation = validateCommunityBoardAdoptedBudget(readModel);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const receipt = buildReceipt(readModel, identityReceipt);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  mkdirSync(dirname(RECEIPT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(readModel, null, 2)}\n`);
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote adopted board budget: rows=${readModel.rows.length} candidate_rows=${rows.length} unmatched=${readModel.unmatched_rows.length}`);
}
