#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "warehouse/fixtures/community-board-payroll/fy2025_payroll_context.json");
const ENDPOINT = "https://data.cityofnewyork.us/resource/k397-673e.json";
const WHERE = "fiscal_year=2025 AND (upper(agency_name) like '%COMMUNITY BOARD%' OR upper(agency_name) like '%COMMUNITY BD%')";

async function query(select, group) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("$select", select);
  url.searchParams.set("$where", WHERE);
  url.searchParams.set("$group", group);
  url.searchParams.set("$order", group);
  url.searchParams.set("$limit", "5000");
  const response = await fetch(url, { headers: { "User-Agent": "CityScroll payroll context materializer" } });
  if (!response.ok) throw new Error(`Citywide Payroll aggregate query failed: ${response.status}`);
  return response.json();
}

const group = "payroll_number, agency_name, leave_status_as_of_june_30";
const [totals, titles] = await Promise.all([
  query(
    `${group}, count(*) AS published_row_count, sum(regular_gross_paid) AS regular_gross_paid, sum(total_ot_paid) AS total_ot_paid, sum(total_other_pay) AS total_other_pay`,
    group,
  ),
  query(
    `${group}, title_description, count(*) AS published_row_count`,
    `${group}, title_description`,
  ),
]);

const fixture = {
  schema: "cityscroll.community_board_payroll_context_fixture.v1",
  fiscal_year: 2025,
  source_vintage: "2026-04-16",
  dataset_id: "k397-673e",
  landing_page: "https://data.cityofnewyork.us/d/k397-673e",
  query_basis: WHERE,
  field_semantics: {
    leave_status_as_of_june_30: "Status of employee as of the close of the relevant fiscal year: Active, Ceased, or On Leave.",
    title_description: "Civil service title description of the employee.",
    regular_gross_paid: "Amount paid for base salary during the fiscal year.",
    total_ot_paid: "Total overtime pay paid during the fiscal year.",
    total_other_pay: "Compensation in addition to gross salary and overtime pay, including differentials, lump sums, allowances, retroactive pay, settlements, and bonus pay when applicable.",
  },
  aggregation: {
    totals: "sum by exact payroll_number, agency_name, and leave_status_as_of_june_30",
    titles: "row count by exact payroll_number, agency_name, leave_status_as_of_june_30, and title_description",
    unique_people: false,
  },
  totals,
  titles,
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${OUTPUT}: totals=${totals.length} titles=${titles.length}`);
