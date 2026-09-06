import assert from "node:assert/strict";
import test from "node:test";

import { analyzeContractsProjection } from "../site/contracts_analysis_projection.mjs";
import { workerContractsAnalysis } from "../worker/src/contracts.mjs";
import { readAnalyticalProjectionDocument } from "../tools/lib/analytical_projection_io.mjs";

const projection = readAnalyticalProjectionDocument(new URL("../site/data/analytics_registered_contracts.json", import.meta.url));

test("Contracts analysis UI projection and Worker adapter share the capability envelope", async () => {
  const input = { groupBy: "agency", measure: "current", fiscalYear: 2027, limit: 5 };
  const ui = await analyzeContractsProjection(projection, input);
  const worker = await workerContractsAnalysis({ ANALYTICAL_PROJECTION: projection }).execute(input);
  assert.equal(ui.capability_reference, "contracts.analysis@1");
  assert.deepEqual(ui.groups, worker.groups);
  assert.deepEqual(ui.denominator, worker.denominator);
  assert.equal(ui.coverage.statement, worker.coverage.statement);
  assert.equal(ui.freshness.as_of, worker.freshness.as_of);
});

test("Contracts analysis projection remains unavailable for a malformed artifact", () => {
  assert.throws(
    () => analyzeContractsProjection({ schema: "wrong", rows: [] }, { groupBy: "agency", measure: "current" }),
    /analytical projection is unavailable/,
  );
});
