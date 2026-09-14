import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acquireHistoricalCouncilMatters,
  historicalMatterTargetsFromProjectContext,
  normalizeHistoricalMatterResponse,
} from "../worker/src/lib/historical_council_matter_acquisition.mjs";
import {
  buildZapKeyRegistry,
  classifyCouncilMatterRow,
  flattenCouncilMatterRows,
  measureCouncilLandBridge,
} from "../warehouse/lib/council_land_bridge.mjs";

const ZAP = [{ project_id: "2020K0270", ulurp_numbers: "C 210239 ZMK, N 210240 ZRK" }];

function response(rows, status = 200) {
  return new Response(JSON.stringify(rows), { status, headers: { "content-type": "application/json" } });
}

test("normalizes exact historical MatterFile responses and retains publisher evidence", () => {
  const result = normalizeHistoricalMatterResponse([
    {
      MatterId: 501, MatterFile: "LU 0010-2022", MatterName: "Coyle Street Rezoning",
      MatterInSiteURL: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=501",
      MatterLastUpdated: "2022-02-24T00:00:00Z",
      actions: ["Approved by City Council"],
    },
    { MatterId: 999, MatterFile: "LU 0011-2022", MatterName: "Other matter" },
  ], { matterFile: "LU 0010-2022", acquiredAt: "2026-09-14T00:00:00Z" });
  assert.equal(result.status, "resolved");
  assert.equal(result.rows[0].matter_id, "501");
  assert.equal(result.rows[0].matter_file, "LU 0010-2022");
  assert.equal(result.rows[0].source_date, "2022-02-24T00:00:00Z");
  assert.equal(result.rows[0].source_response.MatterId, 501);
  assert.match(result.rows[0].matter_url, /^https:\/\//);
});

test("project context contributes exact historical application targets only", () => {
  const targets = historicalMatterTargetsFromProjectContext({ retained_rows: [{
    project_id: "2020K0270",
    council_applications: ["LU 0010-2022", { matter_file: "Res 0051-2022", application_id: "C210239ZMK" }],
  }, { project_id: "2021A0001", council_applications: [{ matter_file: "LU 0010-2022" }] }] }, { projectIds: ["2020K0270"] });
  assert.deepEqual(targets.map((target) => target.matter_file), ["LU 0010-2022", "RES 0051-2022"]);
  assert.equal(targets[1].application_id, "C210239ZMK");
});

test("missing token is retryable and does not publish absence", async () => {
  const result = await acquireHistoricalCouncilMatters({
    targets: [{ matter_file: "LU 0010-2022" }],
    token: null,
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(result.kind, "token-absent");
  assert.equal(result.retained_last_good, true);
  assert.deepEqual(result.rows, []);
});

test("similar titles, shared addresses, and incomplete identifiers do not bridge", () => {
  const registry = buildZapKeyRegistry(ZAP);
  for (const row of [
    { matter_id: "1", title: "Coyle Street Rezoning, 2134 Coyle Street" },
    { matter_id: "2", matter_file: "LU 0010-2022", title: "Coyle Street Rezoning" },
    { matter_id: "3", title: "C 210239" },
  ]) {
    assert.notEqual(classifyCouncilMatterRow(row, registry).status, "matched");
  }
});

test("ambiguous exact applications are rejected and historical rows share one bridge generation", () => {
  const registry = buildZapKeyRegistry([
    ...ZAP,
    { project_id: "2021A0001", ulurp_numbers: "N 210240 ZRK" },
  ]);
  const ambiguous = classifyCouncilMatterRow({ matter_id: "4", matter_file: "LU 0011-2022", title: "N 210240 ZRK" }, registry);
  assert.equal(ambiguous.status, "rejected");
  assert.equal(ambiguous.reason, "ambiguous_key");

  const historical = [
    { matter_id: "501", matter_file: "LU 0010-2022", title: "Coyle (C 210239 ZMK)", event_id: "7001", action_date: "2022-02-24", matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=501" },
    { matter_id: "502", matter_file: "LU 0011-2022", title: "Coyle (N 210240 ZRK)", event_id: "7002", action_date: "2022-02-24", matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=502" },
  ];
  const rows = flattenCouncilMatterRows({ by_notice: {} }, historical);
  const measurement = measureCouncilLandBridge({ rows, zapRows: ZAP, generatedAt: "2026-09-14T00:00:00Z" });
  assert.equal(measurement.materialized_edges.length, 2);
  assert.deepEqual(measurement.materialized_edges.map((edge) => edge.project_id), ["2020K0270", "2020K0270"]);
  assert.equal(measurement.materialized_edges[0].is_decision, false);
  assert.equal(measurement.materialized_edges[0].council_depth.event.date, "2022-02-24");
});

test("acquisition resolves only exact MatterFile matches and preserves publisher failures", async () => {
  const calls = [];
  const result = await acquireHistoricalCouncilMatters({
    targets: [{ matter_file: "LU 0010-2022" }], token: "opaque-token", now: new Date("2026-09-14T00:00:00Z"),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response([{ MatterId: 501, MatterFile: "LU 0010-2022", MatterName: "Coyle" }]);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].matter_id, "501");
  assert.match(calls[0], /MatterFile/);

  const failed = await acquireHistoricalCouncilMatters({
    targets: [{ matter_file: "LU 0010-2022" }], token: "opaque-token",
    fetchImpl: async () => response("forbidden", 403),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, "forbidden");
  assert.equal(failed.retained_last_good, true);
  assert.deepEqual(failed.rows, []);
});
