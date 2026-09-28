import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePrimaryDocumentWritePlan } from "../tools/build_primary_documents.mjs";
import {
  assertTrackedWorkingTreeUnchanged,
  trackedWorkingTreePorcelain,
} from "./helpers/tracked_working_tree.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARED_MEETING = join(ROOT, "site/data/shared_meeting_read_model.json");
const PEOPLE_ORG = join(ROOT, "site/data/people_organizations_read_model.json");
const BROWSE_SHELL = join(ROOT, "site/browse/index.html");
const BUILDER = join(ROOT, "tools/build_primary_documents.mjs");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isolatedGitEnv() {
  return {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
  };
}

test("write plan preserves tracked shared meeting and people read models", () => {
  const plan = resolvePrimaryDocumentWritePlan(
    [
      [SHARED_MEETING, '{"schema":"probe"}\n'],
      [PEOPLE_ORG, '{"schema":"probe"}\n'],
      [BROWSE_SHELL, "<!doctype html>\n"],
    ],
    { preserveTracked: true },
  );
  assert.equal(plan[0].tracked, true);
  assert.equal(plan[0].preserve, true);
  assert.equal(plan[1].tracked, true);
  assert.equal(plan[1].preserve, true);
  assert.equal(plan[2].tracked, false);
  assert.equal(plan[2].preserve, false);
  assert.equal(plan[2].destinationPath, BROWSE_SHELL);
});

test("write plan remaps site outputs into an ignored output root", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "cityscroll-primary-out-"));
  try {
    const plan = resolvePrimaryDocumentWritePlan(
      [[SHARED_MEETING, '{"schema":"probe"}\n']],
      { preserveTracked: true, outputRoot },
    );
    assert.equal(plan[0].preserve, false);
    assert.equal(
      plan[0].destinationPath,
      join(outputRoot, "data/shared_meeting_read_model.json"),
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("build_primary_documents --preserve-tracked leaves the committed shared meeting model untouched", () => {
  const beforeHash = sha256(SHARED_MEETING);
  const beforePorcelain = trackedWorkingTreePorcelain(ROOT, {
    paths: ["site/data/shared_meeting_read_model.json"],
  });
  const result = spawnSync(process.execPath, [BUILDER, "--preserve-tracked"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...isolatedGitEnv(),
      CROL_BUILD_DAY: process.env.CROL_BUILD_DAY || "2026-09-09",
    },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /preserved tracked/);
  assert.match(result.stdout, /shared_meeting_read_model\.json/);
  assert.equal(sha256(SHARED_MEETING), beforeHash);
  assertTrackedWorkingTreeUnchanged(beforePorcelain, ROOT, {
    paths: ["site/data/shared_meeting_read_model.json"],
  });
});

test("build_primary_documents --output-root writes the shared meeting model only under the staging root", () => {
  const beforeHash = sha256(SHARED_MEETING);
  const outputRoot = mkdtempSync(join(tmpdir(), "cityscroll-primary-stage-"));
  try {
    const result = spawnSync(
      process.execPath,
      [BUILDER, "--output-root", outputRoot],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...isolatedGitEnv(),
          CROL_BUILD_DAY: process.env.CROL_BUILD_DAY || "2026-09-09",
        },
        timeout: 120_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(sha256(SHARED_MEETING), beforeHash);
    const staged = join(outputRoot, "data/shared_meeting_read_model.json");
    const stagedBody = readFileSync(staged, "utf8");
    assert.match(stagedBody, /cityscroll\.shared_meeting_read_model\.v1/);
    assert.notEqual(createHash("sha256").update(stagedBody).digest("hex"), beforeHash);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
