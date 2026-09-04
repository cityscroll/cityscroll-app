import assert from "node:assert/strict";
import test from "node:test";

import { primaryResidentRoutes, smokeFirstClassSurfaces } from "../tools/first_class_live_smoke.mjs";
import { FIRST_CLASS_REPORT_SCHEMA } from "../tools/first_class_refresh.mjs";

test("post-deploy route inventory covers every primary Browse lens and Now", () => {
  assert.deepEqual(primaryResidentRoutes(), [
    "/browse/",
    "/browse/contracts/",
    "/browse/exams/",
    "/browse/meetings/",
    "/browse/people/",
    "/browse/property/",
    "/browse/rules/",
    "/browse/staffing/",
    "/browse/zoning/",
    "/now/",
  ]);
});

test("post-deploy smoke rejects stale first-class data without calling it empty", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("first_class_freshness_report.json")) {
      return new Response(JSON.stringify({
        schema: FIRST_CLASS_REPORT_SCHEMA,
        deployment_identity: "release-a",
        surface_count: 1,
        surfaces: [{ public_artifact_path: "site/data/rules.json", freshness_state: "stale" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("<main>Resident page</main>", { status: 200 });
  };
  const receipt = await smokeFirstClassSurfaces({ baseUrl: "https://example.test", fetchImpl, deploymentIdentity: "release-a" });
  assert.equal(receipt.status, "failed");
  assert.match(receipt.findings.join("\n"), /deployed state is stale/);
  assert.doesNotMatch(receipt.findings.join("\n"), /empty/);
});
