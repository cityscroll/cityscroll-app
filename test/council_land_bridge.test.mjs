import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  JOIN_METHODS,
  REJECTION_REASONS,
  USEFULNESS_THRESHOLD,
  buildZapKeyRegistry,
  classifyCouncilMatterRow,
  flattenCouncilMatterRows,
  isEligibleCouncilMatterRow,
  materializeCouncilMatterEdge,
  measureCouncilLandBridge,
} from "../warehouse/lib/council_land_bridge.mjs";

// Card specimen tokens (LDP-11): ULURP C240232PQX / N240207ZRX and ZAP project
// 2024X0132 — the same bridge-contract specimen shared with
// `test/fixtures/meeting_matter_stamps.json`.
const ZAP_ROWS = [
  { project_id: "2024X0132", ulurp_numbers: "C 240232 PQX, N 240207 ZRX" },
  { project_id: "2023K0183", ulurp_numbers: "230183ABX" },
  { project_id: "9999Q9999", ulurp_numbers: "999999ZZQ" },
];

const registry = buildZapKeyRegistry(ZAP_ROWS);

function matterRow(overrides = {}) {
  return {
    request_id: "20260707022",
    event: {
      event_id: "22509",
      name: "Subcommittee on Zoning and Franchises",
      date: "2026-07-22",
      url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22509",
      documents: [{ name: "Agenda", url: "https://nyc.legistar1.com/nyc/meetings/agenda.pdf" }],
    },
    matter_id: "79200",
    matter_file: "LU 0114-2026",
    matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79200",
    title: "Landmarks, Test Site, Queens (C 260089 PCQ).",
    actions: ["Hearing Held by Committee"],
    outcome: "Hearing Held by Committee",
    votes: null,
    documents: [],
    ...overrides,
  };
}

describe("eligibility and flattening", () => {
  it("flattens only present-notice matters into one row per (event, matter) appearance", () => {
    const snapshot = {
      by_notice: {
        "1": { snapshot_state: "present", event: { event_id: "1" }, matters: [{ matter_id: "m1" }, { matter_id: "m2" }] },
        "2": { snapshot_state: "absent", event: null, matters: [] },
      },
    };
    const rows = flattenCouncilMatterRows(snapshot);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].matter_id, "m1");
  });

  it("treats a row with a matter_id as eligible", () => {
    assert.equal(isEligibleCouncilMatterRow(matterRow()), true);
  });

  it("treats a row with no matter_id as not eligible", () => {
    assert.equal(isEligibleCouncilMatterRow({ matter_id: null }), false);
  });
});

describe("exact positive join (card specimen)", () => {
  it("matches a matter carrying the exact ULURP token C240232PQX", () => {
    const row = matterRow({ matter_file: "LU 0056-2026", title: "Zoning, Rezoning (C 240232 PQX)." });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2024X0132");
    assert.equal(classification.candidates[0].method, JOIN_METHODS.EXACT_ULURP_TOKEN);
  });

  it("matches a matter carrying the exact ULURP token N240207ZRX", () => {
    const row = matterRow({ matter_file: "LU 0057-2026", title: "Zoning, Related Action (N 240207 ZRX)." });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2024X0132");
  });

  it("matches a matter carrying the exact ZAP project id", () => {
    const row = matterRow({ matter_file: "LU 0058-2026", title: "Project 2023K0183 Land Use Application." });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "matched");
    assert.equal(classification.project_id, "2023K0183");
    assert.equal(classification.candidates[0].method, JOIN_METHODS.EXACT_ZAP_PROJECT_ID);
  });

  it("materializes the matched matter chain preserving roll-call votes and documents", () => {
    const row = matterRow({
      matter_file: "LU 0056-2026",
      title: "Zoning, Rezoning (C 240232 PQX).",
      actions: ["Hearing Held by Committee", "Approved by Subcommittee"],
      outcome: "Approved by Subcommittee",
      votes: { result: "Passed", yes: 8, no: 0, vote_identity: "roll_call", by_person: [{ person_id: "1", person_name: "Test Member", vote_bucket: "aye" }] },
    });
    const classification = classifyCouncilMatterRow(row, registry);
    const edge = materializeCouncilMatterEdge(row, classification);
    assert.equal(edge.project_id, "2024X0132");
    assert.equal(edge.is_decision, false);
    assert.equal(edge.council_depth.event.event_id, "22509");
    assert.equal(edge.council_depth.matter.matter_id, "79200");
    assert.deepEqual(edge.council_depth.actions, ["Hearing Held by Committee", "Approved by Subcommittee"]);
    assert.equal(edge.council_depth.outcome, "Approved by Subcommittee");
    assert.equal(edge.council_depth.votes.result, "Passed");
    assert.equal(edge.council_depth.votes.by_person[0].person_name, "Test Member");
    assert.ok(edge.council_depth.documents.some((doc) => doc.name === "Agenda"));
    assert.ok(edge.council_depth.documents.some((doc) => doc.name === "Legistar matter detail"));
    assert.match(edge.negative_rule, /never equated with a documented land decision/);
    assert.equal(edge.provenance.join_value, "240232PQX");
    assert.equal(edge.provenance.method, JOIN_METHODS.EXACT_ULURP_TOKEN);
  });
});

describe("negative rule: title/date/committee-only and unrelated never join", () => {
  it("rejects a title matching a real committee name with no exact key (committee-only)", () => {
    const row = matterRow({ matter_file: null, title: "Subcommittee on Zoning and Franchises Meeting" });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects a date-referencing title with no exact key (date-only)", () => {
    const row = matterRow({ matter_file: null, title: "Hearing scheduled for 2026-03-25 on land use matters" });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects an unrelated zoning-word title with no exact key (unrelated zoning)", () => {
    const row = matterRow({ matter_file: null, title: "Zoning Text Amendment discussion, citywide" });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "unresolved");
    assert.equal(classification.reason, REJECTION_REASONS.NO_EXACT_LAND_KEY);
  });

  it("rejects a matter with no retained text at all (no-reference)", () => {
    const row = matterRow({ matter_file: null, title: null });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "rejected");
    assert.equal(classification.reason, REJECTION_REASONS.NO_REFERENCE);
  });

  it("rejects a matter carrying two exact keys pointing at different projects (ambiguous)", () => {
    const row = matterRow({
      matter_file: null,
      title: "Joint hearing on ULURP 240232PQX and ULURP 999999ZZQ",
    });
    const classification = classifyCouncilMatterRow(row, registry);
    assert.equal(classification.status, "rejected");
    assert.equal(classification.reason, REJECTION_REASONS.AMBIGUOUS_KEY);
  });

  it("never treats a vote-bearing matter as a decision absent explicit disposition text", () => {
    const row = matterRow({
      matter_file: "LU 0056-2026",
      title: "Zoning, Rezoning (C 240232 PQX).",
      actions: ["Hearing Held by Committee"],
      outcome: "Laid Over by Subcommittee",
      votes: { result: "Passed", yes: 5, no: 0, vote_identity: "roll_call", by_person: [] },
    });
    const classification = classifyCouncilMatterRow(row, registry);
    const edge = materializeCouncilMatterEdge(row, classification);
    assert.equal(edge.is_decision, false);
    assert.equal(edge.relation, "about_project");
    assert.notEqual(edge.relation, "project_disposition");
  });
});

describe("measurement receipt", () => {
  it("emits a stop receipt when the measured rate is below the usefulness threshold", () => {
    const rows = [matterRow({ matter_id: "a", title: "No reference" }), matterRow({ matter_id: "b", title: "Also no reference" })];
    const receipt = measureCouncilLandBridge({ rows, zapRows: ZAP_ROWS, generatedAt: "2026-09-05T00:00:00.000Z" });
    assert.equal(receipt.gate.result, "STOP");
    assert.equal(receipt.materialized_edges.length, 0);
    assert.equal(receipt.coverage.matched, 0);
    assert.equal(receipt.coverage.eligible_rows, 2);
    assert.equal(receipt.honest_absent, true);
  });

  it("ships review-tier edges only once the measured rate clears the usefulness threshold", () => {
    const matchedRow = matterRow({ title: "Zoning, Rezoning (C 240232 PQX)." });
    const rows = [matchedRow];
    const receipt = measureCouncilLandBridge({ rows, zapRows: ZAP_ROWS, generatedAt: "2026-09-05T00:00:00.000Z" });
    assert.equal(receipt.coverage.matched, 1);
    assert.ok(receipt.join_measurement.rates.exact_land_identifier.rate >= USEFULNESS_THRESHOLD);
    assert.equal(receipt.gate.result, "GO");
    assert.equal(receipt.materialized_edges.length, 1);
    assert.equal(receipt.materialized_edges[0].relation, "about_project");
    assert.equal(receipt.materialized_edges[0].proceeding_relation, "reviews_project");
  });

  it("throws without a valid generatedAt timestamp", () => {
    assert.throws(() => measureCouncilLandBridge({ rows: [], zapRows: [], generatedAt: "not-a-date" }));
  });
});

describe("committed Council land-bridge receipt", () => {
  const committedReceipt = JSON.parse(
    readFileSync(new URL("../warehouse/receipts/proof/council_land_bridge_latest.json", import.meta.url)),
  );

  it("measures the full present-notice Council matter corpus and ships above the usefulness bar", () => {
    assert.equal(committedReceipt.coverage.eligible_rows, 78);
    assert.equal(committedReceipt.coverage.matched, 32);
    assert.equal(committedReceipt.coverage.unresolved, 46);
    assert.equal(committedReceipt.coverage.rejected, 0);
    assert.equal(committedReceipt.join_measurement.rates.exact_land_identifier.rate, 0.410256);
    assert.equal(committedReceipt.gate.result, "GO");
    assert.equal(committedReceipt.materialized_edges.length, 32);
    assert.equal(committedReceipt.honest_absent, false);
  });

  it("keeps every materialized edge non-decisional with full provenance", () => {
    for (const edge of committedReceipt.materialized_edges) {
      assert.equal(edge.is_decision, false);
      assert.ok(edge.provenance.source_url);
      assert.ok(edge.provenance.join_value);
      assert.ok(edge.provenance.method);
      assert.ok(edge.provenance.observed_time);
      assert.ok(edge.council_depth.event.event_id);
      assert.ok(edge.council_depth.matter.matter_id);
    }
  });

  it("keeps a bounded, inspectable precision sample", () => {
    assert.ok(committedReceipt.precision_sample.length > 0);
    assert.ok(committedReceipt.precision_sample.length <= 10);
    for (const sample of committedReceipt.precision_sample) {
      assert.match(sample.source_url, /^https:\/\//);
    }
  });

  it("carries source vintage for every input corpus", () => {
    assert.ok(committedReceipt.source_vintage.meeting_outcomes_snapshot_generated_at);
    assert.ok(committedReceipt.source_vintage.zap_projects_warehouse_lookup_materialized_at);
  });
});
