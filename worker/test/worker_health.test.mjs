import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/worker.mjs";
import {
  HEALTH_OK_MARKER,
  handleWorkerHealth,
  workerHealthPayload,
} from "../src/lib/worker_health.mjs";

const COMMIT = "93655b7648090cafb7b6486e144e14690d36efab".slice(0, 40);

test("health payload keeps the liveness marker and adds deploy identity fields", () => {
  assert.deepEqual(workerHealthPayload({
    GIT_COMMIT_SHA: COMMIT,
    WRANGLER_ENV: "production",
  }), {
    status: HEALTH_OK_MARKER,
    commit: COMMIT,
    environment: "production",
  });
});

test("health payload leaves identity null when deploy vars are absent or malformed", () => {
  assert.deepEqual(workerHealthPayload({}), {
    status: HEALTH_OK_MARKER,
    commit: null,
    environment: null,
  });
  assert.deepEqual(workerHealthPayload({
    GIT_COMMIT_SHA: "not-a-sha",
    WRANGLER_ENV: "prod env",
  }), {
    status: HEALTH_OK_MARKER,
    commit: null,
    environment: null,
  });
  assert.deepEqual(workerHealthPayload({
    GIT_COMMIT_SHA: ` ${COMMIT.toUpperCase()} `,
    WRANGLER_ENV: "preview",
  }), {
    status: HEALTH_OK_MARKER,
    commit: COMMIT,
    environment: "preview",
  });
});

test("GET /health remains HTTP 200 with the existing marker and parseable identity fields", async () => {
  const response = handleWorkerHealth({
    GIT_COMMIT_SHA: COMMIT,
    WRANGLER_ENV: "production",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  const text = await response.text();
  assert.match(text, /crol-worker ok/);
  const body = JSON.parse(text);
  assert.equal(body.status, HEALTH_OK_MARKER);
  assert.equal(body.commit, COMMIT);
  assert.equal(body.environment, "production");
});

test("unstamped health still exposes the liveness marker and null identity", async () => {
  const response = handleWorkerHealth({});
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /crol-worker ok/);
  assert.deepEqual(JSON.parse(text), {
    status: HEALTH_OK_MARKER,
    commit: null,
    environment: null,
  });
});

test("Worker fetch /health uses the stamped payload", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/health"),
    { GIT_COMMIT_SHA: COMMIT, WRANGLER_ENV: "production" },
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: HEALTH_OK_MARKER,
    commit: COMMIT,
    environment: "production",
  });
});

test("Worker fetch / shares the /health payload", async () => {
  const env = { GIT_COMMIT_SHA: COMMIT, WRANGLER_ENV: "production" };
  const root = await worker.fetch(new Request("https://api.cityscroll.org/"), env, {});
  const health = handleWorkerHealth(env);
  assert.deepEqual(await root.json(), await health.json());
});
