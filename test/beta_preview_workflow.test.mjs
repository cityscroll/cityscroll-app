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

  const build = action.indexOf("actions/jekyll-build-pages@v1");
  const stamp = action.indexOf("tools/stamp_i18n_assets.py --site-root _site --stamp");
  const verify = action.indexOf("test/standards/i18n_refs.py --root _site --built");
  const boundary = action.indexOf("tools/verify_public_artifact.py --site-root _site");
  assert.ok(build >= 0 && build < stamp && stamp < verify && verify < boundary);
});

test("review artifacts carry noindex metadata and reject repository-only paths", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-beta-preview-"));
  try {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Preview</title>");
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
        canonical_site: "https://crol-list.org/",
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
