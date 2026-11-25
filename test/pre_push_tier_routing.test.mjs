/**
 * Regression tests for tools/git-hooks/pre-push fast-tier vs --full routing.
 *
 * Changes confined to site/data/** data payloads should stay on the fast tier,
 * while rendered site/** changes (HTML, JS, CSS, i18n, assets) must still run --full.
 *
 * verify: node --test test/pre_push_tier_routing.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRE_PUSH = path.join(ROOT, "tools/git-hooks/pre-push");
const SCRUB = path.join(ROOT, "tools/git-hooks/scrub-hook-exported-git-env.sh");

function runHookWithChangedFiles(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-tier-"));
  try {
    const git = (...args) => {
      const res = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
      assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
      return res.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.email", "test.invalid");
    git("config", "user.name", "Test");

    fs.mkdirSync(path.join(tmp, "tools/git-hooks"), { recursive: true });
    fs.copyFileSync(PRE_PUSH, path.join(tmp, "tools/git-hooks/pre-push"));
    fs.chmodSync(path.join(tmp, "tools/git-hooks/pre-push"), 0o755);
    fs.copyFileSync(SCRUB, path.join(tmp, "tools/git-hooks/scrub-hook-exported-git-env.sh"));

    const argsFile = path.join(tmp, "captured-args.txt");
    fs.writeFileSync(
      path.join(tmp, "tools/with_local_a11y_python.sh"),
      '#!/usr/bin/env bash\nexec "$@"\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(tmp, "tools/preflight-required-checks.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`,
      { mode: 0o755 }
    );

    fs.writeFileSync(path.join(tmp, "README.md"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");

    for (const rel of files) {
      const target = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "updated\n");
    }
    git("add", ".");
    git("commit", "-q", "-m", "change");
    const headSha = git("rev-parse", "HEAD");

    const res = spawnSync(
      path.join(tmp, "tools/git-hooks/pre-push"),
      [],
      {
        cwd: tmp,
        encoding: "utf8",
        input: `refs/heads/feature ${headSha} refs/heads/feature ${baseSha}\n`
      }
    );
    assert.equal(res.status, 0, `pre-push exited ${res.status}: ${res.stdout}${res.stderr}`);
    const args = fs.readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean);
    return { args, stdout: res.stdout };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("site/data/** JSON changes stay on fast tier without --full", () => {
  const { args, stdout } = runHookWithChangedFiles([
    "site/data/open_notice_document_listings.json",
    ".github/workflows/refresh.yml"
  ]);
  assert.ok(args.includes("--with-reading-level"), `expected --with-reading-level in ${args}`);
  assert.ok(!args.includes("--full"), `unexpected --full for site/data-only diff: ${args}`);
  assert.match(stdout, /fast tier/);
});

test("rendered site/** UI changes still trigger --full", () => {
  const { args, stdout } = runHookWithChangedFiles(["site/app.mjs"]);
  assert.ok(args.includes("--with-reading-level"), `expected --with-reading-level in ${args}`);
  assert.ok(args.includes("--full"), `expected --full for site/app.mjs diff: ${args}`);
  assert.match(stdout, /running preflight with --full/);
});

test("mixed site/data/** and rendered site/** changes still trigger --full", () => {
  const { args } = runHookWithChangedFiles([
    "site/data/open_notice_document_listings.json",
    "site/styles.css"
  ]);
  assert.ok(args.includes("--full"), `expected --full when rendered site file also changed: ${args}`);
});
