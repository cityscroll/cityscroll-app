/**
 * Mutation controls for the refresh exact-count guard.
 *
 * Adding an exact population count against refreshed site/data must fail.
 * Converting that assert to a fixture pin or a refresh-surviving invariant must
 * pass. Exact counts against committed fixtures stay unflagged.
 * The default run discovers every test that loads a governed artifact by
 * content; the empirical starting set is provenance, not the scan allowlist.
 *
 *   node --test test/refresh_exact_count_guard.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import {
  checkRepository,
  defaultScanTargets,
  discoverGovernedTestFiles,
  empiricalProvenanceFiles,
  formatFinding,
  loadPolicy,
  scanRepository,
  scanSource,
} from "../tools/check_refresh_exact_count_assertions.mjs";

const POLICY = loadPolicy();
const REFRESHED = POLICY.scope.refreshed_site_data_artifacts;
const COUNT_RE = POLICY.count_property_pattern;
const TOOL = new URL("../tools/check_refresh_exact_count_assertions.mjs", import.meta.url).pathname;

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
}

test("policy names the two permitted shapes and scopes refreshed artifacts", () => {
  assert.equal(POLICY.schema, "cityscroll.refresh_exact_count_guard.v1");
  assert.deepEqual(
    POLICY.permitted_shapes.map((shape) => shape.id).sort(),
    ["fixture-pin", "refresh-invariant"],
  );
  assert.ok(REFRESHED.includes("site/data/meeting_outcomes_snapshot.json"));
  assert.ok(POLICY.empirical_starting_set.test_files.length >= 10);
});

test("default scan discovers by content and exceeds the empirical starting set", () => {
  const empirical = empiricalProvenanceFiles(POLICY);
  const discovered = discoverGovernedTestFiles(POLICY);
  const targets = defaultScanTargets(POLICY);
  assert.equal(empirical.length, 13, "empirical provenance stays the 13-file restamp set");
  assert.ok(
    discovered.length > empirical.length,
    `content discovery must exceed the empirical list (got ${discovered.length})`,
  );
  assert.ok(
    targets.length > 13,
    `default scan targets must exceed 13 (got ${targets.length})`,
  );
  const targetRels = new Set(targets.map((t) => t.relative));
  for (const file of empirical) {
    assert.ok(
      targetRels.has(file.relative),
      `empirical provenance file must stay covered: ${file.relative}`,
    );
  }
});

test("adding an exact-count assert on refreshed site/data fails with file, line, and permitted shapes", () => {
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
assert.equal(Object.keys(snapshot.by_notice).length, 78);
`;
  const findings = scanSource(source, {
    relativePath: "test/mutation_live_count.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].literal, 78);
  assert.ok(findings[0].line >= 4);
  const message = formatFinding(findings[0], POLICY);
  assert.match(message, /test\/mutation_live_count\.test\.mjs:\d+/);
  assert.match(message, /fixture-pin/);
  assert.match(message, /refresh-invariant/);
  assert.match(message, /meeting_outcomes_snapshot\.json/);
});

test("converting the same assert to a fixture pin makes the guard pass", () => {
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("./fixtures/legislative-matter-population/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
assert.equal(Object.keys(snapshot.by_notice).length, 78);
`;
  const findings = scanSource(source, {
    relativePath: "test/mutation_fixture_pin.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.deepEqual(findings, []);
});

test("converting the same assert to a refresh invariant makes the guard pass", () => {
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const count = Object.keys(snapshot.by_notice || {}).length;
assert.ok(count > 0, "retained notice population must stay non-empty");
assert.equal(count, Object.keys(snapshot.by_notice).length);
`;
  const findings = scanSource(source, {
    relativePath: "test/mutation_invariant.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.deepEqual(findings, []);
});

test("exact-count asserts on committed fixtures pass unflagged", () => {
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const receipt = JSON.parse(readFileSync(new URL("./fixtures/meetings-location-residual/meetings_location_residual_receipt.json", import.meta.url), "utf8"));
assert.equal(receipt.result.total, 24);
assert.equal(receipt.result.joined, 13);
`;
  const findings = scanSource(source, {
    relativePath: "test/meetings_location_residual.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.deepEqual(findings, []);
});

test("unrelated count asserts in a file that loads refreshed data stay unflagged", () => {
  // Narrowing: loading a governed artifact must not flag markup/source counts
  // that do not reference the load binding.
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const sourceText = "await loadWatchRows(await loadWatchRows(await loadWatchRows(";
assert.equal((sourceText.match(/await loadWatchRows\\(/g) || []).length, 3);
assert.equal(ROUTE_CLASSIFICATIONS.length, 23);
void snapshot;
`;
  const findings = scanSource(source, {
    relativePath: "test/mutation_unrelated_counts.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.deepEqual(findings, []);
});

test("new unlisted test file with live exact count fails under default no-arg discovery", async () => {
  await withTempDir("refresh-exact-count-guard", async (root) => {
    // Empty empirical list: discovery alone must catch a brand-new file.
    const policy = {
      ...POLICY,
      empirical_starting_set: {
        ...POLICY.empirical_starting_set,
        test_files: [],
      },
    };
    writeTree(root, {
      "architecture/refresh-exact-count-guard.json": `${JSON.stringify(policy, null, 2)}\n`,
      "site/data/meeting_outcomes_snapshot.json": `${JSON.stringify({ by_notice: { a: {}, b: {} } }, null, 2)}\n`,
      "test/fixtures/probe/meeting_outcomes_snapshot.json": `${JSON.stringify({ by_notice: { a: {}, b: {} } }, null, 2)}\n`,
      "test/brand_new_refresh_count.test.mjs": `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
assert.equal(Object.keys(snapshot.by_notice).length, 2);
`,
    });

    const discovered = discoverGovernedTestFiles(policy, root);
    assert.ok(
      discovered.some((t) => t.relative === "test/brand_new_refresh_count.test.mjs"),
      "content discovery must find the new unlisted file",
    );

    const liveFindings = scanRepository({ rootDir: root, policy });
    assert.equal(liveFindings.length, 1, "live exact count in a new file must fail the guard");
    const message = formatFinding(liveFindings[0], policy);
    assert.match(message, /test\/brand_new_refresh_count\.test\.mjs:\d+/);
    assert.match(message, /fixture-pin/);
    assert.match(message, /refresh-invariant/);
    assert.match(message, /meeting_outcomes_snapshot\.json/);

    // Same invocation shape CI uses: no file args, only --root.
    const failRun = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.notEqual(failRun.status, 0, "CI-shaped invocation must fail on the new file");
    assert.match(failRun.stderr, /brand_new_refresh_count\.test\.mjs:\d+/);
    assert.match(failRun.stderr, /fixture-pin/);
    assert.match(failRun.stderr, /refresh-invariant/);
    assert.match(failRun.stderr, /scanned \d+ test file/);

    writeFileSync(join(root, "test/brand_new_refresh_count.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("./fixtures/probe/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
assert.equal(Object.keys(snapshot.by_notice).length, 2);
`);
    const fixtureFindings = scanRepository({ rootDir: root, policy });
    assert.deepEqual(fixtureFindings, [], "fixture pin must clear the guard");
    const passFixture = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(passFixture.status, 0, "fixture conversion must pass CI-shaped invocation");
    assert.match(passFixture.stdout, /scanned \d+ test file/);

    writeFileSync(join(root, "test/brand_new_refresh_count.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const count = Object.keys(snapshot.by_notice || {}).length;
assert.ok(count >= 1);
assert.equal(count, Object.keys(snapshot.by_notice).length);
`);
    const invariantFindings = scanRepository({ rootDir: root, policy });
    assert.deepEqual(invariantFindings, [], "refresh invariant must clear the guard");
    const passInvariant = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(passInvariant.status, 0, "invariant conversion must pass CI-shaped invocation");
    assert.match(passInvariant.stdout, /scanned \d+ test file/);
  });
});

test("repository mutation control: live exact count fails, fixture conversion passes", async () => {
  await withTempDir("refresh-exact-count-guard", async (root) => {
    const policy = {
      ...POLICY,
      empirical_starting_set: {
        ...POLICY.empirical_starting_set,
        test_files: ["test/probe_refresh_count.test.mjs"],
      },
    };
    writeTree(root, {
      "architecture/refresh-exact-count-guard.json": `${JSON.stringify(policy, null, 2)}\n`,
      "site/data/meeting_outcomes_snapshot.json": `${JSON.stringify({ by_notice: { a: {}, b: {} } }, null, 2)}\n`,
      "test/fixtures/probe/meeting_outcomes_snapshot.json": `${JSON.stringify({ by_notice: { a: {}, b: {} } }, null, 2)}\n`,
      "test/probe_refresh_count.test.mjs": `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
assert.equal(Object.keys(snapshot.by_notice).length, 2);
`,
    });

    const liveFindings = scanRepository({ rootDir: root, policy });
    assert.equal(liveFindings.length, 1, "live exact count must fail the guard");
    assert.match(formatFinding(liveFindings[0], policy), /fixture-pin/);
    assert.match(formatFinding(liveFindings[0], policy), /refresh-invariant/);

    writeFileSync(join(root, "test/probe_refresh_count.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("./fixtures/probe/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
assert.equal(Object.keys(snapshot.by_notice).length, 2);
`);
    const fixtureFindings = scanRepository({ rootDir: root, policy });
    assert.deepEqual(fixtureFindings, [], "fixture pin must clear the guard");

    writeFileSync(join(root, "test/probe_refresh_count.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const count = Object.keys(snapshot.by_notice || {}).length;
assert.ok(count >= 1);
assert.equal(count, Object.keys(snapshot.by_notice).length);
`);
    const invariantFindings = scanRepository({ rootDir: root, policy });
    assert.deepEqual(invariantFindings, [], "refresh invariant must clear the guard");
  });
});

test("CLI reports scanned-file count on a clean repository pass", () => {
  const run = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /scanned (\d+) test file/);
  const count = Number(run.stdout.match(/scanned (\d+) test file/)[1]);
  assert.ok(count > 13, `CLI scanned count must exceed 13 (got ${count})`);
});

test("clean repository check exports messages only when findings exist", () => {
  // Shape check: the helper returns strings, not raw finding objects.
  const messages = checkRepository({
    files: [new URL("./refresh_exact_count_guard.test.mjs", import.meta.url).pathname],
  });
  assert.ok(Array.isArray(messages));
});
