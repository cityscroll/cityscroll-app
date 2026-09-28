import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTrackedWorkingTreeClean,
  assertTrackedWorkingTreeUnchanged,
  trackedWorkingTreePorcelain,
} from "./helpers/tracked_working_tree.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = readFileSync(new URL("../.github/workflows/time-travel.yml", import.meta.url), "utf8");
const PREFLIGHT = readFileSync(new URL("../tools/preflight-required-checks.sh", import.meta.url), "utf8");
const PREPARE_FUNCTIONAL_SITE = readFileSync(new URL("../tools/prepare_functional_site.sh", import.meta.url), "utf8");
const PRIMARY_DOCUMENTS = readFileSync(new URL("../tools/build_primary_documents.mjs", import.meta.url), "utf8");
const ASSERT_TOOL = fileURLToPath(new URL("../tools/assert_tracked_working_tree_clean.mjs", import.meta.url));
const UNCHANGED_TOOL = fileURLToPath(new URL("../tools/assert_tracked_working_tree_unchanged.mjs", import.meta.url));
const FRICTION = readFileSync(new URL("./friction_t1_capability.test.mjs", import.meta.url), "utf8");
const MEETING_UI = readFileSync(new URL("./watch_text_query_meeting_ui.test.mjs", import.meta.url), "utf8");
const READER_UI = readFileSync(new URL("./watch_text_query_ui.test.mjs", import.meta.url), "utf8");
const LAND_DETAIL_BOUNDARY = readFileSync(new URL("./land_detail_boundary_layers.test.mjs", import.meta.url), "utf8");
const STALE_NAME_GUARD = readFileSync(new URL("./stale_name_guard.test.mjs", import.meta.url), "utf8");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined } });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function withFixtureRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-tracked-tree-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "tracked-tree@example.test"]);
    git(dir, ["config", "user.name", "Tracked Tree Guard"]);
    mkdirSync(join(dir, "docs/evidence/example"), { recursive: true });
    writeFileSync(join(dir, "docs/evidence/example/capture-manifest.json"), '{"schema":"fixture"}\n');
    git(dir, ["add", "docs/evidence/example/capture-manifest.json"]);
    git(dir, ["commit", "-m", "fixture"]);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("assertTrackedWorkingTreeClean passes on a clean fixture repository", () => {
  withFixtureRepo((dir) => {
    assert.equal(trackedWorkingTreePorcelain(dir), "");
    assert.doesNotThrow(() => assertTrackedWorkingTreeClean(dir));
  });
});

test("assertTrackedWorkingTreeClean fails when a tracked evidence file is rewritten", () => {
  withFixtureRepo((dir) => {
    writeFileSync(
      join(dir, "docs/evidence/example/capture-manifest.json"),
      '{"schema":"fixture","clock":"rewritten"}\n',
    );
    const dirty = trackedWorkingTreePorcelain(dir);
    assert.match(dirty, /capture-manifest\.json/);
    assert.throws(
      () => assertTrackedWorkingTreeClean(dir),
      (error) => {
        assert.equal(error.code, "TRACKED_WORKING_TREE_DIRTY");
        assert.match(error.message, /tracked working tree is dirty/);
        assert.match(error.message, /capture-manifest\.json/);
        return true;
      },
    );

    const tool = spawnSync(process.execPath, [ASSERT_TOOL], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined },
    });
    assert.notEqual(tool.status, 0);
    assert.match(tool.stderr, /tracked working tree is dirty/);
  });
});

test("time-travel workflow refuses tracked residue after the shifted suite", () => {
  assert.match(WORKFLOW, /Refuse tracked working-tree residue/);
  assert.match(WORKFLOW, /tools\/assert_tracked_working_tree_clean\.mjs/);
});

test("deadline and watch-text evidence tests keep docs/evidence read-only", () => {
  for (const [label, source] of [
    ["friction_t1_capability.test.mjs", FRICTION],
    ["watch_text_query_meeting_ui.test.mjs", MEETING_UI],
    ["watch_text_query_ui.test.mjs", READER_UI],
    ["land_detail_boundary_layers.test.mjs", LAND_DETAIL_BOUNDARY],
  ]) {
    assert.doesNotMatch(
      source,
      /writeFileSync\([^)]*docs\/evidence/,
      `${label} must not write tracked docs/evidence`,
    );
    assert.doesNotMatch(
      source,
      /writeFileSync\(fileURLToPath\(/,
      `${label} must not write capture manifests through fileURLToPath`,
    );
  }
  assert.ok(FRICTION.includes("assertEvidenceExample"));
  assert.match(MEETING_UI, /Keep committed evidence read-only/);
  assert.match(READER_UI, /Keep committed evidence read-only/);
  assert.match(LAND_DETAIL_BOUNDARY, /Keep committed evidence read-only/);
  // Silence unused-root lint style expectations in some runners.
  assert.ok(ROOT.length > 0);
});

test("stale-name guard suite keeps the real allowlist and repo root read-only", () => {
  assert.match(
    STALE_NAME_GUARD,
    /LEGACY_NAME_GUARD_ROOT/,
    "stale_name_guard.test.mjs must point the guard at an injected fixture root",
  );
  assert.match(
    STALE_NAME_GUARD,
    /mkdtempSync/,
    "stale_name_guard.test.mjs must exercise mutations inside a temporary fixture",
  );
  assert.doesNotMatch(
    STALE_NAME_GUARD,
    /writeFileSync\(\s*ALLOWLIST\b/,
    "stale_name_guard.test.mjs must not write the tracked allowlist through ALLOWLIST",
  );
  assert.doesNotMatch(
    STALE_NAME_GUARD,
    /writeFileSync\([^;]*legacy-name-allowlist\.txt/,
    "stale_name_guard.test.mjs must not write the tracked allowlist by repository path",
  );
  assert.doesNotMatch(
    STALE_NAME_GUARD,
    /writeFileSync\(\s*PROBE\b/,
    "stale_name_guard.test.mjs must not write a repo-root probe through PROBE",
  );
  assert.doesNotMatch(
    STALE_NAME_GUARD,
    /writeFileSync\(\s*targetUrl\b/,
    "stale_name_guard.test.mjs must not rewrite README.md in the real repository",
  );
  assert.doesNotMatch(
    STALE_NAME_GUARD,
    /new URL\("\.\.\/\.legacy-name-guard-probe\.txt"/,
    "stale_name_guard.test.mjs must not target the real repo-root probe path",
  );
  assert.match(
    STALE_NAME_GUARD,
    /assertTrackedWorkingTreeClean\(REAL_ROOT/,
    "stale_name_guard.test.mjs must refuse tracked allowlist residue after the suite",
  );
});

test("assertTrackedWorkingTreeClean fails when the legacy-name allowlist is emptied", () => {
  withFixtureRepo((dir) => {
    mkdirSync(join(dir, ".github"), { recursive: true });
    const allowlist = join(dir, ".github/legacy-name-allowlist.txt");
    writeFileSync(allowlist, "# fixture allowlist\npath\tdGVzdA==\t# reason\n");
    git(dir, ["add", ".github/legacy-name-allowlist.txt"]);
    git(dir, ["commit", "-m", "allowlist"]);
    writeFileSync(allowlist, "");
    assert.throws(
      () => assertTrackedWorkingTreeClean(dir),
      (error) => {
        assert.equal(error.code, "TRACKED_WORKING_TREE_DIRTY");
        assert.match(error.message, /legacy-name-allowlist\.txt/);
        return true;
      },
    );
  });
});

test("assertTrackedWorkingTreeUnchanged passes when porcelain is stable", () => {
  withFixtureRepo((dir) => {
    const before = trackedWorkingTreePorcelain(dir);
    assert.doesNotThrow(() => assertTrackedWorkingTreeUnchanged(before, dir));
  });
});

test("assertTrackedWorkingTreeUnchanged fails on a deliberate tracked-file write", () => {
  withFixtureRepo((dir) => {
    const before = trackedWorkingTreePorcelain(dir);
    writeFileSync(
      join(dir, "docs/evidence/example/capture-manifest.json"),
      '{"schema":"fixture","clock":"deliberate-write"}\n',
    );
    assert.throws(
      () => assertTrackedWorkingTreeUnchanged(before, dir),
      (error) => {
        assert.equal(error.code, "TRACKED_WORKING_TREE_CHANGED");
        assert.match(error.message, /tracked working tree changed during suite/);
        assert.match(error.message, /capture-manifest\.json/);
        return true;
      },
    );

    const baseline = join(dir, "baseline.txt");
    writeFileSync(baseline, before ? `${before}\n` : "");
    const tool = spawnSync(process.execPath, [UNCHANGED_TOOL, "--baseline", baseline], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined },
    });
    assert.notEqual(tool.status, 0);
    assert.match(tool.stderr, /tracked working tree changed during suite/);
    assert.match(tool.stderr, /capture-manifest\.json/);
  });
});

test("prepare_functional_site preserves tracked primary documents and guards porcelain", () => {
  assert.match(
    PREPARE_FUNCTIONAL_SITE,
    /build_primary_documents\.mjs --preserve-tracked/,
    "prepare_functional_site must materialize generated docs without rewriting tracked read models",
  );
  assert.match(
    PREPARE_FUNCTIONAL_SITE,
    /assert_tracked_working_tree_unchanged\.mjs --write-baseline/,
    "prepare_functional_site must snapshot tracked porcelain before materializing documents",
  );
  assert.match(
    PREPARE_FUNCTIONAL_SITE,
    /assert_tracked_working_tree_unchanged\.mjs --baseline/,
    "prepare_functional_site must refuse tracked residue after materializing documents",
  );
  assert.doesNotMatch(
    PREPARE_FUNCTIONAL_SITE,
    /node tools\/build_primary_documents\.mjs(?! --preserve-tracked)/,
    "prepare_functional_site must not invoke the primary-document builder in default write mode",
  );
});

test("primary-document builder can preserve tracked outputs and remap writes", () => {
  assert.match(PRIMARY_DOCUMENTS, /--preserve-tracked/);
  assert.match(PRIMARY_DOCUMENTS, /--output-root/);
  assert.match(PRIMARY_DOCUMENTS, /resolvePrimaryDocumentWritePlan/);
  assert.match(PRIMARY_DOCUMENTS, /preserved tracked/);
});

test("preflight refuses tracked residue after the unit families", () => {
  assert.match(PREFLIGHT, /Refuse tracked working-tree residue/);
  assert.match(PREFLIGHT, /assert_tracked_working_tree_unchanged\.mjs --write-baseline/);
  assert.match(PREFLIGHT, /assert_tracked_working_tree_unchanged\.mjs --baseline/);
});
