import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import {
  LATER_HOUSING_MATCH_VERSION,
  materializeLaterHousingActivity,
  selectLandMilestone,
} from "../warehouse/lib/later_housing_activity.mjs";
import { laterHousingActivityHTML } from "../site/later_housing_activity_view.mjs";

const project = {
  project_id: "P1",
  project_name: "Timbale Terrace",
  public_status: "Completed",
  approval_date: "2024-03-07T00:00:00.000",
  completed_date: null,
};
const lots = [{ project_id: "P1", bbls: ["1017670001", "1017670002"] }];
const laterJob = {
  ":id": "row-later",
  job_number: "M08028552",
  job_type: "New Building",
  job_status: "3. Permitted for Construction",
  residflag: "Residential",
  bbl: "1017670001",
  classainit: "0.0",
  classaprop: "341.0",
  classanet: "341.0",
  units_co: null,
  datefiled: "2022-10-31T00:00:00.000",
  datepermit: "2025-12-18T00:00:00.000",
  datecomplt: null,
  ownership: "Government, City: City Agency",
};
const build = (sourceRows, overrides = {}) => materializeLaterHousingActivity({
  projects: [project],
  projectLots: lots,
  sourceRows,
  sourceVintage: "2026-03-16",
  generatedAt: "2026-08-31T00:00:00.000Z",
  ...overrides,
});

test("an exact project lot with a post-milestone housing event yields a dated, sourced summary", () => {
  const { payload, receipt } = build([laterJob]);
  const digest = payload.digests.P1;
  assert.equal(digest.coverage, "partial");
  assert.deepEqual(digest.matched_lots, ["1017670001"]);
  assert.deepEqual(digest.unmatched_lots, ["1017670002"]);
  assert.equal(digest.land_use_milestone, "approval_date");
  assert.equal(digest.land_use_milestone_date, "2024-03-07");
  assert.equal(digest.events.length, 1);
  const event = digest.events[0];
  assert.equal(event.project_id, "P1");
  assert.equal(event.bbl, "1017670001");
  assert.equal(event.housing_job_number, "M08028552");
  assert.equal(event.source_row_id, "row-later");
  assert.equal(event.event_type, "permit_issued");
  assert.equal(event.event_date, "2025-12-18");
  assert.ok(event.event_date > event.land_use_milestone_date);
  assert.equal(event.units_net, 341);
  assert.equal(event.job_status, "3. Permitted for Construction");
  assert.equal(event.source_dataset, "br6q-ssj3");
  assert.equal(event.source_vintage, "2026-03-16");
  assert.match(event.source_url, /data\.cityofnewyork\.us\/resource\/br6q-ssj3\.json/);
  assert.equal(event.match_version, LATER_HOUSING_MATCH_VERSION);
  assert.deepEqual(event.match_basis, { exact_bbl: true, event_strictly_after_land_use_milestone: true });
  // The same job was filed before the milestone: the retrospective is later activity, not causation.
  assert.equal(event.filed_before_land_use_milestone, true);
  assert.equal(digest.pre_milestone_event_count, 1);
  assert.equal(receipt.match.emits_causal_claim, false);
  assert.equal(receipt.resident_request_fetches, 0);
});

test("pre-milestone and same-day events never become accepted later activity", () => {
  const before = { ...laterJob, ":id": "row-before", job_number: "BEFORE1", datepermit: "2024-03-06T00:00:00.000", datefiled: null };
  const sameDay = { ...laterJob, ":id": "row-sameday", job_number: "SAMEDAY1", datepermit: "2024-03-07T00:00:00.000", datefiled: null };
  const { payload, receipt } = build([before, sameDay]);
  assert.equal(payload.digests.P1.events.length, 0);
  assert.equal(payload.digests.P1.coverage, "none");
  assert.deepEqual(
    receipt.rejected.map((row) => row.reason).sort(),
    ["event_before_milestone", "event_on_milestone_date"],
  );
});

test("neighboring lots and non-exact identity keys never join", () => {
  const negatives = [
    { ...laterJob, ":id": "neighbor", job_number: "NEIGHBOR1", bbl: "1017670003" },
    { ...laterJob, ":id": "address", job_number: "ADDRESS1", bbl: "1099990001", addressnum: "105", addressst: "EAST 118 STREET" },
    { ...laterJob, ":id": "title", job_number: "TITLE1", bbl: "1099990002", job_desc: "Timbale Terrace" },
    { ...laterJob, ":id": "owner", job_number: "OWNER1", bbl: "1099990003", ownership: "Government, City: City Agency" },
    { ...laterJob, ":id": "fuzzy", job_number: "FUZZY1", bbl: "101767000" },
  ];
  const { payload } = build(negatives);
  assert.equal(payload.digests.P1.events.length, 0);
  assert.equal(payload.digests.P1.coverage, "none");
});

test("records missing source identity or a residential flag are rejected, not rendered", () => {
  const { payload, receipt } = build([
    { ...laterJob, ":id": "" },
    { ...laterJob, ":id": "row-nonres", job_number: "NONRES1", residflag: "Non-Residential" },
  ]);
  assert.equal(payload.digests.P1.events.length, 0);
  assert.deepEqual(
    receipt.rejected.map((row) => row.reason).sort(),
    ["missing_required_source_fact", "non_residential_record"],
  );
});

test("only completed land projects with a selected milestone are eligible", () => {
  const inProgress = { ...project, project_id: "P2", public_status: "In Public Review", project_status: "In Progress" };
  const undated = { ...project, project_id: "P3", approval_date: null, completed_date: null };
  const { payload } = materializeLaterHousingActivity({
    projects: [inProgress, undated],
    projectLots: [{ project_id: "P2", bbls: ["1017670001"] }, { project_id: "P3", bbls: ["1017670001"] }],
    sourceRows: [laterJob],
    sourceVintage: "v",
    generatedAt: "x",
  });
  assert.deepEqual(Object.keys(payload.digests), []);
  assert.equal(selectLandMilestone({ completed_date: "2024-05-20T00:00:00.000", approval_date: "2024-05-16T00:00:00.000" }).field, "completed_date");
  assert.equal(selectLandMilestone(project).field, "approval_date");
});

test("the resident summary reports later activity without any causal claim", () => {
  const digest = build([laterJob]).payload.digests.P1;
  const html = laterHousingActivityHTML(digest);
  assert.match(html, /Later housing activity on project lots/);
  assert.match(html, /they do not show that this land-use decision produced the housing/);
  assert.match(html, /BBL 1017670001/);
  assert.match(html, /Permit issued 2025-12-18/);
  assert.match(html, /341 net homes/);
  assert.match(html, /3\. Permitted for Construction/);
  assert.match(html, /Housing Database Project Level Files/);
  assert.match(html, /Match version ldp17_exact_bbl_post_milestone_v1/);
  assert.match(html, /Job application filed 2022-10-31, before this land-use milestone/);
  assert.doesNotMatch(html, /caused|resulted in|produced by|thanks to|because of|outcome of the rezoning/i);
  // An explicit no-match project renders nothing rather than an implied zero.
  assert.equal(laterHousingActivityHTML({ ...digest, events: [] }), "");
});

test("the committed materialization keeps the specimen, its keys, and its explicit no-match peers", () => {
  const payload = JSON.parse(readFileSync(new URL("../site/data/later_housing_activity.json", import.meta.url)));
  assert.equal(payload.schema, "cityscroll.later_housing_activity.v1");
  assert.equal(payload.source_dataset, "br6q-ssj3");
  assert.equal(payload.match_version, LATER_HOUSING_MATCH_VERSION);
  const specimen = payload.digests["2022M0258"];
  assert.equal(specimen.land_use_milestone_date, "2024-03-07");
  assert.deepEqual(specimen.matched_lots, ["1017670001"]);
  assert.ok(specimen.unmatched_lots.includes("1017670002"));
  assert.ok(specimen.events.length >= 1);
  for (const event of specimen.events) {
    assert.match(event.bbl, /^\d{10}$/);
    assert.ok(specimen.matched_lots.includes(event.bbl));
    assert.ok(event.event_date > "2024-03-07");
    assert.ok(event.housing_job_number && event.source_row_id && event.source_url && event.source_vintage);
    assert.equal(event.match_version, LATER_HOUSING_MATCH_VERSION);
    assert.equal(JSON.stringify(event).includes("caused"), false);
  }
  // No-match states stay explicit instead of being dropped.
  assert.ok(Object.values(payload.digests).some((digest) => digest.coverage === "none"));
  // The resident payload stays a bounded matched digest, never the Housing corpus.
  assert.ok(statSync(new URL("../site/data/later_housing_activity.json", import.meta.url)).size < 256 * 1024);
});

test("committed receipts are source-qualified, bounded, and scheduled", () => {
  const receipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/later_housing_activity_latest.json", import.meta.url)));
  assert.equal(receipt.source.dataset_id, "br6q-ssj3");
  assert.equal(receipt.source.acquisition, "scheduled_warehouse_materialization");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(receipt.source.vintage));
  assert.deepEqual(receipt.match.required_keys, ["exact_bbl"]);
  assert.deepEqual(receipt.match.prohibited_keys, ["address", "title", "owner", "name", "spatial_proximity"]);
  assert.equal(receipt.match.emits_causal_claim, false);
  assert.equal(receipt.bounded_output, true);
  assert.equal(receipt.resident_request_fetches, 0);
  assert.equal(receipt.specimens.positive.project_id, "2022M0258");
  const sourceReceipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/housing_project_activity_source_latest.json", import.meta.url)));
  assert.equal(sourceReceipt.dataset_id, "br6q-ssj3");
  assert.equal(sourceReceipt.retention_basis, "exact BBL membership in the committed Land project universe");
  assert.ok(sourceReceipt.retained_row_count > 0);
  assert.ok(sourceReceipt.retained_row_count <= sourceReceipt.eligible_lot_count * 50);
});

test("resident modules read only the retained digest and never call the Housing publisher", () => {
  const view = readFileSync(new URL("../site/later_housing_activity_view.mjs", import.meta.url), "utf8");
  const composed = readFileSync(new URL("../site/land_lot_source_digests.mjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
  assert.match(view, /data\/later_housing_activity\.json/);
  assert.doesNotMatch(view, /br6q-ssj3|data\.cityofnewyork\.us/);
  assert.doesNotMatch(composed, /br6q-ssj3|data\.cityofnewyork\.us/);
  assert.doesNotMatch(app, /br6q-ssj3/);
  // Route-lazy: the digest loads with the Land route snapshot, not from a first-paint document.
  assert.match(composed, /loadLaterHousingActivity\(\)/);
  assert.match(app, /loadLandLotSourceDigests\(\)/);
  assert.doesNotMatch(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"), /later_housing_activity/);
});

test("the composed Land lot digests preserve the existing environmental panel alongside the new one", async () => {
  const { attachLandLotSourceDigests, landLotSourceDigestsHTML } = await import("../site/land_lot_source_digests.mjs");
  const housing = build([laterJob]).payload;
  const eDesignation = { digests: { P1: { conditions: [{ bbl: "1017670001", condition_category: "noise", condition_value: "Noise requirements", designation_number: "E-1", source_url: "https://example.test/e-1", source_vintage: "2026-08-12", join_method: "exact_bbl_intersection" }], coverage: "complete", matched_lot_count: 1, eligible_lot_count: 1 } } };
  const snapshot = { projects: [{ project_id: "P1" }] };
  attachLandLotSourceDigests(snapshot, [eDesignation, housing]);
  const html = landLotSourceDigestsHTML(snapshot.projects[0]);
  assert.match(html, /Environmental requirements on affected project lots/);
  assert.match(html, /Later housing activity on project lots/);
  assert.ok(html.indexOf("Environmental requirements") < html.indexOf("Later housing activity"));
});
