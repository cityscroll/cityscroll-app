import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquire,
  assertLiveWriterWindow,
  assertCurrentWriter,
  drain,
  drainLiveWindow,
  listActiveDeployRuns,
  readLiveFenceState,
  release,
  releaseLiveFenceWindow,
  setLiveFenceWindow,
  WORKER_DEPLOY_FENCE_SCHEMA,
} from "../tools/worker_deploy_fence.mjs";

const HELPER = join(process.cwd(), "tools/worker_deploy_fence.mjs");

function envFor(root, owner = "run-1") {
  return {
    ...process.env,
    WORKER_DEPLOY_FENCE_ROOT: root,
    WORKER_DEPLOY_FENCE_WINDOW: "worker-deploy",
    WORKER_DEPLOY_OWNER: owner,
  };
}

test("fence is durable, idempotent for its owner, and rejects a foreign writer", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-fence-"));
  try {
    const env = envFor(root);
    const first = acquire({ root, env, now: new Date("2026-10-28T20:00:00Z"), ttlMs: 60_000 });
    assert.equal(first.schema, WORKER_DEPLOY_FENCE_SCHEMA);
    assert.equal(first.generation, 1);
    assert.equal(acquire({ root, env, now: new Date("2026-10-28T20:00:01Z") }).idempotent, true);
    assert.equal(assertCurrentWriter({ root, env, now: new Date("2026-10-28T20:00:02Z") }).owner, "local:run-1");

    const foreign = spawnSync(process.execPath, [HELPER, "assert"], {
      env: envFor(root, "run-2"),
      encoding: "utf8",
    });
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /does not own the fence/);
    assert.equal(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).active, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fence refuses an unconfigured local coordinator and isolates independent roots", () => {
  assert.throws(() => acquire({ env: { WORKER_DEPLOY_OWNER: "run-1" } }), /WORKER_DEPLOY_FENCE_ROOT is required/);
  const rootA = mkdtempSync(join(tmpdir(), "worker-fence-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "worker-fence-b-"));
  try {
    const first = acquire({ root: rootA, env: envFor(rootA, "controller-a"), now: new Date("2026-10-28T20:00:00Z") });
    const independent = acquire({ root: rootB, env: envFor(rootB, "controller-b"), now: new Date("2026-10-28T20:00:00Z") });
    assert.equal(first.owner, "local:controller-a");
    assert.equal(independent.owner, "local:controller-b");
    assert.throws(() => assertCurrentWriter({ root: rootA, env: envFor(rootB, "controller-b") }), /does not own the fence/);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("expired and released fences fail closed, including across a process boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-fence-"));
  try {
    const env = envFor(root);
    acquire({ root, env, now: new Date("2026-10-28T20:00:00Z"), ttlMs: 1_000 });
    assert.throws(
      () => assertCurrentWriter({ root, env, now: new Date("2026-10-28T20:00:01Z") }),
      /expired/,
    );
    const releasedEnv = envFor(root, "run-3");
    // A new owner cannot release or replace the expired active writer.
    assert.throws(() => release({ root, env: releasedEnv, now: new Date("2026-10-28T20:00:01Z") }));
    const ownerReleased = envFor(root);
    // Release requires a live assertion; the expired record remains evidence of a closed fence.
    assert.throws(() => release({ root, env: ownerReleased, now: new Date("2026-10-28T20:00:01Z") }), /expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("draining closes the current window to queued and retried writers", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-fence-drain-"));
  try {
    const firstEnv = envFor(root, "run-1");
    acquire({ root, env: firstEnv, now: new Date("2026-10-28T20:00:00Z") });
    const drained = drain({ root, env: envFor(root, "controller"), now: new Date("2026-10-28T20:01:00Z") });
    assert.equal(drained.draining, true);
    assert.doesNotThrow(() => assertCurrentWriter({ root, env: firstEnv, now: new Date("2026-10-28T20:02:00Z") }));
    release({ root, env: firstEnv, now: new Date("2026-10-28T20:03:00Z") });
    assert.throws(() => acquire({ root, env: envFor(root, "run-2"), now: new Date("2026-10-28T20:04:00Z") }), /draining/);
    assert.doesNotThrow(() => acquire({
      root,
      env: { ...envFor(root, "run-2"), WORKER_DEPLOY_FENCE_WINDOW: "next-window" },
      now: new Date("2026-10-28T20:04:00Z"),
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function githubResponse(status, body = null, link = "", jsonImpl = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return name.toLowerCase() === "link" ? link : null; } },
    async json() {
      return jsonImpl ? jsonImpl() : body;
    },
  };
}

const REF_SHA = "a".repeat(40);
const FILE_SHA = "b".repeat(40);

function liveFenceValue(windowId, expiresAt, generation = 1, status = "ACTIVE", restoredAt = undefined) {
  return JSON.stringify({
    schema: "cityscroll.worker_deploy_live_fence.v1", window_id: windowId, expires_at: expiresAt, generation, status,
    ...(status === "RELEASED" ? { restored_at: restoredAt || "2026-10-28T20:10:00Z" } : {}),
  });
}

const BASE_SHA = "c".repeat(40);

function createLiveFenceServer({
  initialRef = false,
  initialDocument = null,
  initialGeneration = 1,
  bootstrapMode = "normal",
  runPages = {},
} = {}) {
  const server = {
    refExists: initialRef,
    refSha: REF_SHA,
    fileSha: initialDocument ? FILE_SHA : null,
    document: initialDocument,
    bootstrapCalls: 0,
    putCalls: 0,
    runPages,
    initialGeneration,
  };
  server.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (url.includes("/git/matching-refs/heads/deploy-fence")) {
      if (server.matchingBody) return githubResponse(200, server.matchingBody);
      return githubResponse(200, server.refExists
        ? [{ ref: "refs/heads/deploy-fence", object: { sha: server.refSha } }]
        : []);
    }
    if (url.endsWith("/git/ref/heads/main")) return githubResponse(200, { ref: "refs/heads/main", object: { sha: BASE_SHA } });
    if (url.endsWith("/git/refs") && method === "POST") {
      server.bootstrapCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.ref, "refs/heads/deploy-fence");
      assert.equal(body.sha, BASE_SHA);
      if (bootstrapMode === "unacknowledged") {
        server.refExists = true;
        return githubResponse(500, { message: "ack lost" });
      }
      if (server.refExists) return githubResponse(422, { message: "already exists" });
      server.refExists = true;
      return githubResponse(201, { ref: "refs/heads/deploy-fence", object: { sha: server.refSha } });
    }
    if (url.includes("/contents/.github/worker-deploy-fence.json")) {
      if (method === "GET") {
        if (!server.refExists || !server.document) return githubResponse(404);
        return githubResponse(200, {
          type: "file",
          encoding: "base64",
          sha: server.fileSha,
          content: Buffer.from(`${liveFenceValue(server.document.window_id, server.document.expires_at, server.document.generation, server.document.status, server.document.restored_at)}\n`, "utf8").toString("base64"),
        });
      }
      if (method === "PUT") {
        server.putCalls += 1;
        if (!server.refExists) return githubResponse(404);
        const body = JSON.parse(options.body);
        if (body.sha && body.sha !== server.fileSha) return githubResponse(409, { message: "stale file" });
        const document = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
        server.document = document;
        server.fileSha = FILE_SHA;
        return githubResponse(server.putCalls === 1 && !body.sha ? 201 : 200, { content: { sha: server.fileSha } });
      }
    }
    if (url.includes("/actions/workflows/deploy-worker.yml/runs")) {
      const status = new URL(url).searchParams.get("status");
      const page = Number(new URL(url).searchParams.get("page") || "1");
      return githubResponse(200, { workflow_runs: server.runPages[`${status}:${page}`] || [] });
    }
    throw new Error(`unexpected fake GitHub URL ${method} ${url}`);
  };
  return server;
}

test("live repository fence treats absent, matching, expired, and read-error states distinctly", async () => {
  const base = {
    token: "github-token",
    repository: "cityscroll/cityscroll-app",
    windowId: "run-1:1",
    now: new Date("2026-10-28T20:00:00Z"),
  };
  const absentServer = createLiveFenceServer();
  const absent = await assertLiveWriterWindow({ ...base, fetchImpl: absentServer.fetch });
  assert.equal(absent.state, "ABSENT");
  assert.equal(absent.allowed, true);
  assert.equal(absent.absence_proven, true);

  const prefixOnlyServer = createLiveFenceServer();
  prefixOnlyServer.matchingBody = [{ ref: "refs/heads/deploy-fence-old", object: { sha: REF_SHA } }];
  const prefixOnly = await readLiveFenceState({ ...base, fetchImpl: prefixOnlyServer.fetch });
  assert.equal(prefixOnly.state, "ABSENT");
  assert.equal(prefixOnly.absence_proven, true);

  const matchingServer = createLiveFenceServer({ initialRef: true, initialDocument: {
    window_id: "run-1:1", expires_at: "2026-10-28T21:00:00Z", generation: 1, status: "ACTIVE",
  } });
  const matching = await assertLiveWriterWindow({
    ...base,
    fetchImpl: matchingServer.fetch,
  });
  assert.equal(matching.state, "PRESENT");
  assert.equal(matching.allowed, true);
  assert.equal(matching.generation, 1);

  const expiredServer = createLiveFenceServer({ initialRef: true, initialDocument: {
    window_id: "run-1:1", expires_at: "2026-10-28T19:59:59Z", generation: 1, status: "ACTIVE",
  } });
  const expired = await readLiveFenceState({ ...base, fetchImpl: expiredServer.fetch });
  assert.equal(expired.state, "EXPIRED");
  assert.equal(expired.fenced, true);
  await assert.rejects(
    () => assertLiveWriterWindow({
      ...base,
      fetchImpl: expiredServer.fetch,
    }),
    /blocks writer in expired state/,
  );

  await assert.rejects(
    () => assertLiveWriterWindow({
      ...base,
      fetchImpl: async () => githubResponse(503, { message: "unavailable" }),
    }),
    /matching-ref read returned HTTP 503/,
  );

  await assert.rejects(
    () => assertLiveWriterWindow({
      ...base,
      fetchImpl: async (url) => url.includes("/matching-refs/") ? githubResponse(404) : githubResponse(404),
    }),
    /ref absence is unknown/,
  );
});

test("a run admitted before a fence is refused by the live assert before its mutation", async () => {
  const server = createLiveFenceServer();
  const common = {
    token: "github-token",
    repository: "cityscroll/cityscroll-app",
    windowId: "run-1:1",
    now: new Date("2026-10-28T20:00:00Z"),
    fetchImpl: server.fetch,
  };
  assert.equal((await assertLiveWriterWindow(common)).state, "ABSENT");
  server.refExists = true;
  server.document = { window_id: "manual-window", expires_at: "2026-10-28T21:00:00Z", generation: 1, status: "ACTIVE" };
  server.fileSha = FILE_SHA;
  await assert.rejects(() => assertLiveWriterWindow(common), /outside active window/);
});

test("live drain refuses to finish while a deploy-worker run is still in progress", async () => {
  const server = createLiveFenceServer({
    runPages: { "in_progress:1": [{ id: 42, status: "in_progress", name: "Deploy worker", path: ".github/workflows/deploy-worker.yml" }] },
  });
  await assert.rejects(
    () => drainLiveWindow({
      token: "github-token",
      repository: "cityscroll/cityscroll-app",
      windowId: "window-owner",
      expiresAt: "2026-10-28T21:00:00Z",
      maxPolls: 1,
      now: () => new Date("2026-10-28T20:00:00Z"),
      fetchImpl: server.fetch,
    }),
    /deploy-worker runs remain active/,
  );
  assert.equal(server.putCalls, 1);
});

test("live drain records a receipt only after queued and running deploys clear", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-live-drain-"));
  const receiptPath = join(root, "drain-receipt.json");
  let polls = 0;
  const server = createLiveFenceServer();
  const fetchLive = server.fetch;
  server.fetch = async (url, options = {}) => {
    if (url.includes("/actions/workflows/deploy-worker.yml/runs")) {
      polls += 1;
      return githubResponse(200, { workflow_runs: polls <= 5 ? [{ id: 43, status: "queued" }] : [] });
    }
    return fetchLive(url, options);
  };
  try {
    const receipt = await drainLiveWindow({
      token: "github-token",
      repository: "cityscroll/cityscroll-app",
      windowId: "window-owner",
      expiresAt: "2026-10-28T21:00:00Z",
      receiptPath,
      fetchImpl: server.fetch,
      now: () => new Date("2026-10-28T20:01:00Z"),
      maxPolls: 2,
      sleep: async () => {},
    });
    assert.equal(receipt.outcome, "DRAINED");
    assert.equal(receipt.polls, 2);
    assert.equal(receipt.generation, 1);
    assert.equal(receipt.ref_sha, REF_SHA);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).schema, receipt.schema);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stateful live lifecycle bootstraps, releases, unfences, and admits a successor", async () => {
  const server = createLiveFenceServer();
  const common = {
    token: "github-token",
    repository: "cityscroll/cityscroll-app",
    now: new Date("2026-10-28T20:00:00Z"),
    fetchImpl: server.fetch,
  };
  const first = await setLiveFenceWindow({ ...common, windowId: "window-1", expiresAt: "2026-10-28T21:00:00Z" });
  assert.equal(first.generation, 1);
  assert.equal(server.bootstrapCalls, 1);
  assert.equal(server.putCalls, 1);
  assert.equal(server.refExists, true);
  assert.equal(first.bootstrap_post, "ATTEMPTED");
  assert.equal(first.bootstrap_acknowledgement, "CONFIRMED");
  assert.equal(first.bootstrap_creator, "CONFIRMED");
  // A fresh process can recover the durable branch/file without replaying the
  // bootstrap or creating a second generation.
  const restarted = await readLiveFenceState(common);
  assert.equal(restarted.window_id, "window-1");
  assert.equal(restarted.generation, 1);

  await assert.rejects(
    () => releaseLiveFenceWindow({ ...common, windowId: "window-1", generation: 1 }),
    /proof-bound restoration/,
  );
  const released = await releaseLiveFenceWindow({
    ...common,
    windowId: "window-1",
    generation: 1,
    restoreProof: { restored: true, window_id: "window-1", generation: 1, observed_at: "2026-10-28T20:10:00Z" },
  });
  assert.equal(released.state, "RELEASED");
  assert.equal(released.fenced, false);

  const ordinary = await assertLiveWriterWindow({ ...common, windowId: "ordinary-deploy" });
  assert.equal(ordinary.allowed, true);
  await assert.rejects(() => assertLiveWriterWindow({ ...common, windowId: "window-1" }), /retired window tuple/);
  await assert.rejects(
    () => setLiveFenceWindow({ ...common, windowId: "window-1", expiresAt: "2026-10-28T22:00:00Z" }),
    /retired fence window/,
  );

  const successor = await setLiveFenceWindow({ ...common, windowId: "window-2", expiresAt: "2026-10-28T22:00:00Z" });
  assert.equal(successor.generation, 2);
  assert.equal(successor.window_id, "window-2");
  await assert.rejects(
    () => releaseLiveFenceWindow({
      ...common,
      windowId: "window-1",
      generation: 1,
      restoreProof: { restored: true, window_id: "window-1", generation: 1, observed_at: "2026-10-28T20:11:00Z" },
    }),
    /exact active owned generation/,
  );

  server.document = { window_id: "foreign", expires_at: "2026-10-28T23:00:00Z", generation: 3, status: "ACTIVE" };
  await assert.rejects(
    () => setLiveFenceWindow({ ...common, windowId: "window-3", expiresAt: "2026-10-28T23:30:00Z" }),
    /refuses foreign window/,
  );
});

test("live arm performs one compare write and never retries an unacknowledged failure", async () => {
  const server = createLiveFenceServer({ initialRef: true, initialDocument: {
    window_id: "owned-window", expires_at: "2026-10-28T21:00:00Z", generation: 7, status: "ACTIVE",
  } });
  const fetchLive = server.fetch;
  server.fetch = async (url, options = {}) => {
    if (url.includes("/contents/") && options.method === "PUT") {
      server.putCalls += 1;
      return githubResponse(405, { message: "method not allowed" });
    }
    return fetchLive(url, options);
  };
  await assert.rejects(
    () => setLiveFenceWindow({
      token: "github-token", repository: "cityscroll/cityscroll-app", windowId: "owned-window",
      expiresAt: "2026-10-28T21:30:00Z", now: new Date("2026-10-28T20:00:00Z"),
      fetchImpl: server.fetch,
    }),
    /live fence arm failed with HTTP 405/,
  );
  assert.equal(server.putCalls, 1);
});

test("release compare rejects a concurrent file update without retrying", async () => {
  const server = createLiveFenceServer({ initialRef: true, initialDocument: {
    window_id: "owned-window", expires_at: "2026-10-28T21:00:00Z", generation: 7, status: "ACTIVE",
  } });
  const fetchLive = server.fetch;
  let raced = false;
  server.fetch = async (url, options = {}) => {
    if (url.includes("/contents/") && options.method === "PUT" && !raced) {
      raced = true;
      server.fileSha = "d".repeat(40);
      server.document = { window_id: "other-window", expires_at: "2026-10-28T22:00:00Z", generation: 8, status: "ACTIVE" };
    }
    return fetchLive(url, options);
  };
  await assert.rejects(
    () => releaseLiveFenceWindow({
      token: "github-token", repository: "cityscroll/cityscroll-app", windowId: "owned-window", generation: 7,
      restoreProof: { restored: true, window_id: "owned-window", generation: 7, observed_at: "2026-10-28T20:10:00Z" },
      now: new Date("2026-10-28T20:00:00Z"), fetchImpl: server.fetch,
    }),
    /live fence arm failed with HTTP 409/,
  );
  assert.equal(server.putCalls, 1);
});

test("unacknowledged first-use bootstrap stays UNKNOWN while file CAS is separate", async () => {
  const server = createLiveFenceServer({ bootstrapMode: "unacknowledged" });
  const result = await setLiveFenceWindow({
    token: "github-token", repository: "cityscroll/cityscroll-app", windowId: "owned-window",
    expiresAt: "2026-10-28T21:30:00Z", now: new Date("2026-10-28T20:00:00Z"), fetchImpl: server.fetch,
  });
  assert.equal(result.bootstrap_post, "ATTEMPTED");
  assert.equal(result.bootstrap_acknowledgement, "UNKNOWN");
  assert.equal(result.bootstrap_creator, "UNKNOWN");
  assert.equal(result.write_acknowledged, true);
  assert.equal(server.bootstrapCalls, 1);
  assert.equal(server.putCalls, 1);
});

test("unacknowledged bootstrap rejects a foreign document without a blind PUT", async () => {
  const server = createLiveFenceServer({ bootstrapMode: "unacknowledged" });
  const fetchLive = server.fetch;
  server.fetch = async (url, options = {}) => {
    if (url.endsWith("/git/refs") && options.method === "POST") {
      server.bootstrapCalls += 1;
      server.refExists = true;
      server.fileSha = FILE_SHA;
      server.document = {
        window_id: "foreign-window", expires_at: "2026-10-28T21:00:00Z", generation: 4, status: "ACTIVE",
      };
      return githubResponse(500, { message: "ack lost after a foreign creator" });
    }
    return fetchLive(url, options);
  };
  await assert.rejects(
    () => setLiveFenceWindow({
      token: "github-token", repository: "cityscroll/cityscroll-app", windowId: "owned-window",
      expiresAt: "2026-10-28T21:30:00Z", now: new Date("2026-10-28T20:00:00Z"), fetchImpl: server.fetch,
    }),
    /refuses foreign window/,
  );
  assert.equal(server.bootstrapCalls, 1);
  assert.equal(server.putCalls, 0);
});

test("unacknowledged first-use bootstrap with no visible ref stays unknown without retry", async () => {
  const server = createLiveFenceServer({ bootstrapMode: "normal" });
  const fetchLive = server.fetch;
  server.fetch = async (url, options = {}) => {
    if (url.endsWith("/git/refs") && options.method === "POST") {
      server.bootstrapCalls += 1;
      return githubResponse(500, { message: "ack lost and ref was not created" });
    }
    return fetchLive(url, options);
  };
  await assert.rejects(
    () => setLiveFenceWindow({
      token: "github-token", repository: "cityscroll/cityscroll-app", windowId: "owned-window",
      expiresAt: "2026-10-28T21:30:00Z", now: new Date("2026-10-28T20:00:00Z"), fetchImpl: server.fetch,
    }),
    /bootstrap acknowledgement is unknown/,
  );
  assert.equal(server.bootstrapCalls, 1);
  assert.equal(server.putCalls, 0);
});

test("real fetch aborts a stalled body and the child exits within the bound", async () => {
  const childRoot = mkdtempSync(join(tmpdir(), "worker-fence-real-fetch-child-"));
  let bodyClosed = false;
  let resolveBodyClosed;
  const bodyClosedPromise = new Promise((resolve) => { resolveBodyClosed = resolve; });
  const server = createServer((request, response) => {
    const url = request.url || "";
    if (url.startsWith("/repos/cityscroll/cityscroll-app/git/matching-refs/heads/deploy-fence")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ ref: "refs/heads/deploy-fence", object: { sha: REF_SHA } }]));
      return;
    }
    if (url.startsWith("/repos/cityscroll/cityscroll-app/contents/.github/worker-deploy-fence.json")) {
      const markClosed = () => {
        bodyClosed = true;
        resolveBodyClosed();
      };
      request.once("aborted", markClosed);
      response.once("close", markClosed);
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"type":"file","encoding":"base64","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","content":"');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  assert.ok(port, "local fixture must expose a TCP port");
  const childPath = join(childRoot, "real-fetch-child.mjs");
  writeFileSync(childPath, `
    import { readLiveFenceState } from ${JSON.stringify(HELPER)};
    try {
      await readLiveFenceState({
        token: "fake-local-credential",
        repository: "cityscroll/cityscroll-app",
        apiBase: "http://127.0.0.1:${port}",
        requestTimeoutMs: 80,
      });
      process.exitCode = 2;
    } catch (error) {
      if (!/response body timed out/.test(String(error?.message))) {
        console.error(error);
        process.exitCode = 3;
      }
    }
  `);
  const child = spawn(process.execPath, [childPath], {
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const startedAt = Date.now();
  const childResult = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", timedOut: true });
    }, 1_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut: false });
    });
  });
  try {
    assert.equal(childResult.timedOut, false, `real-fetch child exceeded bound: ${stderr}`);
    assert.equal(childResult.code, 0, stderr);
    assert.ok(Date.now() - startedAt < 1_000, "real-fetch child must exit within the bound");
    await Promise.race([bodyClosedPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
    assert.equal(bodyClosed, true, "the stalled HTTP response body must be closed by abort/cancel");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(childRoot, { recursive: true, force: true });
  }
});

test("drain reads every active-status page and bounds a hanging request", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, status: "queued" }));
  let pageCalls = 0;
  const runs = await listActiveDeployRuns({
    token: "github-token", repository: "cityscroll/cityscroll-app", statuses: ["queued"], maxPages: 3,
    fetchImpl: async (url) => {
      pageCalls += 1;
      return /[?&]page=1(?:&|$)/.test(url)
        ? githubResponse(200, { workflow_runs: firstPage })
        : githubResponse(200, { workflow_runs: [{ id: 101, status: "queued" }] });
    },
  });
  assert.equal(pageCalls, 2);
  assert.equal(runs.length, 101);
  await assert.rejects(
    () => readLiveFenceState({
      token: "github-token", repository: "cityscroll/cityscroll-app", requestTimeoutMs: 5,
      fetchImpl: async () => new Promise(() => {}),
    }),
    /timed out after 5ms/,
  );
  await assert.rejects(
    () => readLiveFenceState({
      token: "github-token", repository: "cityscroll/cityscroll-app", requestTimeoutMs: 5,
      fetchImpl: async () => githubResponse(200, null, "", () => new Promise(() => {})),
    }),
    /response body timed out after 5ms/,
  );
});

test("workflow and local token wrapper use the live last-moment assertion", () => {
  const workflow = readFileSync(join(process.cwd(), ".github/workflows/deploy-worker.yml"), "utf8");
  const wrapper = readFileSync(join(process.cwd(), "tools/run_with_cloudflare_deploy_token.sh"), "utf8");
  const fenceSource = readFileSync(join(process.cwd(), "tools/worker_deploy_fence.mjs"), "utf8");
  assert.match(workflow, /group: worker-deploy/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+actions: read/);
  assert.match(workflow, /WORKER_DEPLOY_FENCE_REF: refs\/heads\/deploy-fence/);
  assert.match(workflow, /WORKER_DEPLOY_FENCE_PATH: \.github\/worker-deploy-fence\.json/);
  assert.match(workflow, /WORKER_DEPLOY_FENCE_LIVE_ASSERT: "true"/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /WORKER_DEPLOY_FENCE_ROOT/);
  assert.match(workflow, /WORKER_DEPLOY_FENCE_WINDOW: "\$\{\{ github\.run_id \}\}:\$\{\{ github\.run_attempt \}\}"/);
  assert.match(workflow, /environment:\n\s+name: worker-deploy/);
  assert.doesNotMatch(workflow, /worker_deploy_fence\.mjs (acquire|drain|release)/);
  assert.match(workflow, /worker_deploy_fence\.mjs live-assert/);
  assert.doesNotMatch(workflow, /WORKER_DEPLOY_FENCE_VARIABLE|actions\/variables/);
  assert.doesNotMatch(fenceSource, /actions\/variables/);
  assert.match(fenceSource, /\/git\/matching-refs\/heads\//);
  assert.match(fenceSource, /\/git\/refs/);
  assert.match(fenceSource, /\/contents\//);
  assert.match(wrapper, /worker_deploy_fence\.mjs" live-assert/);
  assert.match(wrapper, /worker_deploy_fence\.mjs" assert/);
  assert.match(wrapper, /is_exact_read_only_command/);
  assert.match(wrapper, /WORKER_DEPLOY_FENCE_REQUIRED=true is required for credentialed commands/);
  assert.match(wrapper, /versions list --json/);
  assert.match(wrapper, /versions deploy/);
  assert.doesNotMatch(wrapper, /is_mutating_command/);
});
