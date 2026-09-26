import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertTrackedWorkingTreeClean } from "./helpers/tracked_working_tree.mjs";

const REAL_ROOT = fileURLToPath(new URL("../", import.meta.url));
const GUARD = fileURLToPath(new URL("../tools/check_stale_repo_name.mjs", import.meta.url));
const REAL_ALLOWLIST = join(REAL_ROOT, ".github", "legacy-name-allowlist.txt");
const REAL_PROBE = join(REAL_ROOT, ".legacy-name-guard-probe.txt");
const PROBE_NAME = ".legacy-name-guard-probe.txt";
const ALLOWLIST_REL = ".github/legacy-name-allowlist.txt";
const legacyName = ["crol", "-", "list"].join("");
const reservedMarker = ["card-seal", "5rk8-qj2m-xv91"].join(":");

const DEFAULT_ALLOWLIST_HEADER = [
  "# Each entry is path + base64 of the exact line + a reason comment.",
  "# Matching is content-addressed inside that file: the pinned line may move",
  "# without an allowlist edit. Line numbers are not part of the key and are not",
  "# stored; they never decide the verdict.",
  "# If the same line appears more than once, the entry must declare count=N",
  "# (N >= 2) so an added copy of a pinned line still fails.",
  "#",
  "# Fields (tab-separated):",
  "#   <path> <digest> # reason",
  "#   <path> <digest> count=N # reason",
  "#   <path> * # whole-file exemption",
  "# A `future:` path prefix means the line is absent from the current tree",
  "# (stale-entry bookkeeping only); it does not skip the growth rule.",
].join("\n");

function scratchParent() {
  const base = process.env.FM_TASK_SCRATCH ? join(process.env.FM_TASK_SCRATCH, "tmp") : tmpdir();
  mkdirSync(base, { recursive: true });
  return base;
}

function isolatedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function runRealGuard(env = {}) {
  return execFileSync(process.execPath, [GUARD], {
    cwd: REAL_ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: isolatedGitEnv(env),
  });
}

function runFixtureGuard(dir, env = {}, args = []) {
  return execFileSync(process.execPath, [GUARD, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
    env: isolatedGitEnv({
      LEGACY_NAME_GUARD_ROOT: dir,
      ...env,
    }),
  });
}

function allowlistPath(dir) {
  return join(dir, ALLOWLIST_REL);
}

function writeAllowlist(dir, body) {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(allowlistPath(dir), body.endsWith("\n") ? body : `${body}\n`);
}

function withAllowlist(dir, mutate, fn) {
  const path = allowlistPath(dir);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, mutate(original));
  try {
    return fn();
  } finally {
    writeFileSync(path, original);
  }
}

function withFixtureRepo(seed, fn) {
  const dir = mkdtempSync(join(scratchParent(), "stale-name-guard-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "stale-name-guard@example.test"]);
    git(dir, ["config", "user.name", "Stale Name Guard Fixture"]);
    writeAllowlist(dir, `${DEFAULT_ALLOWLIST_HEADER}\n`);
    writeFileSync(join(dir, "README.md"), "CityScroll fixture readme\n");
    if (seed) seed(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "fixture base"]);
    const baseSha = git(dir, ["rev-parse", "HEAD"]);
    return fn({ dir, baseSha });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mainMergeBaseSha() {
  return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: REAL_ROOT,
    encoding: "utf8",
    env: isolatedGitEnv(),
  }).trim();
}

after(() => {
  // Scope to the allowlist path so an in-progress edit of this suite itself does
  // not fail the hermeticity check. The suite must never mutate that tracked file.
  assertTrackedWorkingTreeClean(REAL_ROOT, { paths: [ALLOWLIST_REL] });
  assert.equal(
    existsSync(REAL_PROBE),
    false,
    "repo-root legacy-name probe must not remain after the suite",
  );
  const allowlist = readFileSync(REAL_ALLOWLIST, "utf8");
  assert.ok(allowlist.trim().length > 0, "tracked allowlist must not be emptied by the suite");
});

test("the checked-in compatibility inventory is accepted", () => {
  assert.match(runRealGuard(), /guard passed/i);
});

test("the classification manifest preserves canonical register identifiers", () => {
  const output = runRealGuard({ LEGACY_ALLOWLIST_BASE_SHA: mainMergeBaseSha() });
  assert.match(output, /guard passed/i);
  assert.doesNotMatch(output, /covers content that does not exist/);
});

test("a novel unallowlisted reference fails the guard", () => {
  withFixtureRepo(null, ({ dir }) => {
    writeFileSync(join(dir, PROBE_NAME), `new ${legacyName} reference\n`);
    assert.throws(() => runFixtureGuard(dir), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
  });
});

test("a novel legacy-name reference fails the guard", () => {
  withFixtureRepo(null, ({ dir }) => {
    writeFileSync(join(dir, PROBE_NAME), `new ${legacyName} reference\n`);
    assert.throws(() => runFixtureGuard(dir), new RegExp(`legacy-name-guard-probe.*${legacyName}`, "i"));
  });
});

test("the reserved content marker always fails the guard", () => {
  withFixtureRepo(null, ({ dir }) => {
    writeFileSync(join(dir, PROBE_NAME), `reserved ${reservedMarker}\n`);
    assert.throws(() => runFixtureGuard(dir), new RegExp(`legacy-name-guard-probe.*${reservedMarker}`));
  });
});

test("allowlist rewrite refuses a novel occurrence", () => {
  withFixtureRepo(null, ({ dir }) => {
    writeFileSync(join(dir, PROBE_NAME), `new ${legacyName} reference\n`);
    assert.throws(
      () => runFixtureGuard(dir, {}, ["--write"]),
      new RegExp(`legacy-name-guard-probe.*${legacyName}`),
    );
  });
});

test("a same-PR allowlist entry covering a same-PR new line fails the guard", () => {
  withFixtureRepo(null, ({ dir, baseSha }) => {
    writeFileSync(join(dir, PROBE_NAME), `new ${legacyName} reference\n`);
    const digest = Buffer.from(`new ${legacyName} reference`, "utf8").toString("base64");
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t${digest}\t# test: same-PR cover attempt.\n`,
      () => {
        assert.throws(
          () => runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: baseSha }),
          /covers content that does not exist at the merge-base of main/,
        );
      },
    );
  });
});

test("a 'future:' entry covering a same-PR new line still fails the guard", () => {
  withFixtureRepo(null, ({ dir, baseSha }) => {
    writeFileSync(join(dir, PROBE_NAME), `new ${legacyName} reference\n`);
    const digest = Buffer.from(`new ${legacyName} reference`, "utf8").toString("base64");
    withAllowlist(
      dir,
      (original) => `${original}future:${PROBE_NAME}\t${digest}\t# test: future-prefixed same-PR cover attempt.\n`,
      () => {
        assert.throws(
          () => runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: baseSha }),
          /covers content that does not exist at the merge-base of main/,
        );
      },
    );
  });
});

test("an allowlist entry covering a pre-existing line passes and prints a growth summary", () => {
  withFixtureRepo(null, ({ dir, baseSha }) => {
    const existingLine = readFileSync(join(dir, "README.md"), "utf8").split(/\r?\n/)[0];
    const digest = Buffer.from(existingLine, "utf8").toString("base64");
    withAllowlist(
      dir,
      (original) => `${original}future:README.md\t${digest}\t# test: pre-existing line, legitimate legacy exception.\n`,
      () => {
        const output = runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: baseSha });
        assert.match(output, /guard passed/i);
        assert.match(output, /ALLOWLIST GROWTH: 1 new entry added, covering 1 file/);
        assert.match(output, /\+ README\.md  /);
      },
    );
  });
});

test("a same-PR wildcard entry covering a modified pre-existing file fails the guard", () => {
  withFixtureRepo(null, ({ dir, baseSha }) => {
    const targetPath = join(dir, "README.md");
    const original = readFileSync(targetPath, "utf8");
    writeFileSync(targetPath, `${original}new ${legacyName} reference\n`);
    try {
      withAllowlist(
        dir,
        (allowlist) => `${allowlist}README.md\t*\t# test: same-PR wildcard cover attempt.\n`,
        () => {
          assert.throws(
            () => runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: baseSha }),
            /covers content that does not exist at the merge-base of main/,
          );
        },
      );
    } finally {
      writeFileSync(targetPath, original);
    }
  });
});

test("a wildcard entry covering an untouched pre-existing file passes the growth guard", () => {
  withFixtureRepo(null, ({ dir, baseSha }) => {
    withAllowlist(
      dir,
      (original) => `${original}future:README.md\t*\t# test: untouched pre-existing file, whole-file exemption.\n`,
      () => {
        const output = runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: baseSha });
        assert.match(output, /guard passed/i);
        assert.match(output, /ALLOWLIST GROWTH: 1 new entry added, covering 1 file/);
      },
    );
  });
});

test("a PR that does not touch the allowlist is unaffected by the growth guard", () => {
  withFixtureRepo(null, ({ dir, baseSha }) => {
    const output = runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: baseSha });
    assert.match(output, /guard passed/i);
    assert.doesNotMatch(output, /ALLOWLIST GROWTH/);
  });
});

test("growth guard fails closed when the merge-base cannot be resolved", () => {
  withFixtureRepo(null, ({ dir }) => {
    const existingLine = readFileSync(join(dir, "README.md"), "utf8").split(/\r?\n/)[0];
    const digest = Buffer.from(existingLine, "utf8").toString("base64");
    withAllowlist(
      dir,
      (original) => `${original}future:README.md\t${digest}\t# test: unresolved base.\n`,
      () => {
        assert.throws(
          () => runFixtureGuard(dir, { LEGACY_ALLOWLIST_BASE_SHA: "0000000000000000000000000000000000000000" }),
          /unable to resolve a merge-base/,
        );
      },
    );
  });
});

test("an old-format pin matches by content even when its recorded line number is stale", () => {
  withFixtureRepo(null, ({ dir }) => {
    const line = `kept ${legacyName} reference`;
    const digest = Buffer.from(line, "utf8").toString("base64");
    writeFileSync(join(dir, PROBE_NAME), `unrelated insertion\n${line}\n`);
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t1\t${digest}\t# test: stale line number in old format.\n`,
      () => {
        assert.match(runFixtureGuard(dir), /guard passed/i);
      },
    );
  });
});

test("an unrelated insertion above a pinned line does not require an allowlist edit", () => {
  withFixtureRepo(null, ({ dir }) => {
    const line = `kept ${legacyName} reference`;
    const digest = Buffer.from(line, "utf8").toString("base64");
    writeFileSync(join(dir, PROBE_NAME), `${line}\n`);
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t${digest}\t# test: content-addressed pin.\n`,
      () => {
        writeFileSync(join(dir, PROBE_NAME), `unrelated insertion\n${line}\n`);
        assert.match(runFixtureGuard(dir), /guard passed/i);
      },
    );
  });
});

test("an added unpinned copy of a pinned line fails the guard", () => {
  withFixtureRepo(null, ({ dir }) => {
    const line = `kept ${legacyName} reference`;
    const digest = Buffer.from(line, "utf8").toString("base64");
    writeFileSync(join(dir, PROBE_NAME), `${line}\n${line}\n`);
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t${digest}\t# test: single-occurrence pin.\n`,
      () => {
        assert.throws(() => runFixtureGuard(dir), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
      },
    );
  });
});

test("a declared count covers repeated identical lines and rejects an extra copy", () => {
  withFixtureRepo(null, ({ dir }) => {
    const line = `kept ${legacyName} reference`;
    const digest = Buffer.from(line, "utf8").toString("base64");
    writeFileSync(join(dir, PROBE_NAME), `${line}\n${line}\n`);
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t${digest}\tcount=2\t# test: two-occurrence pin.\n`,
      () => {
        assert.match(runFixtureGuard(dir), /guard passed/i);
        writeFileSync(join(dir, PROBE_NAME), `${line}\n${line}\n${line}\n`);
        assert.throws(() => runFixtureGuard(dir), new RegExp(`legacy-name-guard-probe.*${legacyName}`));
      },
    );
  });
});

test("removing a pinned occurrence is reported as stale", () => {
  withFixtureRepo(null, ({ dir }) => {
    const line = `kept ${legacyName} reference`;
    const digest = Buffer.from(line, "utf8").toString("base64");
    const probePath = join(dir, PROBE_NAME);
    writeFileSync(probePath, `${line}\n`);
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t${digest}\t# test: pin that will go missing.\n`,
      () => {
        unlinkSync(probePath);
        assert.throws(() => runFixtureGuard(dir), /stale entries/);
      },
    );
  });
});

test("duplicate content pins for one file must declare a single count", () => {
  withFixtureRepo(null, ({ dir }) => {
    const line = `kept ${legacyName} reference`;
    const digest = Buffer.from(line, "utf8").toString("base64");
    writeFileSync(join(dir, PROBE_NAME), `${line}\n${line}\n`);
    withAllowlist(
      dir,
      (original) => `${original}${PROBE_NAME}\t${digest}\t# test: first pin.\n${PROBE_NAME}\t${digest}\t# test: duplicate pin.\n`,
      () => {
        assert.throws(() => runFixtureGuard(dir), /duplicate content pin/);
      },
    );
  });
});
