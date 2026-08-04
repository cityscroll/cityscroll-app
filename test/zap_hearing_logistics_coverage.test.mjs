import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseZapApiProject } from "../worker/src/lib/zap_outcomes.mjs";
import {
  isExactDispositionHearingEvidence,
  summarizeZapHearingLogisticsCoverage,
} from "../tools/lib/zap_hearing_logistics_coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function payload(projectId, included = []) {
  return {
    data: {
      type: "projects",
      id: projectId,
      attributes: {
        "dcp-name": projectId,
        "dcp-publicstatus": "In Public Review",
      },
    },
    included,
  };
}

test("coverage counts exact disposition evidence and preserves honest absence", () => {
  const populated = parseZapApiProject(payload("2024Q0292", [{
    type: "dispositions",
    id: "hearing-1",
    attributes: {
      "dcp-name": "2024Q0292_ZM_QN BP",
      "dcp-representing": "Borough President",
      "dcp-dateofpublichearing": "2026-09-10T13:30:00.000Z",
      "dcp-publichearinglocation": "In person at 120-55 Queens Blvd or livestreamed at https://www.youtube.com/watch?v=queens-hearing",
    },
  }]));
  const absent = parseZapApiProject(payload("2026M0366", [{
    type: "milestones",
    id: "review-only",
    attributes: {
      "display-name": "Review Session - General Review",
      "dcp-reviewmeetingdate": "2026-09-01T04:00:00.000Z",
    },
  }]));

  assert.ok(Array.isArray(populated.hearing_logistics));
  assert.equal(absent.hearing_logistics, null);
  assert.ok(isExactDispositionHearingEvidence(populated.hearing_logistics[0], "2024Q0292"));

  const summary = summarizeZapHearingLogisticsCoverage([
    { project_id: "2024Q0292", status: "ok", record: populated },
    { project_id: "2026M0366", status: "ok", record: absent },
  ], { today: "2026-08-04" });
  assert.equal(summary.fixed_sample_total, 2);
  assert.equal(summary.projects_fetched, 2);
  assert.equal(summary.honest_absent, 1);
  assert.equal(summary.invalid_logistics_rows, 0);
  assert.deepEqual(summary.rates.hearing_logistics, { joined: 1, total: 2, rate: 0.5 });
  assert.deepEqual(summary.rates.venue_or_livestream, { joined: 1, total: 2, rate: 0.5 });
  assert.deepEqual(summary.rates.upcoming_date, { joined: 1, total: 2, rate: 0.5 });
});

test("coverage rejects wrong project ids and non-disposition provenance", () => {
  const row = {
    source: "zap-api-milestones",
    project_id: "2024Q0292",
    hearing_date: "2026-09-10",
    provenance: {
      field: "dcp-reviewmeetingdate",
      hearing_at: { field: "dcp-reviewmeetingdate" },
    },
  };
  assert.equal(isExactDispositionHearingEvidence(row, "2024Q0292"), false);
  assert.equal(isExactDispositionHearingEvidence({
    ...row,
    source: "zap-api-dispositions",
    project_id: "2024Q0293",
    provenance: {
      field: "dcp-publichearinglocation",
      hearing_at: { field: "dcp-dateofpublichearing" },
    },
  }, "2024Q0292"), false);
});

test("dated fixed-sample receipt records measured coverage without citywide inference", () => {
  const receipt = JSON.parse(readFileSync(join(
    ROOT,
    "site/data/zap_outcome_sources/verification_receipts/zap_hearing_logistics_2026-08-04.json",
  ), "utf8"));
  assert.equal(receipt.source_contract_id, "zap-api-outcomes");
  assert.equal(receipt.measurement.fixed_sample_total, 50);
  assert.equal(receipt.measurement.projects_fetched, 50);
  assert.equal(receipt.measurement.projects_failed, 0);
  assert.equal(receipt.measurement.join_mismatches, 0);
  assert.equal(receipt.measurement.invalid_logistics_rows, 0);
  assert.deepEqual(receipt.measurement.rates.hearing_logistics, {
    joined: 41,
    total: 50,
    rate: 0.82,
  });
  assert.deepEqual(receipt.measurement.rates.venue_or_livestream, {
    joined: 39,
    total: 50,
    rate: 0.78,
  });
  assert.equal(receipt.measurement.honest_absent, 9);
  assert.equal(receipt.measurement.rates.upcoming_date.joined, 0);
  assert.equal(receipt.field_case.incremental_projects_populated, 1);
  assert.equal(receipt.sample_definition.citywide_inference_allowed, false);
});
