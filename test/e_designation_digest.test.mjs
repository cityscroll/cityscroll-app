import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { materializeEDesignationDigest } from "../warehouse/lib/e_designation_digest.mjs";
import { eDesignationDigestHTML } from "../site/e_designation_digest_view.mjs";

const project = { project_id: "P1", ceqr_number: "24DCP132Q", ulurp_numbers: "260226MMQ", project_name: "Address and title are display only" };
const lots = [{ project_id: "P1", bbls: ["4100010001", "4100010002"] }];
const source = { ":id": "row-1", enumber: "E-842", bbl: "4100010001", ceqr_num: "24DCP132Q", ulurp_num: "C250172ZMQ", air_code: true, description: "Air requirement", effective_date: "2025-10-29" };
test("exact CEQR with exact project-lot corroboration produces partial per-lot conditions", () => {
  const { payload, receipt } = materializeEDesignationDigest({ projects: [project], projectLots: lots, sourceRows: [source], sourceVintage: "2026-08-12", generatedAt: "x" });
  const digest = payload.digests.P1; assert.equal(digest.coverage, "partial"); assert.deepEqual(digest.unmatched_lots, ["4100010002"]); assert.equal(digest.conditions[0].join_method, "exact_ceqr"); assert.equal(digest.conditions[0].source_row_id, "row-1"); assert.equal(receipt.resident_request_fetches, 0);
  const html = eDesignationDigestHTML(digest); assert.match(html, /Environmental requirements on affected project lots/); assert.match(html, /do not establish that this project caused/); assert.doesNotMatch(html, /rezoning caused/i);
});
test("ULURP takes precedence and unsupported identity fields never join", () => {
  const exact = { ...source, ulurp_num: "C260226MMQ" };
  const negatives = [
    { ...source, ":id": "address", bbl: "4100010099", ceqr_num: "", ulurp_num: "", address: "same" },
    { ...source, ":id": "title", bbl: "4100010098", ceqr_num: "", ulurp_num: "", title: project.project_name },
    { ...source, ":id": "neighbor", bbl: "4100010003", ceqr_num: "", ulurp_num: "", borough: "Queens", applicant: "same" },
  ];
  const { payload } = materializeEDesignationDigest({ projects: [project], projectLots: lots, sourceRows: [exact, ...negatives], sourceVintage: "v", generatedAt: "x" });
  assert.equal(payload.digests.P1.conditions[0].join_method, "exact_ulurp"); assert.equal(payload.digests.P1.conditions.length, 1);
});
test("missing source identity is rejected and never rendered", () => {
  const { payload, receipt } = materializeEDesignationDigest({ projects: [project], projectLots: lots, sourceRows: [{ ...source, ":id": "" }], sourceVintage: "v", generatedAt: "x" });
  assert.equal(payload.digests.P1, undefined); assert.equal(receipt.counts.rejected, 1);
});
test("an ambiguous exact key without exact-lot corroboration stays unresolved", () => {
  const projects = [project, { ...project, project_id: "P2" }];
  const projectLots = [...lots, { project_id: "P2", bbls: ["4100010004"] }];
  const ambiguous = { ...source, bbl: "4100010099" };
  const { payload, receipt } = materializeEDesignationDigest({ projects, projectLots, sourceRows: [ambiguous], sourceVintage: "v", generatedAt: "x" });
  assert.equal(payload.digests.P1, undefined); assert.equal(payload.digests.P2, undefined);
  assert.ok(receipt.rejected.every((row) => row.reason === "ambiguous_key"));
});
test("committed receipt is scheduled, bounded, source-qualified, and keeps Timbale unmatched", () => {
  const receipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/e_designation_project_digest_latest.json", import.meta.url)));
  assert.equal(receipt.source.acquisition, "scheduled_warehouse_materialization");
  assert.equal(receipt.source.dataset_id, "hxm3-23vy");
  assert.deepEqual(receipt.join_precedence, ["exact_ulurp", "exact_ceqr", "exact_bbl_intersection"]);
  assert.equal(receipt.bounded_output, true); assert.equal(receipt.resident_request_fetches, 0);
  assert.equal(receipt.specimens.positive.project_id, "2026Q0210");
  assert.equal(receipt.specimens.positive.coverage, "partial");
  assert.equal(receipt.specimens.explicit_non_match.project_id, "2022M0258");
  assert.equal(receipt.specimens.explicit_non_match.coverage, "none");
  for (const row of receipt.specimens.positive.conditions) {
    assert.ok(row.source_row_id); assert.ok(row.source_url); assert.ok(row.source_vintage);
    assert.equal(row.project_id, "2026Q0210"); assert.match(row.bbl, /^\d{10}$/);
  }
});
test("resident modules load only the retained digest and never call a publisher", () => {
  const view = readFileSync(new URL("../site/e_designation_digest_view.mjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
  assert.match(view, /data\/e_designation_project_digest\.json/);
  assert.doesNotMatch(view, /hxm3-23vy|data\.cityofnewyork\.us|planning\.nyc\.gov/);
  assert.doesNotMatch(app, /hxm3-23vy/);
});
