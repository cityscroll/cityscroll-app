import assert from "node:assert/strict";
import {
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

test("beta previews are opt-in, draft-only, and same-repository", () => {
  const workflow = read(".github/workflows/deploy-beta-preview.yml");

  assert.match(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /github\.event\.pull_request\.draft == true/);
  assert.match(workflow, /preview:beta/);
});

test("beta previews publish a numbered alias and expose immutable provenance", () => {
  const workflow = read(".github/workflows/deploy-beta-preview.yml");

  const ensure = workflow.indexOf("tools/ensure_beta_pages.mjs project");
  const deploy = workflow.indexOf("pages deploy _site");
  assert.ok(ensure >= 0 && ensure < deploy, "the Pages project must exist before first preview");
  assert.match(workflow, /--branch=pr-\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /--commit-hash=\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /pages-deployment-alias-url/);
  assert.match(workflow, /deployment-url/);
  assert.match(workflow, /X-Robots-Tag/);
});

test("stable and preview lanes share one build, i18n stamp, and artifact gate", () => {
  const stable = read(".github/workflows/deploy-pages.yml");
  const preview = read(".github/workflows/deploy-beta-preview.yml");
  const action = read(".github/actions/build-site/action.yml");

  assert.match(stable, /uses: \.\/\.github\/actions\/build-site/);
  assert.match(preview, /uses: \.\/\.github\/actions\/build-site/);

  const build = action.indexOf("tools/build_cloudflare_pages.mjs");
  const stamp = read("tools/build_cloudflare_pages.mjs").indexOf("stamp_i18n_assets.py");
  const verify = read("tools/build_cloudflare_pages.mjs").indexOf("i18n_refs.py");
  const boundary = read("tools/build_cloudflare_pages.mjs").indexOf("verify_public_artifact.py");
  assert.ok(
    build >= 0
      && stamp >= 0
      && verify >= 0
      && boundary >= 0,
  );
  assert.doesNotMatch(action, /actions\/jekyll-build-pages@v1/);

  const config = read("site/_config.yml");
  for (const path of ["AGENTS.md", "CLAUDE.md", "test", "tools", "worker"]) {
    assert.match(config, new RegExp(`- ${path.replace(".", "\\.")}$`, "m"), path);
  }
});

test("review artifacts carry noindex metadata and reject repository-only paths", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-beta-preview-"));
  try {
    writeFileSync(
      join(root, "index.html"),
      "<!doctype html><title>Preview</title><body>Preview</body>",
    );
    let result = spawnSync(
      "python3",
      [
        "tools/prepare_review_artifact.py",
        "--site-root",
        root,
        "--channel",
        "preview",
        "--commit",
        "a".repeat(40),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "_headers"), "utf8"), /X-Robots-Tag: noindex/);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "release-channel.json"), "utf8")),
      {
        canonical_site: "https://cityscroll.org/",
        channel: "preview",
        commit: "a".repeat(40),
      },
    );

    result = spawnSync(
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
