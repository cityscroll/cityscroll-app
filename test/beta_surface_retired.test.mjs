import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { parseBindings, parseRoutes } from "../tools/build_architecture_facts.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function workflowJobs(source) {
  const jobs = [];
  let current = null;
  let inJobs = false;
  for (const line of source.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobKey = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobKey) {
      current = { id: jobKey[1], name: jobKey[1], steps: [] };
      jobs.push(current);
      continue;
    }
    const jobName = line.match(/^    name:\s*(.+?)\s*$/);
    if (jobName && current && current.steps.length === 0) {
      current.name = jobName[1].replace(/^["']|["']$/g, "");
      continue;
    }
    const stepName = line.match(/^      - name:\s*(.+?)\s*$/);
    if (stepName && current) {
      current.steps.push({ name: stepName[1], run: "" });
      continue;
    }
    const run = line.match(/^        run:\s*(.*)$/);
    if (run && current?.steps.length) current.steps.at(-1).run = run[1];
  }
  return jobs;
}

test("retired beta deploy workflows are absent from the workflow inventory", () => {
  const names = new Set(readdirSync(new URL("../.github/workflows", import.meta.url)));
  for (const name of [
    "deploy-beta-preview.yml",
    "promote-beta.yml",
    "deploy-worker-beta.yml",
  ]) {
    assert.equal(names.has(name), false, name);
    assert.equal(existsSync(new URL(`../.github/workflows/${name}`, import.meta.url)), false);
  }
  assert.equal(names.has("deploy-cloudflare-pages.yml"), true);
  assert.equal(names.has("deploy-worker.yml"), true);
  assert.equal(names.has("ci.yml"), true);
});

test("CI no longer registers a beta preview job or alias-contract step", () => {
  const source = read(".github/workflows/ci.yml");
  const jobs = workflowJobs(source);
  assert.ok(jobs.length > 0);
  assert.equal(jobs.some((job) => /beta preview/i.test(job.name)), false);
  for (const job of jobs) {
    for (const step of job.steps) {
      assert.doesNotMatch(step.name, /beta preview/i);
      assert.doesNotMatch(step.run, /check_beta_review_contract/);
    }
  }
  const frontendJob = jobs.find((job) => job.id === "changes");
  assert.ok(frontendJob);
  assert.doesNotMatch(source, /deploy-beta-preview\.yml/);
  assert.doesNotMatch(source, /promote-beta\.yml/);
});

test("Wrangler facts expose production only", () => {
  const wrangler = read("worker/wrangler.toml");
  const routes = parseRoutes(wrangler);
  const bindings = parseBindings(wrangler).environments;
  assert.equal("beta" in bindings, false);
  assert.equal(routes.some((route) => route.environment === "beta"), false);
  assert.ok(routes.some((route) => route.pattern === "api.cityscroll.org" && route.environment === "production"));
  assert.ok(bindings.production.vars.ANALYTICS_ENVIRONMENT?.value === "production");
});

test("review-only tooling is gone while in-bundle flags remain", () => {
  for (const path of [
    "tools/ensure_beta_pages.mjs",
    "tools/check_beta_review_contract.mjs",
    "tools/prepare_review_artifact.py",
    "docs/beta-channel.md",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
  }
  assert.equal(existsSync(new URL("../docs/beta-rebuild-recipe.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../docs/beta-flags.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../site/beta-flags.json", import.meta.url)), true);
  assert.equal(existsSync(new URL("../tools/validate_beta_flags.mjs", import.meta.url)), true);
});
