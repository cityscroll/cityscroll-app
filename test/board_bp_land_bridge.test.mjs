import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BOROUGH_BOARD_SOURCE_STATUS,
  JOIN_METHODS,
  REJECTION_REASONS,
  USEFULNESS_THRESHOLD,
  boardBpBodyKind,
  boroughBoardRefForRow,
  boroughBoardSourceStatus,
  buildZapKeyRegistry,
  classifyBoardBpRow,
  isBoardOrBpRow,
  materializeBoroughBoardRecommendationEdge,
  materializeConsidersEdge,
  measureBoardBpLandBridge,
  measureBoroughBoardSources,
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

/** Real specimen shape: notice 20260518003, the current Brooklyn Borough
 * Board public-hearing/meeting reference (LDP-14). */
function boroughBoardRow(overrides = {}) {
  return {
    object_type: "meeting",
    meeting_id: "meeting:city_record:20260518003",
    source_system: "city_record",
    agency_name: "Borough President - Brooklyn",
    title: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING",
    search_text: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING",
    meeting_documents: [],
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260518003",
    event_date: "2026-06-02T18:00:00-04:00",
    request_id: "20260518003",
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

describe("Borough Board body-kind classification (LDP-14)", () => {
  it("classifies a community_board row as community_board", () => {
    assert.equal(boardBpBodyKind(meetingRow()), "community_board");
  });

  it("classifies a Borough President city_record row without a Borough Board title as borough_president", () => {
    assert.equal(boardBpBodyKind(cityRecordBpRow()), "borough_president");
  });

  it("classifies a Borough Board-titled city_record row under a Borough President agency as borough_board", () => {
    assert.equal(boardBpBodyKind(boroughBoardRow()), "borough_board");
  });

  it("returns null for an unrelated city_record row", () => {
    assert.equal(boardBpBodyKind({ source_system: "city_record", agency_name: "Health and Mental Hygiene" }), null);
  });

  it("resolves the canonical borough-board ref only for a borough_board row", () => {
    assert.equal(boroughBoardRefForRow(boroughBoardRow()), "borough-board:brooklyn");
    assert.equal(boroughBoardRefForRow(cityRecordBpRow()), null);
    assert.equal(boroughBoardRefForRow(meetingRow()), null);
  });
});

describe("five-board Borough Board source status (LDP-14)", () => {
  it("exposes explicit supported/inventory-only status for all five canonical Borough Boards", () => {
    const sources = measureBoroughBoardSources({
      rows: [boroughBoardRow()],
      generatedAt: "2026-09-05T00:00:00.000Z",
    });
    assert.equal(sources.sources.length, 5);
    const byRef = Object.fromEntries(sources.sources.map((source) => [source.body_ref, source]));
    assert.equal(byRef["borough-board:brooklyn"].status, BOROUGH_BOARD_SOURCE_STATUS.SUPPORTED);
    for (const ref of ["borough-board:bronx", "borough-board:manhattan", "borough-board:queens", "borough-board:staten-island"]) {
      assert.equal(byRef[ref].status, BOROUGH_BOARD_SOURCE_STATUS.INVENTORY_ONLY, ref);
    }
    assert.equal(sources.coverage.supported, 1);
    assert.equal(sources.coverage.inventory_only, 4);
  });

  it("carries a receipt with source record id, url, vintage, and content hash for a supported board", () => {
    const sources = measureBoroughBoardSources({
      rows: [boroughBoardRow()],
      generatedAt: "2026-09-05T00:00:00.000Z",
    });
    const brooklyn = sources.sources.find((source) => source.body_ref === "borough-board:brooklyn");
    assert.equal(brooklyn.receipts.length, 1);
    assert.equal(brooklyn.receipts[0].source_record_id, "20260518003");
    assert.match(brooklyn.receipts[0].source_url, /^https:\/\//);
    assert.ok(brooklyn.receipts[0].vintage);
    assert.match(brooklyn.receipts[0].content_hash, /^[0-9a-f]{64}$/);
  });

  it("never guesses a URL for an inventory-only board", () => {
    const sources = measureBoroughBoardSources({ rows: [], generatedAt: "2026-09-05T00:00:00.000Z" });
    for (const source of sources.sources) {
      assert.equal(source.status, BOROUGH_BOARD_SOURCE_STATUS.INVENTORY_ONLY);
      assert.equal(source.official_url, null);
      assert.equal(source.receipts.length, 0);
    }
  });

  it("reaches the unavailable state only when no official pattern is known", () => {
    assert.equal(boroughBoardSourceStatus(0, true), BOROUGH_BOARD_SOURCE_STATUS.INVENTORY_ONLY);
    assert.equal(boroughBoardSourceStatus(2, true), BOROUGH_BOARD_SOURCE_STATUS.SUPPORTED);
    assert.equal(boroughBoardSourceStatus(0, false), BOROUGH_BOARD_SOURCE_STATUS.UNAVAILABLE);
  });

  it("throws without a valid generatedAt timestamp", () => {
    assert.throws(() => measureBoroughBoardSources({ rows: [], generatedAt: "not-a-date" }));
  });
});

describe("Borough Board recommendation edge (LDP-14)", () => {
  it("materializes an issues_recommendation edge from borough-board:brooklyn when exact identifier, action wording, a retained document, and a non-draft disposition all hold", () => {
    const row = boroughBoardRow({
      search_text: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING Committee recommends approval of ULURP 230183ABX",
      meeting_documents: [{ document_url: "https://a856-cityrecord.nyc.gov/minutes.pdf" }],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2023K0183");
    const edge = materializeBoroughBoardRecommendationEdge(row, classification);
    assert.ok(edge);
    assert.equal(edge.relation, "issues_recommendation");
    assert.equal(edge.from, "borough-board:brooklyn");
    assert.equal(edge.to, "project:2023K0183");
    assert.equal(edge.is_decision, false);
    assert.equal(edge.provenance.document_url, "https://a856-cityrecord.nyc.gov/minutes.pdf");
  });

  it("A2: affectedness-only and draft-only -- never turns 2025K0305's affected role or Draft disposition into an observed recommendation", () => {
    const row = boroughBoardRow({
      search_text: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING Committee recommends approval of ULURP 250308MMK",
      meeting_documents: [{ document_url: "https://a856-cityrecord.nyc.gov/minutes.pdf" }],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2025K0305");
    assert.equal(classification.draft_disposition_only, true);
    assert.equal(materializeBoroughBoardRecommendationEdge(row, classification), null);
    // Still falls back to a considers-only edge, same as any other matched row.
    const consider = materializeConsidersEdge(row, classification);
    assert.equal(consider.relation, "considers");
  });

  it("stays null for a non-borough-board row even with full recommendation evidence", () => {
    const row = cityRecordBpRow({
      search_text: "Committee recommends approval of ULURP 230183ABX",
      meeting_documents: [{ document_url: "https://example.cb.nyc.gov/minutes.pdf" }],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(materializeBoroughBoardRecommendationEdge(row, classification), null);
  });

  it("negative: a Borough Board title alone, with no exact identifier, never produces a recommendation edge (title-only)", () => {
    const row = boroughBoardRow({ search_text: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING" });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(materializeBoroughBoardRecommendationEdge(row, classification), null);
  });

  it("negative: an exact match with no retained document (unsupported source) stays without a recommendation edge", () => {
    const row = boroughBoardRow({
      search_text: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING recommends approval of ULURP 230183ABX",
      meeting_documents: [],
    });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(materializeBoroughBoardRecommendationEdge(row, classification), null);
  });

  it("negative: a bare meeting-only Borough Board row never produces a recommendation edge", () => {
    const row = boroughBoardRow({ meeting_documents: [] });
    const classification = classifyBoardBpRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(materializeBoroughBoardRecommendationEdge(row, classification), null);
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
    assert.equal(committedReceipt.coverage.eligible_borough_board_rows, 1);
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

  it("publishes explicit source status for all five canonical Borough Boards, with Brooklyn supported by the real notice", () => {
    const sources = committedReceipt.borough_board_sources;
    assert.equal(sources.schema, "cityscroll.borough_board_source_registry.v1");
    assert.equal(sources.sources.length, 5);
    assert.equal(sources.coverage.supported, 1);
    assert.equal(sources.coverage.inventory_only, 4);
    assert.equal(sources.coverage.unavailable, 0);
    const brooklyn = sources.sources.find((source) => source.body_ref === "borough-board:brooklyn");
    assert.equal(brooklyn.status, BOROUGH_BOARD_SOURCE_STATUS.SUPPORTED);
    assert.equal(brooklyn.receipts[0].source_record_id, "20260518003");
    assert.match(brooklyn.receipts[0].content_hash, /^[0-9a-f]{64}$/);
    for (const ref of ["borough-board:bronx", "borough-board:manhattan", "borough-board:queens", "borough-board:staten-island"]) {
      const source = sources.sources.find((row) => row.body_ref === ref);
      assert.equal(source.status, BOROUGH_BOARD_SOURCE_STATUS.INVENTORY_ONLY, ref);
      assert.equal(source.official_url, null, ref);
    }
  });
});
