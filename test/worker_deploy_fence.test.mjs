import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquire,
  assertCurrentWriter,
  release,
  WORKER_DEPLOY_FENCE_SCHEMA,
} from "../tools/worker_deploy_fence.mjs";

const HELPER = join(process.cwd(), "tools/worker_deploy_fence.mjs");

function envFor(root, owner = "run-1") {
  return {
    ...process.env,
    WORKER_DEPLOY_FENCE_ROOT: root,
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

test("workflow and local token wrapper both require the same last-moment assertion", () => {
  const workflow = readFileSync(join(process.cwd(), ".github/workflows/deploy-worker.yml"), "utf8");
  const wrapper = readFileSync(join(process.cwd(), "tools/run_with_cloudflare_deploy_token.sh"), "utf8");
  assert.match(workflow, /group: worker-deploy/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /worker_deploy_fence\.mjs acquire/);
  assert.match(workflow, /worker_deploy_fence\.mjs assert/);
  assert.match(wrapper, /worker_deploy_fence\.mjs" assert/);
});
