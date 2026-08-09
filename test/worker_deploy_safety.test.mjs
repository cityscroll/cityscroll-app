import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  digestDeployDelayMs,
  waitForDigestCronWindow,
} from "../tools/wait_for_digest_cron_window.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Worker routes retain API domains and claim only canonical dynamic-document paths", () => {
  const config = read("worker/wrangler.toml");
  const start = config.indexOf("routes = [");
  const routeBlock = config.slice(start, config.indexOf("]", start) + 1);
  assert.match(routeBlock, /api\.cityscroll\.org/);
  assert.match(routeBlock, /api\.crol-list\.org/);
  assert.match(routeBlock, /pattern = "cityscroll\.org\/near-you\*"/);
  assert.match(routeBlock, /pattern = "cityscroll\.org\/following\*"/);
  assert.match(routeBlock, /pattern = "cityscroll\.org\/prefs\*"/);
  assert.doesNotMatch(routeBlock, /pattern = "cityscroll\.org"\s*,\s*custom_domain/);
  assert.doesNotMatch(routeBlock, /pattern = "www\.cityscroll\.org"/);
});

test("Worker deploys when shared Following source changes and smokes the canonical empty state", () => {
  const workflow = read(".github/workflows/deploy-worker.yml");
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /- "worker\/\*\*"/);
  assert.match(workflow, /- "site\/following_view\.mjs"/);
  assert.match(workflow, /- "site\/data\/watch_templates\.json"/);
  assert.match(workflow, /- "\.github\/workflows\/deploy-worker\.yml"/);
  assert.match(workflow, /CROL_BASE: https:\/\/cityscroll\.org\//);
  assert.match(workflow, /CROL_DEMO_LINK_IDS: alerts-builder/);
  assert.match(workflow, /python3 test\/functional\/20_demo_links\.py/);
});

test("digest deploy guard covers trigger propagation before the cron", () => {
  assert.equal(digestDeployDelayMs(new Date("2026-08-03T12:39:59.999Z")), 0);
  assert.equal(digestDeployDelayMs(new Date("2026-08-03T12:40:00.000Z")), 25 * 60_000);
  assert.equal(digestDeployDelayMs(new Date("2026-08-03T12:58:49.902Z")), 370_098);
  assert.equal(digestDeployDelayMs(new Date("2026-08-03T13:05:00.000Z")), 0);
});

test("deploy workflow runs the digest guard immediately before Wrangler deploy", () => {
  const workflow = read(".github/workflows/deploy-worker.yml");
  const guard = workflow.indexOf("node tools/wait_for_digest_cron_window.mjs");
  const deploy = workflow.indexOf("name: Deploy", guard);
  assert.ok(guard >= 0 && deploy > guard);
  assert.doesNotMatch(workflow.slice(guard, deploy), /uses: cloudflare\/wrangler-action/);
});

test("wait helper sleeps through the protected window and emits progress", async () => {
  let current = new Date("2026-08-03T13:04:30.000Z");
  const waits = [];
  const logs = [];
  const waited = await waitForDigestCronWindow({
    now: () => current,
    sleep: async (ms) => {
      waits.push(ms);
      current = new Date(current.getTime() + ms);
    },
    log: (line) => logs.push(line),
  });
  assert.equal(waited, 30_000);
  assert.deepEqual(waits, [30_000]);
  assert.match(logs.join("\n"), /waiting 1 minute/);
  assert.match(logs.join("\n"), /protected window cleared/);
});
