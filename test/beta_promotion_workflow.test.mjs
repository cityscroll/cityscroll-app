import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  BETA_DOMAIN,
  PROJECT_NAME,
  ensureDomain,
  ensureProject,
  resolveAccountId,
} from "../tools/ensure_beta_pages.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("beta promotion is manual and pins one full commit SHA", () => {
  const workflow = read(".github/workflows/promote-beta.yml");

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/m);
  assert.match(workflow, /commit_sha:/);
  assert.match(workflow, /confirmation:/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /environment:\s*\n\s+name: beta/);
  assert.match(workflow, /--branch=beta/);
  assert.match(workflow, /--commit-hash=\$\{\{ inputs\.commit_sha \}\}/);
});

test("promotion uses the dispatched workflow tooling while building the selected commit", () => {
  const workflow = read(".github/workflows/promote-beta.yml");

  assert.match(workflow, /path: release-tools/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /path: source/);
  assert.match(workflow, /uses: \.\/release-tools\/\.github\/actions\/build-site/);
  assert.match(workflow, /source-dir: source/);
  assert.match(workflow, /commit-sha: \$\{\{ inputs\.commit_sha \}\}/);
});

test("the first promotion provisions the pointer and every promotion verifies it", () => {
  const workflow = read(".github/workflows/promote-beta.yml");

  const project = workflow.indexOf("ensure_beta_pages.mjs project");
  const deploy = workflow.indexOf("pages deploy _site");
  const domain = workflow.indexOf("ensure_beta_pages.mjs domain");
  const verify = workflow.indexOf("release-channel.json");
  assert.ok(project >= 0 && project < deploy && deploy < domain && domain < verify);
  assert.match(workflow, /https:\/\/beta\.cityscroll\.org/);
  assert.match(workflow, /EXPECTED_COMMIT/);
});

test("beta artifacts show their exact commit and a stable-site escape", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-beta-promotion-"));
  try {
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><link rel="canonical" href="https://cityscroll.org/"><body><main>Site</main></body>',
    );
    const result = spawnSync(
      "python3",
      [
        "tools/prepare_review_artifact.py",
        "--site-root",
        root,
        "--channel",
        "beta",
        "--commit",
        "b".repeat(40),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const page = readFileSync(join(root, "index.html"), "utf8");
    assert.match(page, /Experimental beta/);
    assert.match(page, /bbbbbbbbbbbb/);
    assert.match(page, /https:\/\/cityscroll\.org\//);
    assert.match(page, /rel="canonical" href="https:\/\/cityscroll\.org\/"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the documented rollback re-points beta without a beta branch", () => {
  const docs = read("docs/beta-channel.md");

  assert.match(docs, /rerun.*prior.*SHA/is);
  assert.match(docs, /promotion pointer/i);
  assert.match(docs, /no long-lived `beta` branch/i);
  assert.match(docs, /one owner-triggered workflow run/i);
});

test("Pages provisioning is idempotent and fixes the production branch at beta", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      return {
        ok: false,
        status: 404,
        json: async () => ({ success: false, errors: [{ message: "not found" }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { name: PROJECT_NAME, production_branch: "beta" },
      }),
    };
  };

  const result = await ensureProject({
    accountId: "a".repeat(32),
    token: "test-token",
    fetchImpl,
  });
  assert.equal(result.created, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    name: PROJECT_NAME,
    production_branch: "beta",
  });
});

test("a single-account token needs no committed account identifier", async () => {
  const id = "a".repeat(32);
  const resolved = await resolveAccountId({
    token: "test-token",
    fetchImpl: async (url) => {
      assert.match(url, /\/accounts\?per_page=50$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: [{ id }] }),
      };
    },
  });
  assert.equal(resolved, id);

  for (const path of [
    ".github/workflows/deploy-beta-preview.yml",
    ".github/workflows/promote-beta.yml",
  ]) {
    assert.doesNotMatch(read(path), /\b[0-9a-f]{32}\b/);
  }
});

test("Pages domain provisioning does not recreate an attached domain", async () => {
  let calls = 0;
  const result = await ensureDomain({
    accountId: "a".repeat(32),
    token: "test-token",
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ name: BETA_DOMAIN, status: "active" }],
        }),
      };
    },
  });
  assert.equal(result.created, false);
  assert.equal(calls, 1);
});
