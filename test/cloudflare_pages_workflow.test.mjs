import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare Pages deploy runs alongside GitHub Pages and does not replace it", () => {
  const cf = read(".github/workflows/deploy-cloudflare-pages.yml");
  const gh = read(".github/workflows/deploy-pages.yml");

  assert.match(gh, /Deploy to GitHub Pages/);
  assert.match(gh, /actions\/deploy-pages@v4/);
  assert.match(cf, /pages deploy _site/);
  assert.match(cf, /--project-name=cityscroll/);
  assert.match(cf, /--branch=main/);
  assert.doesNotMatch(cf, /deploy-pages@v4/);
  assert.doesNotMatch(cf, /cloudflare_pages.*replace|disable.*github pages/i);
});

test("Cloudflare Pages workflow provisions the project before first deploy", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  const ensure = workflow.indexOf("tools/ensure_stable_pages.mjs project");
  const deploy = workflow.indexOf("pages deploy _site");
  assert.ok(ensure >= 0 && ensure < deploy, "Pages project must exist before deploy");
});

test("Cloudflare Pages workflow never attaches apex hostnames (cutover is a runbook)", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.doesNotMatch(workflow, /ensure_stable_pages\.mjs domain/);
  assert.doesNotMatch(workflow, /--domain=/);
  assert.doesNotMatch(workflow, /pages domain add/i);
  const runbook = read("docs/hosting-cutover-runbook.md");
  assert.match(runbook, /cityscroll\.org/);
  assert.match(runbook, /Rollback|rollback/);
  assert.match(runbook, /TTL/);
  assert.match(runbook, /GitHub Pages/);
});

test("parallel host smoke and route parity run after Cloudflare Pages deploy", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /live_url_smoke\.mjs/);
  assert.match(workflow, /--base-url https:\/\/cityscroll\.pages\.dev/);
  assert.match(workflow, /pages_route_parity\.mjs/);
  assert.match(workflow, /needs:\s*deploy/);
  const smokeBlock = workflow.slice(workflow.indexOf("live_url_smoke"));
  assert.doesNotMatch(
    smokeBlock.slice(0, 500),
    /continue-on-error:\s*true/,
    "smoke must not soft-pass failures",
  );
});

test("deploy uses the shared verified build action", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /uses: \.\/\.github\/actions\/build-site/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
});

test("same-repository pull requests may deploy the parallel host for validation", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
});
