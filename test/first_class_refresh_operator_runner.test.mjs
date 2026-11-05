import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

test("operator refresh preflight alerts on refusal and restores incidental tracked writes", async () => {
  const { stdout } = await run("bash", ["ops/first-class-refresh/test-preflight.sh"], {
    cwd: root,
    env: process.env,
  });
  assert.match(stdout, /all preflight cases passed/);
  assert.match(stdout, /dirty default branch refuses/);
  assert.match(stdout, /checkout is clean on the default branch/);
});

test("operator preflight refusal uses the retained owner-alert workflow", async () => {
  const [preflight, workflow] = await Promise.all([
    readFile(new URL("../ops/first-class-refresh/preflight.sh", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/reliability-watchdogs.yml", import.meta.url), "utf8"),
  ]);
  assert.match(preflight, /gh workflow run reliability-watchdogs\.yml/);
  assert.match(preflight, /operator_preflight_refusal=true/);
  assert.match(workflow, /operator-preflight-refusal:/);
  assert.match(workflow, /node tools\/deliver_ops_alert\.mjs/);
  assert.match(workflow, /operator-preflight-refusal-delivery-receipt\.json/);
  assert.equal(
    workflow.match(/github\.event_name != 'workflow_dispatch' \|\| inputs\.operator_preflight_refusal != true/g)?.length,
    3,
    "the alert-only dispatch must not run the scheduled watchdog jobs",
  );
});
