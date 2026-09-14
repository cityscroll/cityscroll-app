import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSiteLifecycleReader,
  materializeSiteLifecycle,
  shardSiteLifecycle,
} from "../site/site_lifecycle_projection.mjs";
import { writeSiteLifecycleProjection } from "../tools/build_site_lifecycle_projection.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const lots = [{ project_id: "2020K0270", bbls: ["3073670011", "3073670029"] }];
const land = [{ project_id: "2020K0270", project_name: "2134 Coyle Street Rezoning", approval_date: "2022-02-24", completed_date: "2022-03-18", ulurp_numbers: "C210239ZMK; N210240ZRK" }];
const council = [
  { matter_id: "coyle-zmk", project_id: "2020K0270", join_value: "C210239ZMK", title: "Coyle zoning matter", event_date: "2022-02-24" },
  { matter_id: "coyle-zrk", project_id: "2020K0270", join_value: "N210240ZRK", title: "Coyle rezoning matter", event_date: "2022-02-24" },
];
const procurement = [
  { source_system: "ocp_recent_contract_awards", request_id: "20241104015", subject_id: "procurement:award:20241104015", short_title: "Coyle Family Residence", award_date: "2024-11-04", evidence: [{ resolved_bbl: "3073670011", evidence_path: "qyyg-4tf5:20241104015#coyle" }] },
  { source_system: "city_record_online", request_id: "20230911014", subject_id: "procurement:hearing-section:20230911014:coyle", short_title: "Coyle section", event_date: "2023-09-11", evidence: [{ resolved_bbl: "3073670011", evidence_path: "dg92-zbpx:20230911014#coyle" }] },
  { source_system: "passport_public_contracts", request_id: "4965933", subject_id: "procurement:contract:CT107120258802303", short_title: "Coyle Family Residence contract", event_date: "2024-01-01", evidence: [{ resolved_bbl: "3073670011", evidence_path: "passport:4965933#epin" }] },
  { source_system: "city_record_online", request_id: "20230911014", subject_id: "procurement:hearing-section:20230911014:other", short_title: "Unrelated contract", event_date: "2023-09-11", evidence: [{ resolved_bbl: "3073670999", evidence_path: "dg92-zbpx:20230911014#other" }] },
];

function ids(history) { return history.members.map((item) => item.subject_id); }

test("materializes the complete parcel-mediated Coyle history with distinct identities", async () => withPinnedClock("2026-09-14T00:00:00Z", async () => {
  const document = materializeSiteLifecycle({ landProjects: land, projectLots: lots, councilMatters: council, procurementRecords: procurement, generatedAt: testClockISOString() });
  const first = document.parcels["3073670011"];
  assert.deepEqual(ids(first), [
    "council:matter:coyle-zmk", "council:matter:coyle-zrk", "land:application:C210239ZMK", "land:application:N210240ZRK", "land:project:2020K0270", "procurement:hearing-section:20230911014:coyle",
    "procurement:contract:CT107120258802303", "procurement:award:20241104015",
  ]);
  assert.deepEqual(ids(document.parcels["3073670029"]), ["council:matter:coyle-zmk", "council:matter:coyle-zrk", "land:application:C210239ZMK", "land:application:N210240ZRK", "land:project:2020K0270"]);
  assert.deepEqual(first.members.find((item) => item.subject_id === "land:project:2020K0270").source_events.map((event) => event.date), ["2022-02-24", "2022-03-18"]);
  assert.equal(first.members.find((item) => item.subject_id === "procurement:award:20241104015").footprint_scope[0], "3073670011");
  assert.equal(first.members.find((item) => item.subject_id === "procurement:award:20241104015").source_event_date, "2024-11-04");
  assert.ok(!ids(first).includes("procurement:hearing-section:20230911014:other"));
  assert.equal(document.members["procurement:award:20241104015"].parcel_ids.join(), "3073670011");
  assert.equal(document.members["land:project:2020K0270"].parcel_ids.join(), "3073670011,3073670029");
}));

test("preserves unknown dates, duplicate lineage, missing evidence, and exact generation checks", () => {
  const document = materializeSiteLifecycle({ landProjects: [{ project_id: "P1", project_name: "Undated" }], projectLots: [{ project_id: "P1", bbls: ["1000000001"] }], procurementRecords: [
    { source_system: "x", request_id: "same", subject_id: "procurement:award:same", evidence: [{ resolved_bbl: "1000000001" }] },
    { source_system: "x", request_id: "same", subject_id: "procurement:award:same", event_date: "2022-01-01", evidence: [{ resolved_bbl: "1000000001" }] },
    { source_system: "x", request_id: "removed", subject_id: "procurement:award:removed", event_date: "2022-01-02", evidence: [] },
  ] });
  const [shard] = shardSiteLifecycle(document, 1);
  assert.equal(shard.generation, document.generation);
  assert.equal(shard.content_hash, document.content_hash);
  assert.throws(() => createSiteLifecycleReader({ generation: "wrong" }, [shard]), /generation mismatch/);
  const reader = createSiteLifecycleReader({ generation: document.generation, content_hash: document.content_hash }, [shard], { generation: document.generation, content_hash: document.content_hash, members: document.members });
  assert.equal(reader.get("1000000001").members.filter((item) => item.subject_id === "procurement:award:same").length, 1);
  assert.equal(reader.get("1000000001").members.find((item) => item.subject_id === "land:project:P1").source_event_date, null);
  assert.deepEqual(reader.memberParcels("procurement:award:removed"), []);
  assert.throws(() => createSiteLifecycleReader({ generation: document.generation, content_hash: document.content_hash }, [shard], { generation: "stale", content_hash: document.content_hash, members: document.members }), /reverse index generation mismatch/);
  assert.throws(() => createSiteLifecycleReader({ generation: document.generation, content_hash: document.content_hash }, [shard], { generation: document.generation, content_hash: "stale", members: document.members }), /reverse index content hash mismatch/);
});

test("writes a receipt and reverse index from the materialized document", async () => withPinnedClock("2026-09-14T00:00:00Z", async () => {
  const outputDir = await mkdtemp(join(process.env.FM_TASK_SCRATCH || "/tmp", "site-lifecycle-"));
  const receiptPath = join(outputDir, "receipt.json");
  const document = materializeSiteLifecycle({ landProjects: land, projectLots: lots, councilMatters: council, procurementRecords: procurement, generatedAt: testClockISOString() });
  const manifest = writeSiteLifecycleProjection(document, { outputDir, receiptPath });
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const reverse = JSON.parse(await readFile(join(outputDir, "reverse.json"), "utf8"));
  assert.equal(receipt.generation, document.generation);
  assert.equal(receipt.content_hash, document.content_hash);
  assert.deepEqual(receipt.counts, document.counts);
  assert.deepEqual(receipt.shards, manifest.shards);
  assert.equal(reverse.generation, manifest.generation);
  assert.equal(reverse.content_hash, manifest.content_hash);
  assert.deepEqual(reverse.members, document.members);
}));
