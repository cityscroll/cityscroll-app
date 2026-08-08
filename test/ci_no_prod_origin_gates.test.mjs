// Recurrence guard: PR / merge-group required-check jobs must not sample live
// production. Live production demo-link and hosting checks belong to scheduled
// monitors (cutover-regression), not PR-blocking gates. Keeps the hermetic-CI
// decoupling durable so a production CROL_BASE cannot reappear in gate jobs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Production site / API origins that must not appear as gate fetch targets in PR jobs. */
const PROD_ORIGINS = [
  "https://cityscroll.org",
  "https://www.cityscroll.org",
  "https://api.cityscroll.org",
  "https://cityscroll.pages.dev",
];

/**
 * Extract a top-level job body from a GitHub Actions workflow YAML.
 * Jobs are indented with two spaces; steps and nested keys use more.
 */
function extractJob(workflow, jobId) {
  const re = new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|$)`);
  const m = workflow.match(re);
  return m ? m[1] : null;
}

/** Jobs that participate in PR / merge-group required checks (or feed them). */
const PR_GATE_JOBS = ["unit", "a11y-pr", "reading-level", "performance", "functional"];

test("ci.yml PR-gate jobs never set CROL_BASE (or equivalent) to a production origin", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const jobId of PR_GATE_JOBS) {
    const body = extractJob(ci, jobId);
    assert.ok(body, `expected job ${jobId} in ci.yml`);
    for (const origin of PROD_ORIGINS) {
      const escaped = origin.replace(/\./g, "\\.");
      // CROL_BASE: https://cityscroll.org/  (or bare host)
      const crolBase = new RegExp(String.raw`CROL_BASE:\s*${escaped}`);
      assert.doesNotMatch(
        body,
        crolBase,
        `${jobId} must not set CROL_BASE to ${origin} (use local server or PR preview)`,
      );
      // Bare env assignment forms sometimes omit the trailing slash.
      const bareHost = new RegExp(
        String.raw`(?:CROL_BASE|BASE_URL|SITE_URL):\s*['"]?${escaped}`,
      );
      assert.doesNotMatch(
        body,
        bareHost,
        `${jobId} must not point BASE_URL-class env at ${origin}`,
      );
    }
    // Hard-fail the old step title if someone reintroduces it.
    assert.doesNotMatch(
      body,
      /Public demo-link contract on cityscroll\.org/,
      `${jobId} must not reintroduce a production demo-link gate step`,
    );
  }
});

test("a11y-pr demo-link contract uses the local site server and remains required", () => {
  const ci = read(".github/workflows/ci.yml");
  const a11y = extractJob(ci, "a11y-pr");
  assert.ok(a11y, "expected a11y-pr job");
  assert.match(a11y, /CROL_BASE:\s*http:\/\/127\.0\.0\.1:8000\//);
  assert.match(a11y, /python3 test\/functional\/20_demo_links\.py/);
  // Exactly one demo-links.py invocation in a11y-pr (local only).
  const runs = a11y.match(/python3 test\/functional\/20_demo_links\.py/g) || [];
  assert.equal(runs.length, 1, "a11y-pr should run demo-links once against local origin");
  const demoStep = a11y.slice(a11y.indexOf("- name: Public demo-link regression contract"));
  assert.doesNotMatch(
    demoStep,
    /continue-on-error:/,
    "the local demo-link contract must remain required on every CI event",
  );
});

test("scheduled cutover-regression owns live production demo-link monitoring", () => {
  const workflow = read(".github/workflows/cutover-regression.yml");
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|merge_group:|push:/);
  assert.match(workflow, /CROL_BASE:\s*https:\/\/cityscroll\.org\//);
  assert.match(workflow, /Full public demo-link contract on production/);
  assert.match(workflow, /python3 test\/functional\/20_demo_links\.py/);
  // Full suite has no ID filter on the primary step (targeted attachment step may filter).
  const fullStep = workflow.slice(
    workflow.indexOf("Full public demo-link contract on production"),
  );
  const fullEnv = fullStep.slice(0, fullStep.indexOf("run:"));
  assert.doesNotMatch(fullEnv, /CROL_DEMO_LINK_IDS/);
});

test("Cloudflare Pages production deploy is push-triggered and not a PR gate", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /^\s+push:\n\s+branches:\s*\[main\]/m);
  assert.doesNotMatch(workflow, /^\s+(?:pull_request|schedule):/m);
  // Both automatic and manual releases deploy the production branch.
  assert.match(workflow, /branch="main"/);
  assert.match(workflow, /--branch=\$\{\{\s*steps\.branch\.outputs\.branch\s*\}\}/);
  assert.match(workflow, /is_preview/);
  assert.match(workflow, /deployment_url|deployment-url/);
  // The fallback still smokes the resolved deploy origin and checks route parity.
  assert.match(
    workflow,
    /Route inventory parity[\s\S]*?if:\s*needs\.deploy\.outputs\.is_preview\s*!=\s*'true'/,
  );
  // Smoke + demo-link consume the resolved deploy origin, not a hardcoded prod host alone.
  const smoke = workflow.slice(workflow.indexOf("smoke:"));
  assert.match(smoke, /steps\.origin\.outputs\.base_url|steps\.origin\.outputs\.base_host/);
  assert.match(smoke, /CROL_BASE:\s*\$\{\{\s*steps\.origin\.outputs\.base_url\s*\}\}/);
  // Hardcoded production demo-link base must not appear in the smoke job.
  assert.doesNotMatch(smoke, /CROL_BASE:\s*https:\/\/cityscroll\.org\//);
});
