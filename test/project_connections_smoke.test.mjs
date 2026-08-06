import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyProjectConnectionsResponse,
  runProjectConnectionsSmoke,
} from "../tools/project_connections_smoke.mjs";

const availableBody = {
  ok: true,
  sections: { project_connections: { schema_version: 1, status: "available" } },
  record: {
    project_id: "2022M0258",
    project_connections: {
      schema_version: 1,
      status: "bounded",
      project_ref: "project:2022M0258",
      groups: ["applicant", "parcels", "meetings", "decisions", "notices", "mih"].map((id) => ({ id })),
    },
  },
};

test("deploy contract accepts complete data or an explicit unavailable declaration", () => {
  assert.deepEqual(classifyProjectConnectionsResponse(availableBody, "2022M0258"), { ok: true, state: "available" });
  const legacyComplete = structuredClone(availableBody);
  delete legacyComplete.sections;
  assert.deepEqual(classifyProjectConnectionsResponse(legacyComplete, "2022M0258"), { ok: true, state: "available" });
  assert.deepEqual(classifyProjectConnectionsResponse({
    ok: true,
    sections: {
      project_connections: {
        schema_version: 1,
        status: "unavailable",
        reason: "read_model_unavailable",
      },
    },
    record: { project_id: "2022M0258" },
  }, "2022M0258"), { ok: true, state: "unavailable" });
});

test("successful-but-incomplete 200 fails loudly", () => {
  const result = classifyProjectConnectionsResponse(
    { ok: true, record: { project_id: "2022M0258" } },
    "2022M0258",
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /incomplete 200/i);
});

test("smoke retries incomplete responses until the contract is complete", async () => {
  let calls = 0;
  let now = 0;
  const result = await runProjectConnectionsSmoke({
    timeoutMs: 20,
    intervalMs: 10,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(calls === 1
        ? { ok: true, record: { project_id: "2022M0258" } }
        : availableBody), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("production deploys gate API readiness before Pages and verify the rendered section after deploy", () => {
  const pages = readFileSync(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");
  assert.match(pages, /api-contract:[\s\S]*project_connections_smoke\.mjs/);
  assert.match(pages, /needs:\s*\[build, api-contract\]/);
  for (const workflow of [pages, worker]) {
    assert.match(workflow, /project_connections_smoke\.mjs/);
    assert.match(workflow, /setup-playwright/);
    assert.match(workflow, /27_project_connections_live\.py/);
  }
});
