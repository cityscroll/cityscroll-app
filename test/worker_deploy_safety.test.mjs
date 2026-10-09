import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  digestDeployDelayMs,
  waitForDigestCronWindow,
} from "../tools/wait_for_digest_cron_window.mjs";
import {
  normalizedExecutables,
  normalizedRunCommands,
  parseWorkflowText,
  shellArgv,
} from "../tools/check_github_workflows_yaml.mjs";

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
  assert.match(workflow, /check_deployment_health\.mjs --write/);
  assert.match(workflow, /--boundary cloudflare-worker/);
  assert.match(workflow, /- "worker\/\*\*"/);
  assert.match(workflow, /- "site\/following_view\.mjs"/);
  assert.match(workflow, /- "site\/data\/watch_templates\.json"/);
  assert.match(workflow, /- "\.github\/workflows\/deploy-worker\.yml"/);
  assert.match(workflow, /CROL_BASE: https:\/\/cityscroll\.org\//);
  assert.match(workflow, /CROL_DEMO_LINK_IDS: alerts-builder/);
  assert.match(workflow, /python3 test\/functional\/20_demo_links\.py/);
});

test("Worker deploy uses the pinned dry-run budget and read-model canary guard", () => {
  const workflow = read(".github/workflows/deploy-worker.yml");
  assert.match(workflow, /npx wrangler@4\.126\.0 deploy --dry-run/);
  assert.match(workflow, /tools\/worker_deploy_guard\.mjs/);
  assert.match(workflow, /--read-model-dir/);
  assert.match(workflow, /64 MiB/);
});

test("deploy workflow preserves ordinary deploys and gates only activated promotion", () => {
  const workflow = parseWorkflowText(read(".github/workflows/deploy-worker.yml"), {
    filename: "deploy-worker.yml",
  })[0];
  const steps = workflow.jobs.deploy.steps;
  const publication = steps.find((step) => step.name === "Publish Near You and meeting route read models");
  assert.equal(publication.run, "node tools/worker_route_publication.mjs publish --route-dir \"$RUNNER_TEMP/cityscroll-worker-route-read-models\"");
  const enforcement = steps.find((step) => step.name === "Resolve Worker cost-control enforcement");
  assert.equal(enforcement.env.WORKER_COST_ENFORCEMENT, "${{ vars.WORKER_COST_ENFORCEMENT }}");
  assert.deepEqual(normalizedExecutables(enforcement.run), [[
    "node", "tools/worker_cost_control.mjs", "enforcement-mode",
    "--value-env", "WORKER_COST_ENFORCEMENT",
    "--github-output", "$GITHUB_OUTPUT",
  ]]);
  const gate = steps.find((step) => step.name === "Enforce the all-meter Worker release gate");
  assert.equal(gate.if, "${{ steps.cost_enforcement.outputs.mode == 'active' && steps.cost_binding.outputs.promotion-state == 'staged' }}");
  assert.equal(gate.env.WORKER_COST_BASELINE_EVIDENCE, "${{ vars.WORKER_COST_BASELINE_EVIDENCE }}");
  assert.equal(gate.env.WORKER_COST_CANDIDATE_EVIDENCE, "${{ vars.WORKER_COST_CANDIDATE_EVIDENCE }}");
  assert.deepEqual(shellArgv(gate.run), [
    "node", "tools/worker_cost_control.mjs", "release-evaluate",
    "--baseline-env", "WORKER_COST_BASELINE_EVIDENCE",
    "--candidate-env", "WORKER_COST_CANDIDATE_EVIDENCE",
    "--acquired-split-deployments", "$RUNNER_TEMP/cityscroll-worker-cost-control/split-deployments.json",
    "--expected-candidate-revision", "$GITHUB_SHA",
  ]);
  const acquisition = steps.find((step) => step.name === "Acquire staged candidate and rollback bindings");
  assert.equal(acquisition.id, "cost_binding");
  assert.equal(acquisition.if, "${{ steps.cost_enforcement.outputs.mode == 'active' }}");
  const acquisitionCommands = normalizedRunCommands(acquisition.run);
  assert.deepEqual(acquisitionCommands.find((argv) => argv[0] === "npx" && argv[2] === "deployments"), [
    "npx", "wrangler@4.126.0", "deployments", "status", "--json",
  ]);
  assert.deepEqual(acquisitionCommands.find((argv) => argv.includes("promotion-plan")), [
    "node", "tools/cloudflare_deployment_binding.mjs", "promotion-plan",
    "--provider-status", "$state_dir/provider-status.json",
    "--provider-versions", "$state_dir/provider-versions.json",
    "--expected-revision", "$GITHUB_SHA",
    "--out", "$state_dir/promotion-plan.json",
  ]);
  assert.deepEqual(acquisitionCommands.find((argv) => argv.includes("acquire-split")), [
    "node", "tools/cloudflare_deployment_binding.mjs", "acquire-split",
    "--provider-status", "$state_dir/provider-status.json",
    "--provider-versions", "$state_dir/provider-versions.json",
    "--health-url", "https://cityscroll-worker.crol-worker.workers.dev/health",
    "--worker-name", "cityscroll-worker",
    "--baseline-revision", "$baseline_revision",
    "--expected-revision", "$GITHUB_SHA",
    "--out", "$state_dir/split-deployments.json",
  ]);
  assert.deepEqual(acquisitionCommands.find((argv) => argv.includes("acquire") && !argv.includes("acquire-split")), [
    "node", "tools/cloudflare_deployment_binding.mjs", "acquire",
    "--provider-status", "$state_dir/provider-status.json",
    "--provider-versions", "$state_dir/provider-versions.json",
    "--health-url", "https://cityscroll-worker.crol-worker.workers.dev/health",
    "--worker-name", "cityscroll-worker",
    "--expected-revision", "$GITHUB_SHA",
    "--out", "$state_dir/retry-deployment.json",
  ]);
  const promotion = steps.find((step) => step.name === "Deploy");
  const promotionCommands = normalizedExecutables(promotion.run);
  assert.deepEqual(promotionCommands.find((argv) => argv.includes("promotion-recheck")), [
    "node", "tools/cloudflare_deployment_binding.mjs", "promotion-recheck",
    "--initial-plan", "$RUNNER_TEMP/cityscroll-worker-cost-control/promotion-plan.json",
    "--provider-status", "$state_dir/provider-status.json",
    "--provider-versions", "$state_dir/provider-versions.json",
    "--expected-revision", "$GITHUB_SHA",
    "--out", "$state_dir/promotion-plan.json",
  ]);
  assert.deepEqual(promotionCommands.find((argv) => argv.includes("acquire")), [
    "node", "tools/cloudflare_deployment_binding.mjs", "acquire",
    "--provider-status", "$state_dir/provider-status.json",
    "--provider-versions", "$state_dir/provider-versions.json",
    "--health-url", "https://cityscroll-worker.crol-worker.workers.dev/health",
    "--worker-name", "cityscroll-worker",
    "--expected-revision", "$GITHUB_SHA",
    "--out", "$state_dir/retry-deployment.json",
  ]);
  assert.deepEqual(promotionCommands
    .filter((argv) => argv[0] === "npx" && argv[1] === "wrangler@4.126.0")
    .map((argv) => argv.slice(2, 5)), [
    ["deploy", "--var", "GIT_COMMIT_SHA:$GITHUB_SHA"],
    ["deployments", "status", "--json"],
    ["versions", "list", "--json"],
    ["versions", "deploy", "${candidate}@100%"],
  ]);
});

test("canary stage is manual-only and isolated from publication jobs", () => {
  const workflow = parseWorkflowText(read(".github/workflows/deploy-worker.yml"), {
    filename: "deploy-worker.yml",
  })[0];
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.release_mode.options, ["promote", "stage"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.release_mode.default, "promote");
  assert.equal(workflow.jobs.stage.if, "${{ github.event_name == 'workflow_dispatch' && inputs.release_mode == 'stage' }}");
  assert.equal(workflow.jobs.deploy.if, "${{ github.event_name != 'workflow_dispatch' || inputs.release_mode != 'stage' }}");
  assert.deepEqual(workflow.jobs.stage.steps.map((step) => step.name || step.uses), [
    "actions/checkout@v4",
    "pnpm/action-setup@v4",
    "actions/setup-node@v4",
    "Install worker dependencies",
    "Inspect bounded canary state",
    "Upload exact tagged canary version",
    "Assign bounded canary traffic",
    "Verify bounded canary traffic",
  ]);
  const inspect = workflow.jobs.stage.steps.find((step) => step.name === "Inspect bounded canary state");
  const inspectCommands = normalizedRunCommands(inspect.run);
  assert.deepEqual(inspectCommands.find((argv) => argv.includes("stage-plan")), [
    "node", "tools/cloudflare_deployment_binding.mjs", "stage-plan",
    "--provider-status", "$state_dir/provider-status.json",
    "--provider-versions", "$state_dir/provider-versions.json",
    "--event-name", "$GITHUB_EVENT_NAME",
    "--release-mode", "stage",
    "--expected-revision", "$GITHUB_SHA",
    "--out", "$state_dir/initial-stage-plan.json",
  ]);
  const commands = workflow.jobs.stage.steps.flatMap((step) => normalizedExecutables(step.run || ""));
  const wranglerCommands = commands
    .filter((argv) => argv[0] === "npx" && argv[1] === "wrangler@4.126.0")
    .map((argv) => argv.slice(2, 5));
  assert.deepEqual(wranglerCommands, [
    ["deployments", "status", "--json"],
    ["versions", "list", "--json"],
    ["versions", "upload", "--tag"],
    ["deployments", "status", "--json"],
    ["versions", "list", "--json"],
    ["versions", "deploy", "${rollback}@95%"],
    ["deployments", "status", "--json"],
    ["versions", "list", "--json"],
  ]);
  assert.deepEqual(commands
    .filter((argv) => argv[0] === "node" && argv[1] === "tools/cloudflare_deployment_binding.mjs")
    .map((argv) => argv[2]), ["stage-plan", "stage-recheck", "promotion-plan"]);
  for (const argv of commands) {
    assert.ok(
      argv[0] === "tools/install_worker_dependencies.sh"
      || (argv[0] === "npx" && argv[1] === "wrangler@4.126.0")
      || (argv[0] === "node" && ["-p", "tools/cloudflare_deployment_binding.mjs"].includes(argv[1])),
      `unexpected executable in stage job: ${argv.join(" ")}`,
    );
  }
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
