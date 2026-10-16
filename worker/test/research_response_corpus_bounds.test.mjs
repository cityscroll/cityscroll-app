/**
 * Corpus recording for research identifier bounds.
 *
 * Synthetic fixtures already prove paging, sample limits, and work bounds.
 * These assertions re-run the analysis read against the committed registered-
 * contract projection so the largest corpus group and the demonstrated Health
 * Department cases stay under the research budget after first-class refresh.
 * Exact calendar vintages, frozen row counts, and exact response byte sizes
 * against the live artifact are not pinned — those move when publishers roll.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RESEARCH_IDENTIFIER_SAMPLE_DEFAULT,
  RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM,
  RESEARCH_RESPONSE_MAX_BYTES,
  researchResponseBytes,
} from "../../capabilities/research_response_limits.mjs";
import { executeContractsAnalysis } from "../../capabilities/contracts_analysis.mjs";
import { readAnalyticalProjectionDocument } from "../../tools/lib/analytical_projection_io.mjs";
import { todayISO, withPinnedClock } from "../../test/helpers/test_clock.mjs";
import {
  formatContractsAnalysisText,
  handleContractsAnalysis,
  workerContractsAnalysis,
} from "../src/contracts.mjs";

// Resolve from this file so Unit family (worker) and Time-travel (worker),
// which run with cwd=worker/, still find repo-root evidence and projection data.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_PATH = join("docs", "evidence", "research-response-bounds", "bounded-identifier-arrays.json");
const PROJECTION_PATH = join("site", "data", "analytics_registered_contracts.json");
const FIXTURE_CLOCK = "2026-09-17T18:00:00.000Z";
const HEALTH_AGENCY = "Department of Health and Mental Hygiene";
// Floor: a healthy registered-contract corpus stays well above empty/stub size.
const MIN_PROJECTION_ROWS = 1_000;
// Ceiling ratio: a bounded sample response must stay far below an unbounded
// identifiers=full page, not merely under the absolute budget.
const BOUNDED_TO_UNBOUNDED_MAX_RATIO = 0.25;

const evidence = JSON.parse(readFileSync(join(ROOT, EVIDENCE_PATH), "utf8"));
const projection = readAnalyticalProjectionDocument(join(ROOT, PROJECTION_PATH));
const env = { ANALYTICAL_PROJECTION: projection };

function mcpToolResult(body) {
  return {
    content: [{ type: "text", text: formatContractsAnalysisText(body) }],
    structuredContent: body,
  };
}

function mcpBytes(body) {
  return researchResponseBytes(mcpToolResult(body));
}

function largestAgencyGroup(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = row.agency ?? "Unknown / not published";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
}

function agencyContractCount(rows, agency, { fiscalYear = null } = {}) {
  let count = 0;
  for (const row of rows) {
    if ((row.agency ?? "Unknown / not published") !== agency) continue;
    if (fiscalYear != null && Number(row.registration_fiscal_year) !== Number(fiscalYear)) continue;
    count += 1;
  }
  return count;
}

function assertProjectionProvenance(doc) {
  assert.equal(doc.schema, "cityscroll.analytics_registered_contracts.v1");
  assert.equal(doc.projection_contract, "cityscroll.analytical_projection.v1");
  assert.match(String(doc.generated_at || ""), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(doc.snapshot_date || ""), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(doc.rows), "registered-contract projection must expose rows");
  assert.ok(doc.rows.length >= MIN_PROJECTION_ROWS, `projection population ${doc.rows.length} below floor ${MIN_PROJECTION_ROWS}`);
}

async function analyze(input) {
  return executeContractsAnalysis(workerContractsAnalysis(env), input);
}

test("A3 largest corpus group response stays within the stated bound", async () => {
  await withPinnedClock(FIXTURE_CLOCK, async () => {
    assert.equal(evidence.schema, "cityscroll.research_response_bounds.recording.v1");
    assert.equal(evidence.acceptance_assertions.A3.artifact, EVIDENCE_PATH);
    assert.equal(evidence.response_budget_bytes, RESEARCH_RESPONSE_MAX_BYTES);
    assert.equal(todayISO(), FIXTURE_CLOCK.slice(0, 10));
    assertProjectionProvenance(projection);
    // Historical recording stays self-consistent; it is not a live vintage pin.
    assert.equal(evidence.projection.schema, projection.schema);
    assert.equal(evidence.projection.path, PROJECTION_PATH.replaceAll("\\", "/"));
    assert.ok(evidence.projection.row_count >= MIN_PROJECTION_ROWS);
    assert.match(String(evidence.projection.generated_at || ""), /^\d{4}-\d{2}-\d{2}T/);

    const [agency, count] = largestAgencyGroup(projection.rows);
    assert.ok(agency);
    assert.ok(count >= 1);
    assert.ok(count <= projection.rows.length);

    const recorded = evidence.cases.largest_corpus_group;
    assert.equal(recorded.letter, "A3");
    assert.equal(recorded.bound_visible, true);
    assert.equal(recorded.turn_completes, true);
    assert.ok(recorded.response_bytes < evidence.response_budget_bytes);

    const body = await analyze({
      groupBy: "agency",
      measure: "current",
      agency,
      limit: 1,
      sampleLimit: RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM,
    });
    const group = body.groups[0];
    const bytes = mcpBytes(body);

    assert.equal(body.availability, "complete");
    assert.equal(group.label, agency);
    assert.equal(group.contract_count, count);
    assert.equal(group.contract_sample.length, RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM);
    assert.equal(group.contract_ids, undefined);
    assert.equal(group.contract_procurement_ids, undefined);
    assert.ok(body.contract_detail?.identifier_note);
    assert.match(body.contract_detail.identifier_note, /contract_sample/);
    assert.ok(bytes < RESEARCH_RESPONSE_MAX_BYTES, `largest corpus group measured ${bytes} bytes`);
    assert.ok(bytes > 0);
  });
});

test("A5 demonstrated Health Department cases are recorded and complete", async () => {
  await withPinnedClock(FIXTURE_CLOCK, async () => {
    assert.equal(evidence.acceptance_assertions.A5.artifact, EVIDENCE_PATH);
    assert.equal(todayISO(), FIXTURE_CLOCK.slice(0, 10));
    assertProjectionProvenance(projection);
    // Diagnosed-failure recording remains a historical receipt, not a live pin.
    assert.ok(evidence.diagnosed_failure.identifiers_health_all_years >= 1);
    assert.ok(evidence.diagnosed_failure.identifiers_health_fiscal_year_2026 >= 1);
    assert.ok(evidence.diagnosed_failure.tool_output_bytes > RESEARCH_RESPONSE_MAX_BYTES);
    assert.ok(evidence.reconstructed_unbounded_agency_page.response_bytes > RESEARCH_RESPONSE_MAX_BYTES);
    assert.ok(evidence.reconstructed_unbounded_agency_page.group_count >= 1);

    const unbounded = await handleContractsAnalysis(
      new Request("https://api.cityscroll.org/contracts/analysis?group_by=agency&identifiers=full&limit=100"),
      env,
    );
    const unboundedBody = await unbounded.json();
    const unboundedBytes = mcpBytes(unboundedBody);
    assert.ok(unboundedBytes > RESEARCH_RESPONSE_MAX_BYTES);
    assert.ok(unboundedBody.groups.length >= 1);
    // Group cardinality tracks the live agency population, not a frozen count.
    const liveAgencyCount = new Set(
      projection.rows.map((row) => row.agency ?? "Unknown / not published"),
    ).size;
    assert.equal(unboundedBody.groups.length, liveAgencyCount);

    const healthAllYears = agencyContractCount(projection.rows, HEALTH_AGENCY);
    const healthFiscal2026 = agencyContractCount(projection.rows, HEALTH_AGENCY, { fiscalYear: 2026 });
    assert.ok(healthAllYears >= 1, "Health Department must remain present in the corpus");
    assert.ok(healthFiscal2026 >= 1);
    assert.ok(healthFiscal2026 <= healthAllYears);

    const cases = [
      {
        key: "health_all_years",
        input: { groupBy: "agency", measure: "current", agency: HEALTH_AGENCY, limit: 1 },
        expectedCount: healthAllYears,
        sample: RESEARCH_IDENTIFIER_SAMPLE_DEFAULT,
      },
      {
        key: "health_fiscal_year_2026",
        input: {
          groupBy: "agency",
          measure: "current",
          agency: HEALTH_AGENCY,
          fiscalYear: 2026,
          limit: 1,
        },
        expectedCount: healthFiscal2026,
        sample: RESEARCH_IDENTIFIER_SAMPLE_DEFAULT,
      },
    ];

    for (const item of cases) {
      const recorded = evidence.cases[item.key];
      assert.equal(recorded.letter, "A5");
      assert.equal(recorded.agency, HEALTH_AGENCY);
      assert.equal(recorded.turn_completes, true);
      assert.ok(recorded.response_bytes_before_diagnosed_turn > RESEARCH_RESPONSE_MAX_BYTES);
      assert.ok(
        recorded.response_bytes_before_reconstructed_unbounded_page
          > RESEARCH_RESPONSE_MAX_BYTES,
      );

      const body = await analyze(item.input);
      const group = body.groups[0];
      const bytes = mcpBytes(body);

      assert.equal(body.availability, "complete");
      assert.equal(group.label, HEALTH_AGENCY);
      assert.equal(group.contract_count, item.expectedCount);
      assert.equal(group.contract_sample.length, item.sample);
      assert.equal(group.contract_ids, undefined);
      assert.ok(body.contract_detail?.identifier_note);
      assert.ok(bytes < RESEARCH_RESPONSE_MAX_BYTES, `${item.key} measured ${bytes} bytes`);
      assert.ok(bytes > 0);
      assert.ok(
        bytes / unboundedBytes < BOUNDED_TO_UNBOUNDED_MAX_RATIO,
        `${item.key} bounded ${bytes} vs unbounded ${unboundedBytes} exceeds ratio ${BOUNDED_TO_UNBOUNDED_MAX_RATIO}`,
      );
      assert.ok(bytes < recorded.response_bytes_before_diagnosed_turn);
      assert.ok(bytes < recorded.response_bytes_before_reconstructed_unbounded_page);
    }
  });
});
