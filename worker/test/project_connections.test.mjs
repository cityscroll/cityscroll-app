import assert from "node:assert/strict";
import test from "node:test";

import {
  attachProjectConnections,
  attachProjectConnectionsSection,
  PROJECT_CONNECTION_COVERAGE,
} from "../src/project_connections.mjs";
import { handleZapOutcomes } from "../src/zap_outcomes.mjs";

test("server adapter attaches current-cohort and fixed-sample coverage to Timbale Terrace", () => {
  const record = attachProjectConnections({
    project_id: "2022M0258",
    generated_at: "2026-08-05T17:00:00.000Z",
    dispositions: [{ representing: "Community Board", community_board: "Favorable" }],
    documents: [{ name: "Recommendation", url: "https://example.test/recommendation" }],
    city_record_notices: [],
    spine: { gaps: [{ slot: "city_record_notices", class: "not_published" }] },
  });
  const view = record.project_connections;
  assert.equal(view.project_ref, "project:2022M0258");
  assert.equal(view.groups.find((group) => group.id === "applicant").items[0].confidence, "tentative");
  assert.equal(view.groups.find((group) => group.id === "parcels").items.length, 11);
  assert.equal(PROJECT_CONNECTION_COVERAGE.applicant.eligible, 231);
  assert.equal(PROJECT_CONNECTION_COVERAGE.applicant.linked, 231);
  assert.equal(PROJECT_CONNECTION_COVERAGE.parcels.linked, 224);
  assert.equal(PROJECT_CONNECTION_COVERAGE.decisions.eligible, 50);
  assert.equal(PROJECT_CONNECTION_COVERAGE.decisions.linked, 45);
  assert.equal(PROJECT_CONNECTION_COVERAGE.decisions.scope, "fixed_completed_project_sample");
  assert.equal(PROJECT_CONNECTION_COVERAGE.meetings.eligible, null);
});

test("unknown project titles do not borrow exact-key parcel evidence", () => {
  const record = attachProjectConnections({
    project_id: "2099X9999",
    project_name: "Timbale Terrace",
    generated_at: "2026-08-05T17:00:00.000Z",
    dispositions: [],
    documents: [],
    city_record_notices: [],
    spine: { gaps: [] },
  });
  assert.equal(record.project_connections.project_ref, "project:2099X9999");
  assert.equal(
    record.project_connections.groups.find((group) => group.id === "parcels").items.length,
    0,
  );
});

test("cached outcome responses receive current project connections at serve time", async () => {
  const cached = {
    project_id: "2022M0258",
    generated_at: "2099-01-01T00:00:00.000Z",
    dispositions: [],
    documents: [],
    city_record_notices: [],
    spine: { gaps: [] },
  };
  const env = { ALERT_STATE: { get: async () => JSON.stringify(cached) } };
  const response = await handleZapOutcomes(
    new Request("https://api.test/zap-outcomes?id=2022M0258"),
    env,
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cached, true);
  assert.equal(body.record.project_connections.project_ref, "project:2022M0258");
  assert.equal(body.record.project_connections.groups.length, 5);
  assert.deepEqual(body.sections.project_connections, {
    schema_version: 1,
    status: "available",
  });
});

test("read-model decoration failures become an honest unavailable section", () => {
  const result = attachProjectConnectionsSection(
    { project_id: "2022M0258" },
    { attach: () => { throw new Error("fixture read model failed"); } },
  );
  assert.equal(result.record.project_connections.status, "unavailable");
  assert.equal(result.record.project_connections.reason, "read_model_unavailable");
  assert.deepEqual(result.section, {
    schema_version: 1,
    status: "unavailable",
    reason: "read_model_unavailable",
  });
});
