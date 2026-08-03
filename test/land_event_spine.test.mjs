import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLandEventSpine,
  joinCityRecordLandNotices,
  parseZapApiProject,
} from "../worker/src/lib/zap_outcomes.mjs";
import { buildZapOutcomeRecord } from "../worker/src/zap_outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const payload = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/zap_outcomes/joined_timbale_terrace.json"),
  "utf8",
));

const CITY_RECORD_NOTICE = {
  request_id: "20230912001",
  start_date: "2023-09-12T00:00:00.000",
  event_date: "2023-09-26T18:30:00.000",
  section_name: "Public Hearings and Meetings",
  agency_name: "City Planning",
  type_of_notice_description: "Public Hearings",
  short_title: "Timbale Terrace",
  additional_description_1: "Public hearing for ULURP Nos. C 240046 HAM and C 240047 PQM.",
};

test("known project fixture preserves dated ZAP milestones", () => {
  const record = parseZapApiProject(payload);
  assert.equal(record.project_id, "2022M0258");
  assert.ok(record.milestones.length >= 6);
  assert.ok(record.milestones.every((milestone) => milestone.time?.value));
  const certified = record.milestones.find((milestone) => milestone.outcome === "Certified");
  assert.equal(certified.time.basis, "review_meeting");
  assert.equal(certified.time.value, "2023-08-21");
  assert.ok(record.milestones.some((milestone) => milestone.title === "Community Board Review"));
});

test("City Record notices require an exact normalized ULURP token", () => {
  const joined = joinCityRecordLandNotices(
    [
      CITY_RECORD_NOTICE,
      { ...CITY_RECORD_NOTICE, request_id: "20230912002", additional_description_1: "Timbale Terrace overview only." },
    ],
    "240046HAM; 240047PQM",
  );
  assert.equal(joined.length, 1);
  assert.equal(joined[0].request_id, "20230912001");
  assert.deepEqual(joined[0].join.keys, ["240046HAM", "240047PQM"]);
  assert.equal(joined[0].join.method, "exact_ulurp_token");
});

test("event spine orders City Record notices, portal milestones, and outcomes on one rail", () => {
  const record = parseZapApiProject(payload);
  record.open_data = {
    project_id: "2022M0258",
    ulurp_numbers: "240046HAM; 240047PQM",
    current_milestone: "City Council Review",
    current_milestone_date: "2024-02-01T00:00:00.000",
  };
  const notices = joinCityRecordLandNotices([CITY_RECORD_NOTICE], record.open_data.ulurp_numbers);
  const spine = buildLandEventSpine(record, { cityRecordNotices: notices, noticeLookupStatus: "ok" });

  assert.equal(spine.schema_version, 1);
  assert.ok(spine.events.length > record.milestones.length);
  assert.deepEqual(
    [...spine.events].map((event) => event.time.value),
    [...spine.events].map((event) => event.time.value).sort(),
  );
  assert.ok(spine.events.some((event) => event.kind === "city_record_notice_published"));
  assert.ok(spine.events.some((event) => event.kind === "city_record_hearing"));
  assert.ok(spine.events.some((event) => event.kind === "zap_milestone"));
  assert.ok(spine.events.some((event) => event.kind === "zap_disposition"));
  assert.ok(spine.events.every((event) => event.time.precision === "day"));
  assert.ok(spine.events.every((event) => event.source?.id && event.source?.url));
  assert.equal(spine.lag.open_data_vs_portal.status, "behind");
  assert.ok(spine.lag.open_data_vs_portal.days >= 1);
  assert.equal(spine.gaps.length, 0);
});

test("event spine classifies empty slots without inventing events", () => {
  const record = {
    project_id: "2026M0366",
    portal_url: "https://zap.planning.nyc.gov/projects/2026M0366",
    open_data: { project_id: "2026M0366", ulurp_numbers: "260302ZCM" },
    milestones: [],
    dispositions: [],
  };
  const spine = buildLandEventSpine(record, { cityRecordNotices: [], noticeLookupStatus: "ok" });
  assert.deepEqual(spine.events, []);
  assert.deepEqual(spine.gaps.map((gap) => [gap.slot, gap.class]), [
    ["zap_milestones", "not_yet_ingested"],
    ["city_record_notices", "not_published"],
  ]);
  assert.equal(spine.lag.open_data_vs_portal.status, "unknown");
});

test("City Record lookup failures stay operational, outside the gap taxonomy", () => {
  const record = parseZapApiProject(payload);
  record.open_data = { project_id: "2022M0258", ulurp_numbers: "240046HAM" };
  const spine = buildLandEventSpine(record, { cityRecordNotices: [], noticeLookupStatus: "unavailable" });
  const gap = spine.gaps.find((item) => item.slot === "city_record_notices");
  assert.equal(gap.class, "source_unavailable");
  assert.equal(gap.taxonomy, false);
});

test("edge read model materializes the strict City Record join into record.spine", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    // WH-05: demo 2022M0258 hits warehouse materialization — SODA hgx4-8ukb must not run.
    if (url.includes("/hgx4-8ukb.json")) {
      throw new Error("SODA hgx4-8ukb should not be called for warehouse-hit demo project");
    }
    if (url.includes("zap-api-production.herokuapp.com/projects/2022M0258")) {
      return Response.json(payload);
    }
    if (url.includes("/dg92-zbpx.json")) return Response.json([CITY_RECORD_NOTICE]);
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const record = await buildZapOutcomeRecord("2022M0258", { fetchBbl: false });
    assert.equal(record.open_data?.lookup_path, "warehouse");
    assert.equal(record.open_data?.project_id, "2022M0258");
    assert.ok(calls.some((url) => url.includes("/dg92-zbpx.json")));
    assert.ok(calls.some((url) => url.includes("240046%20HAM")));
    assert.ok(!calls.some((url) => url.includes("/hgx4-8ukb.json")));
    assert.equal(record.spine.join.city_record.matched, true);
    assert.ok(record.spine.events.some((event) => event.kind === "city_record_hearing"));
    // Action rail payload: slim City Record rows ride with the outcomes record.
    assert.ok(Array.isArray(record.city_record_notices));
    assert.equal(record.city_record_notices[0]?.request_id, "20230912001");
    assert.ok(record.city_record_notices[0]?.additional_description_1);
    // Lag compares warehouse Open Data milestone date vs portal last milestone.
    assert.ok(["behind", "aligned", "unknown"].includes(record.spine.lag.open_data_vs_portal.status));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public Land detail renders the phase-grouped spine and captured evidence is pinned", () => {
  const index = SITE_SOURCE;
  assert.match(index, /function landSpineHTML/);
  assert.match(index, /land_phase_spine\.mjs|buildLandPhaseView/);
  assert.match(index, /land-phase-stepper|land-spine-lead/);
  assert.match(index, /land-spine-event/);
  assert.match(index, /record\.spine/);

  const dir = join(ROOT, "docs/screenshots/land-event-spine");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.feature, "land-event-spine");
  assert.equal(manifest.project_id, "2022M0258");
  assert.deepEqual(manifest.files.map((file) => file.viewport[0]), [390, 1440]);
  for (const file of manifest.files) {
    const bytes = readFileSync(join(dir, file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});
