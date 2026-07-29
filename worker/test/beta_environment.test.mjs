import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("beta deploy targets a distinct Worker and custom domain", () => {
  const config = read("../wrangler.toml");
  const beta = config.slice(config.indexOf("[env.beta]"));

  assert.match(beta, /^\[env\.beta\]$/m);
  assert.match(beta, /api-beta\.cityscroll\.org/);
  assert.match(beta, /api-beta\.crol-list\.org/);
  assert.match(beta, /custom_domain = true/);
  assert.match(beta, /workers_dev = true/);
  assert.match(beta, /^\[env\.beta\.vars\]$/m);
  assert.match(beta, /^DEPLOYMENT_CHANNEL = "beta"$/m);
});

test("beta carries no production write, delivery, analytics, queue, or cron bindings", () => {
  const config = read("../wrangler.toml");
  const beta = config.slice(config.indexOf("[env.beta]"));

  for (const heading of [
    "d1_databases",
    "kv_namespaces",
    "r2_buckets",
    "analytics_engine_datasets",
    "queues",
    "triggers",
  ]) {
    assert.doesNotMatch(beta, new RegExp(`\\[\\[?env\\.beta\\.${heading}`), heading);
  }
  assert.match(beta, /^ALERTS_LIVE = "false"$/m);
  assert.match(beta, /^QUEUE_DIGESTS = "false"$/m);
  assert.match(beta, /^ANALYTICS_ENVIRONMENT = "preview"$/m);
  assert.match(beta, /^SOURCE_VAULT_ENABLED = "false"$/m);
});

test("production Worker routes carry canonical and compatibility domains", () => {
  const config = read("../wrangler.toml");
  const production = config.slice(0, config.indexOf("[env.beta]"));
  for (const hostname of [
    "api.cityscroll.org",
    "api.crol-list.org",
    "cityscroll.org",
    "www.cityscroll.org",
  ]) {
    assert.match(production, new RegExp(`pattern = "${hostname.replaceAll(".", "\\.")}"`));
  }
  assert.match(production, /crons = \["0 13 \* \* \*"\]/);

  const deploy = read("../../.github/workflows/deploy-worker.yml");
  assert.match(deploy, /branches: \[main\]/);
  assert.doesNotMatch(deploy, /--env beta/);
});

test("beta Worker deployment is manual, exact-commit, and opt-in", () => {
  const workflow = read("../../.github/workflows/deploy-worker-beta.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/m);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /ref: \$\{\{ inputs\.commit_sha \}\}/);
  assert.match(workflow, /command: deploy --env beta/);
  assert.match(workflow, /https:\/\/api-beta\.cityscroll\.org\/health/);
});
