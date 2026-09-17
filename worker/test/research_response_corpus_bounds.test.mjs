/**
 * Corpus recording for research identifier bounds.
 *
 * Synthetic fixtures already prove paging, sample limits, and work bounds.
 * These assertions re-run the analysis read against the committed registered-
 * contract projection so the largest corpus group and the demonstrated Health
 * Department cases stay recorded with sizes under the research budget.
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

async function analyze(input) {
  return executeContractsAnalysis(workerContractsAnalysis(env), input);
}

test("A3 largest corpus group response stays within the stated bound", async () => {
  await withPinnedClock(FIXTURE_CLOCK, async () => {
    assert.equal(evidence.schema, "cityscroll.research_response_bounds.recording.v1");
    assert.equal(evidence.acceptance_assertions.A3.artifact, EVIDENCE_PATH);
    assert.equal(evidence.response_budget_bytes, RESEARCH_RESPONSE_MAX_BYTES);
    assert.equal(evidence.projection.generated_at, projection.generated_at);
    assert.equal(evidence.projection.snapshot_date, projection.snapshot_date);
    assert.equal(evidence.projection.row_count, projection.rows.length);
    assert.equal(todayISO(), FIXTURE_CLOCK.slice(0, 10));

    const [agency, count] = largestAgencyGroup(projection.rows);
    const recorded = evidence.cases.largest_corpus_group;
    assert.equal(recorded.letter, "A3");
    assert.equal(recorded.agency, agency);
    assert.equal(recorded.identifier_count, count);

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
    assert.equal(bytes, recorded.response_bytes);
    assert.equal(recorded.bound_visible, true);
    assert.equal(recorded.turn_completes, true);
    assert.ok(recorded.response_bytes < evidence.response_budget_bytes);
  });
});

test("A5 demonstrated Health Department cases are recorded and complete", async () => {
  await withPinnedClock(FIXTURE_CLOCK, async () => {
    assert.equal(evidence.acceptance_assertions.A5.artifact, EVIDENCE_PATH);
    assert.equal(evidence.diagnosed_failure.identifiers_health_all_years, 1821);
    assert.equal(evidence.diagnosed_failure.identifiers_health_fiscal_year_2026, 806);
    assert.equal(evidence.diagnosed_failure.tool_output_bytes, 644929);
    assert.equal(todayISO(), FIXTURE_CLOCK.slice(0, 10));

    const unbounded = await handleContractsAnalysis(
      new Request("https://api.cityscroll.org/contracts/analysis?group_by=agency&identifiers=full&limit=100"),
      env,
    );
    const unboundedBody = await unbounded.json();
    const unboundedBytes = mcpBytes(unboundedBody);
    assert.equal(unboundedBytes, evidence.reconstructed_unbounded_agency_page.response_bytes);
    assert.ok(unboundedBytes > RESEARCH_RESPONSE_MAX_BYTES);
    assert.equal(unboundedBody.groups.length, evidence.reconstructed_unbounded_agency_page.group_count);

    const cases = [
      {
        key: "health_all_years",
        input: { groupBy: "agency", measure: "current", agency: HEALTH_AGENCY, limit: 1 },
        expectedCount: evidence.diagnosed_failure.identifiers_health_all_years,
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
        expectedCount: evidence.diagnosed_failure.identifiers_health_fiscal_year_2026,
        sample: RESEARCH_IDENTIFIER_SAMPLE_DEFAULT,
      },
    ];

    for (const item of cases) {
      const recorded = evidence.cases[item.key];
      assert.equal(recorded.letter, "A5");
      assert.equal(recorded.agency, HEALTH_AGENCY);
      assert.equal(recorded.identifier_count, item.expectedCount);
      assert.equal(recorded.response_bytes_before_diagnosed_turn, 644929);
      assert.equal(
        recorded.response_bytes_before_reconstructed_unbounded_page,
        evidence.reconstructed_unbounded_agency_page.response_bytes,
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
      assert.equal(bytes, recorded.response_bytes);
      assert.equal(recorded.turn_completes, true);
      assert.ok(recorded.response_bytes < recorded.response_bytes_before_diagnosed_turn);
      assert.ok(recorded.response_bytes < recorded.response_bytes_before_reconstructed_unbounded_page);
    }
  });
});
