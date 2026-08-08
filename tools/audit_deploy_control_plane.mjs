#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const config = JSON.parse(read("docs/release/cloudflare-native-builds.json"));

const failures = [];
function requireCheck(condition, message) {
  if (!condition) failures.push(message);
}

const pagesWorkflow = read(".github/workflows/deploy-cloudflare-pages.yml");
const workerWorkflow = read(".github/workflows/deploy-worker.yml");
const sharedBuild = read(".github/actions/build-site/action.yml");
const pagesFallback = read(".github/workflows/deploy-pages.yml");
const runOnlyManually = (workflow, name) => {
  const trigger = workflow.match(/^on:\n([\s\S]*?)\n(?=(?:permissions|concurrency|jobs):)/m)?.[1] || "";
  requireCheck(/workflow_dispatch:/.test(trigger), `${name} must retain a manual fallback trigger`);
  requireCheck(!/^\s+(?:push|pull_request|schedule):/m.test(trigger), `${name} must not auto-deploy from GitHub events`);
};
const deployOnMainPush = (workflow, name) => {
  const trigger = workflow.match(/^on:\n([\s\S]*?)\n(?=(?:permissions|concurrency|jobs):)/m)?.[1] || "";
  requireCheck(/workflow_dispatch:/.test(trigger), `${name} must retain a manual recovery trigger`);
  requireCheck(/^\s+push:\n\s+branches:\s*\[main\]/m.test(trigger), `${name} must deploy every main push`);
  requireCheck(!/^\s+(?:pull_request|schedule):/m.test(trigger), `${name} must not deploy from pull requests or schedules`);
};

requireCheck(config.schema === "cityscroll.cloudflare-native-builds.v1", "native build contract schema is missing");
requireCheck(config.pages?.release_control_plane === "github_actions", "Pages releases must be owned by GitHub Actions");
requireCheck(config.pages?.production_branch === "main", "Pages production branch must remain main");
requireCheck(config.pages?.build_output_directory === "_site", "Pages output directory must remain _site");
requireCheck(config.pages?.build_command?.includes("build_cloudflare_pages.mjs"), "Pages must call the provider-neutral build script");
requireCheck(config.worker?.root_directory === "worker", "Worker Builds root directory must remain worker");
requireCheck(config.worker?.deploy_command?.includes("wrangler deploy"), "Worker Builds must deploy through Wrangler");
requireCheck(config.worker?.deploy_command?.includes("d1 migrations apply"), "Worker Builds must apply D1 migrations before deploy");
requireCheck(!sharedBuild.includes("actions/jekyll-build-pages@"), "shared build must not depend on the Jekyll GitHub Action");
requireCheck(sharedBuild.includes("build_cloudflare_pages.mjs"), "shared build must call the provider-neutral build script");
requireCheck(/manual fallback/i.test(workerWorkflow), "Worker workflow must identify itself as a manual fallback");
deployOnMainPush(pagesWorkflow, "Cloudflare Pages workflow");
runOnlyManually(workerWorkflow, "Worker workflow");
requireCheck(/actions\/deploy-pages@v4/.test(pagesFallback), "GitHub Pages fallback must remain intact");
requireCheck(/Keep it|Retire it/.test(read("docs/release/cloudflare-native-builds.md")), "fallback keep/retire decision must be documented");

if (process.argv.includes("--check")) {
  if (failures.length) {
    console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log("Deploy control plane OK: GitHub Actions deploys Pages on main pushes; the Worker workflow remains a manual fallback; GitHub Pages remains intact.");
} else {
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
}
