import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  JOIN_METHODS,
  REJECTION_REASONS,
  USEFULNESS_THRESHOLD,
  buildZapKeyRegistry,
  classifyBoardBpRow,
  isBoardOrBpRow,
  materializeConsidersEdge,
  measureBoardBpLandBridge,
  recommendationEvidence,
} from "../warehouse/lib/board_bp_land_bridge.mjs";

const ZAP_ROWS = [
  { project_id: "2025K0305", ulurp_numbers: "250308MMK", ceqr_number: "26DCP139X" },
  { project_id: "2023K0183", ulurp_numbers: "230183ABX" },
  { project_id: "9999Q9999", ulurp_numbers: "999999ZZQ" },
];

const DISPOSITIONS_BY_PROJECT = {
  "2025K0305": {
    dispositions: [
      { id: "e88ccfda-3c19-f011-998b-001dd806079a", status: "Draft", representing: "Community Board" },
    ],
  },
  "2023K0183": {
    dispositions: [
      { id: "e88ccfda-3c19-f011-998b-001dd806079d", status: "Filed", representing: "Community Board" },
    ],
  },
};

function meetingRow(overrides = {}) {
  return {
    object_type: "meeting",
    meeting_id: "meeting:community_board:test",
    source_system: "community_board",
    board_name: "Brooklyn Community Board 13",
    title: "Monthly Board Meeting",
    search_text: "Monthly Board Meeting",
    description: null,
    meeting_documents: [],
    source_url: "https://example.cb.nyc.gov/meeting",
    event_date: "2026-03-25T19:00:00-04:00",
    ...overrides,
  };
}

function cityRecordBpRow(overrides = {}) {
  return {
    object_type: "meeting",
    meeting_id: "meeting:city_record:test",
    source_system: "city_record",
    agency_name: "Borough President - Brooklyn",
    title: "Brooklyn Borough President Land Use Public Hearing",
    search_text: "Brooklyn Borough President Land Use Public Hearing",
    meeting_documents: [],
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/test",
    event_date: "2026-03-25T10:00:00-04:00",
    ...overrides,
  };
}

const registry = buildZapKeyRegistry(ZAP_ROWS, DISPOSITIONS_BY_PROJECT);

describe("board/BP eligibility", () => {
  it("treats every community_board row as eligible", () => {
    assert.equal(isBoardOrBpRow({ source_system: "community_board" }), true);
  });
  it("treats a Borough President city_record row as eligible", () => {
    assert.equal(isBoardOrBpRow({ source_system: "city_record", agency_name: "Borough President - Queens" }), true);
    assert.equal(isBoardOrBpRow({ source_system: "city_record", agency_name: "Office of the Borough President of Manhattan" }), true);
  });
  it("rejects an unrelated city_record agency as not eligible", () => {
    assert.equal(isBoardOrBpRow({ source_system: "city_record", agency_name: "Health and Mental Hygiene" }), false);
  });
});

describe("exact positive join", () => {
  it("matches a row carrying the exact ULURP token to its retained ZAP project", () => {
    const row = meetingRow({
      title: "Public Hearing on Rezoning",
      search_text: "Public Hearing on Rezoning ULURP 250308MMK Land Use Application",
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2025K0305");
    assert.equal(classification.candidates[0].method, JOIN_METHODS.EXACT_ULURP_TOKEN);
  });

  it("matches a row carrying the exact ZAP project id", () => {
    const row = cityRecordBpRow({ search_text: "Project 2023K0183 Land Use Hearing" });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2023K0183");
    assert.equal(classification.candidates[0].method, JOIN_METHODS.EXACT_ZAP_PROJECT_ID);
  });

  it("matches a row carrying the exact retained disposition id", () => {
    const row = cityRecordBpRow({
      search_text: `Hearing minutes referencing disposition e88ccfda-3c19-f011-998b-001dd806079d`,
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2023K0183");
    assert.equal(classification.candidates[0].method, JOIN_METHODS.EXACT_DISPOSITION_ID);
  });

  it("materializes a considers-only edge for a matched row, never a recommendation", () => {
    const row = meetingRow({ search_text: "ULURP 250308MMK Land Use Application discussion" });
    const classification = classifyBoardBpRow(row, registry);
    const edge = materializeConsidersEdge(row, classification);
    assert.equal(edge.relation, "considers");
    assert.equal(edge.is_decision, false);
    assert.equal(edge.to, "project:2025K0305");
    assert.match(edge.negative_rule, /considers at most/);
  });
});

describe("negative rule: title/address/date/meeting-only never join", () => {
  it("rejects a title matching a real project name with no exact key (title-only)", () => {
    const row = meetingRow({
      title: "Discussion of the Westshore LSGD Mapping Actions project",
      search_text: "Discussion of the Westshore LSGD Mapping Actions project",
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects an address match with no exact key (address-only)", () => {
    const row = meetingRow({
      title: "Land Use Committee Meeting",
      search_text: "Land Use Committee Meeting 9941 Ft Hamilton Parkway, Brooklyn, 11209",
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects a date match with no exact key (date-only)", () => {
    const row = meetingRow({
      title: "Land Use Committee Meeting",
      search_text: "Land Use Committee Meeting scheduled for 2026-03-25, same date as a filed disposition",
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects a bare meeting record with no reference at all (meeting-only)", () => {
    const row = meetingRow({ title: "Monthly Board Meeting", search_text: "Monthly Board Meeting" });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects a row with no retained text at all (no-key)", () => {
    const row = meetingRow({ title: null, search_text: null, description: null });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "rejected");
    assert.equal(classification.reason, REJECTION_REASONS.NO_REFERENCE);
  });

  it("rejects a row that carries two exact keys pointing at different projects (ambiguous)", () => {
    const row = meetingRow({
      search_text: "Joint hearing on ULURP 250308MMK and ULURP 999999ZZQ",
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "rejected");
    assert.equal(classification.reason, REJECTION_REASONS.AMBIGUOUS_KEY);
  });
});

describe("negative rule: draft dispositions and missing evidence never promote to recommendation", () => {
  it("keeps a matched row at considers when its only disposition evidence is Draft", () => {
    const row = meetingRow({
      search_text: "Committee recommends approval of ULURP 250308MMK",
      meeting_documents: [{ document_url: "https://example.cb.nyc.gov/minutes.pdf" }],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.draft_disposition_only, true);
    const evidence = recommendationEvidence(row, classification);
    assert.equal(evidence.eligible, false);
    assert.equal(evidence.reason, "draft_only");
  });

  it("withholds recommendation evidence when explicit action wording is absent", () => {
    const row = meetingRow({
      search_text: "Meeting concerning ULURP 230183ABX",
      meeting_documents: [{ document_url: "https://example.cb.nyc.gov/minutes.pdf" }],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    const evidence = recommendationEvidence(row, classification);
    assert.equal(evidence.eligible, false);
    assert.equal(evidence.reason, "explicit_action_language_absent");
  });

  it("withholds recommendation evidence when no retained document is present", () => {
    const row = meetingRow({
      search_text: "Committee recommends approval of ULURP 230183ABX",
      meeting_documents: [],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    const evidence = recommendationEvidence(row, classification);
    assert.equal(evidence.eligible, false);
    assert.equal(evidence.reason, "retained_document_missing");
  });

  it("recognizes complete recommendation evidence when action wording, document, and a non-draft disposition are all present", () => {
    const row = meetingRow({
      search_text: "Committee recommends approval of ULURP 230183ABX",
      meeting_documents: [{ document_url: "https://example.cb.nyc.gov/minutes.pdf" }],
    });
    const classification = classifyBoardBpRow(row, registry);
    const evidence = recommendationEvidence(row, classification);
    assert.equal(evidence.eligible, true);
    assert.equal(evidence.document_url, "https://example.cb.nyc.gov/minutes.pdf");
  });
});

describe("measurement receipt", () => {
  it("emits a stop receipt when the measured rate is below the usefulness threshold", () => {
    const rows = [meetingRow(), meetingRow({ meeting_id: "meeting:community_board:second" })];
    const receipt = measureBoardBpLandBridge({ rows, zapRows: ZAP_ROWS, dispositionsByProject: DISPOSITIONS_BY_PROJECT, generatedAt: "2026-09-05T00:00:00.000Z" });
    assert.equal(receipt.gate.result, "STOP");
    assert.equal(receipt.materialized_edges.length, 0);
    assert.equal(receipt.coverage.matched, 0);
    assert.equal(receipt.coverage.eligible_rows, 2);
    assert.equal(receipt.honest_absent, true);
    assert.equal(receipt.gate.prior_broad_bridge_reactivated, false);
  });

  it("ships considers-tier edges only once the measured rate clears the usefulness threshold", () => {
    const matchedRow = meetingRow({ search_text: "ULURP 250308MMK Land Use Application" });
    const rows = [matchedRow];
    const receipt = measureBoardBpLandBridge({ rows, zapRows: ZAP_ROWS, dispositionsByProject: DISPOSITIONS_BY_PROJECT, generatedAt: "2026-09-05T00:00:00.000Z" });
    assert.equal(receipt.coverage.matched, 1);
    assert.ok(receipt.join_measurement.rates.exact_land_identifier.rate >= USEFULNESS_THRESHOLD);
    assert.equal(receipt.gate.result, "GO");
    assert.equal(receipt.materialized_edges.length, 1);
    assert.equal(receipt.materialized_edges[0].relation, "considers");
  });

  it("throws without a valid generatedAt timestamp", () => {
    assert.throws(() => measureBoardBpLandBridge({ rows: [], zapRows: [], generatedAt: "not-a-date" }));
  });
});

describe("committed board/BP land-bridge receipt", () => {
  const committedReceipt = JSON.parse(
    readFileSync(new URL("../warehouse/receipts/proof/board_bp_land_bridge_latest.json", import.meta.url)),
  );

  it("measures the full Community Board and Borough President corpus and stops below the usefulness bar", () => {
    assert.equal(committedReceipt.coverage.eligible_rows, 402);
    assert.equal(committedReceipt.coverage.eligible_community_board_rows, 395);
    assert.equal(committedReceipt.coverage.eligible_borough_president_rows, 7);
    assert.equal(committedReceipt.coverage.matched, 1);
    assert.equal(committedReceipt.coverage.unresolved, 401);
    assert.equal(committedReceipt.coverage.rejected, 0);
    assert.equal(committedReceipt.join_measurement.rates.exact_land_identifier.rate, 0.002488);
    assert.equal(committedReceipt.gate.result, "STOP");
    assert.equal(committedReceipt.gate.prior_broad_bridge_reactivated, false);
    assert.equal(committedReceipt.materialized_edges.length, 0);
    assert.equal(committedReceipt.honest_absent, true);
  });

  it("keeps a bounded, inspectable precision sample of the exact match it did find", () => {
    assert.equal(committedReceipt.precision_sample.length, 1);
    assert.equal(committedReceipt.precision_sample[0].join_method, JOIN_METHODS.EXACT_ULURP_TOKEN);
    assert.match(committedReceipt.precision_sample[0].source_url, /^https:\/\//);
  });

  it("carries source vintage for every input corpus", () => {
    assert.ok(committedReceipt.source_vintage.shared_meeting_read_model_generated_at);
    assert.ok(committedReceipt.source_vintage.zap_projects_warehouse_lookup_materialized_at);
    assert.ok(committedReceipt.source_vintage.land_default_ulurp_generated_at);
  });
});
