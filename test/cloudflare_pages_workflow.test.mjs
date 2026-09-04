import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Cloudflare Pages is the sole public static deployment path", () => {
  const cf = read(".github/workflows/deploy-cloudflare-pages.yml");

  assert.equal(existsSync(new URL("../.github/workflows/deploy-pages.yml", import.meta.url)), false);
  assert.match(cf, /pages deploy _site/);
  assert.match(cf, /--project-name=cityscroll/);
  // Production branch is main; pull requests use a numbered preview branch.
  assert.match(cf, /branch=main|branch=\$\{\{\s*steps\.branch\.outputs\.branch\s*\}\}/);
  assert.doesNotMatch(cf, /deploy-pages@v4|GitHub Pages remains|GitHub Pages.*fallback/i);
  assert.match(cf, /Cloudflare Pages is the production static origin/);
});

test("Cloudflare Pages workflow provisions the project before first deploy", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  const ensure = workflow.indexOf("tools/ensure_stable_pages.mjs project");
  const deploy = workflow.indexOf("pages deploy _site");
  assert.ok(ensure >= 0 && ensure < deploy, "Pages project must exist before deploy");
});

test("Cloudflare Pages workflow preserves custom-domain configuration", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.doesNotMatch(workflow, /ensure_stable_pages\.mjs domain/);
  assert.doesNotMatch(workflow, /--domain=/);
  assert.doesNotMatch(workflow, /pages domain add/i);
  // Production path may reference cityscroll.org for parity; custom-domain
  // attachment remains an explicit hosting configuration action.
  assert.doesNotMatch(workflow, /pages domains? (add|create)/i);
  assert.doesNotMatch(workflow, /Custom domains/i);
});

test("Pages hostname smoke and public route parity run after deploy", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /live_url_smoke\.mjs/);
  assert.match(workflow, /pages_route_parity\.mjs/);
  assert.match(workflow, /--timeout-ms 720000/);
  assert.match(workflow, /needs:\s*deploy/);
  // Production alias smoke is via resolved origin; base-url is not a fixed host string.
  assert.match(workflow, /--base-url \$\{\{\s*steps\.origin\.outputs\.base_host\s*\}\}/);
  const smokeBlock = workflow.slice(workflow.indexOf("live_url_smoke"));
  assert.doesNotMatch(
    smokeBlock.slice(0, 500),
    /continue-on-error:\s*true/,
    "smoke must not soft-pass failures",
  );
  // Route parity against live production is production-only (not PR previews).
  assert.match(
    workflow,
    /Route inventory parity[\s\S]*?if:\s*needs\.deploy\.outputs\.is_preview\s*!=\s*'true'/,
  );
});

test("post-deploy smoke renders real civil-service exam rows on the deploy target", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  const smoke = workflow.slice(workflow.indexOf("smoke:"));
  assert.match(smoke, /uses: \.\/\.github\/actions\/setup-playwright/);
  assert.match(smoke, /CROL_BASE:\s*\$\{\{\s*steps\.origin\.outputs\.base_url\s*\}\}/);
  assert.match(smoke, /CROL_DEMO_LINK_IDS: exam-guide/);
  assert.match(smoke, /python3 test\/functional\/20_demo_links\.py/);
  assert.doesNotMatch(smoke, /continue-on-error:\s*true/);
  // Must not hardcode production or the stable pages.dev alias as CROL_BASE.
  assert.doesNotMatch(smoke, /CROL_BASE:\s*https:\/\/cityscroll\.org\//);
  assert.doesNotMatch(smoke, /CROL_BASE:\s*https:\/\/cityscroll\.pages\.dev\//);
});

test("deploy uses the shared verified build action", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  const action = read(".github/actions/build-site/action.yml");
  assert.match(workflow, /uses: \.\/\.github\/actions\/build-site/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(action, /tools\/build_cloudflare_pages\.mjs/);
  assert.doesNotMatch(action, /review-channel/);
  const stamp = read("tools/build_cloudflare_pages.mjs").indexOf("stamp_i18n_assets.py");
  const verify = read("tools/build_cloudflare_pages.mjs").indexOf("i18n_refs.py");
  const boundary = read("tools/build_cloudflare_pages.mjs").indexOf("verify_public_artifact.py");
  assert.ok(stamp >= 0 && verify >= 0 && boundary >= 0);
});

test("public artifact gate rejects repository-only paths", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-public-artifact-"));
  try {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Public</title><body>Public</body>");
    let result = spawnSync(
      "python3",
      ["tools/verify_public_artifact.py", "--site-root", root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    mkdirSync(join(root, "internal"));
    writeFileSync(join(root, "internal", "notes.txt"), "not public");
    result = spawnSync(
      "python3",
      ["tools/verify_public_artifact.py", "--site-root", root],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repository-only path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pages deploy retains and binds release-surface evidence", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  const action = read(".github/actions/build-site/action.yml");
  assert.match(action, /check_release_surface_reconciliation\.mjs/);
  assert.match(action, /source_health_observations\.json/);
  assert.match(workflow, /update_release_surface_receipt\.mjs/);
  assert.match(workflow, /check_deployment_health\.mjs --write/);
  assert.match(workflow, /--boundary cloudflare-pages/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /cloudflare-pages-release-evidence-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /if-no-files-found: warn/);
});

test("production Pages deploys automatically for every main push", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /^\s+push:\n\s+branches:\s*\[main\]/m);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.match(workflow, /branch="main"/);
  assert.match(workflow, /GitHub Actions is the canonical production path/);
  assert.match(
    workflow,
    /refresh-decision-outcomes:\s*\$\{\{\s*github\.event_name\s*==\s*'push'\s*\|\|\s*inputs\.refresh_decision_outcomes\s*\}\}/,
  );
});

test("production Pages deploys on a daily schedule that refreshes Contracts before the NYC workday", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /^\s+schedule:/m);
  assert.match(workflow, /- cron:\s*"15 10 \* \* \*"/);
  assert.match(
    workflow,
    /refresh-resident-snapshots:\s*\$\{\{\s*github\.event_name\s*==\s*'push'\s*\|\|\s*github\.event_name\s*==\s*'schedule'\s*\|\|\s*inputs\.refresh_resident_snapshots\s*\}\}/,
  );
  const action = read(".github/actions/build-site/action.yml");
  assert.match(action, /refresh-resident-snapshots:/);
  assert.match(action, /REFRESH_RESIDENT_SNAPSHOTS/);
});

test("Contracts resident-snapshot refresh is a separate control from the existing decision-outcomes refresh", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  assert.match(workflow, /refresh_decision_outcomes:/);
  assert.match(workflow, /refresh_resident_snapshots:/);
  // The pre-existing decision-outcomes trigger keeps its exact original meaning.
  assert.match(
    workflow,
    /refresh-decision-outcomes:\s*\$\{\{\s*github\.event_name\s*==\s*'push'\s*\|\|\s*inputs\.refresh_decision_outcomes\s*\}\}/,
  );
});

test("post-deploy smoke checks the deployed Contracts snapshot freshness", () => {
  const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");
  const smoke = workflow.slice(workflow.indexOf("smoke:"));
  assert.match(smoke, /CROL_CONTRACTS_FRESHNESS_STRICT: "1"/);
  assert.match(smoke, /python3 test\/functional\/48_contracts_freshness_live\.py/);
});
