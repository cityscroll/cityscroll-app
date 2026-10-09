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
  governedRefreshedArtifacts,
  loadPolicy,
  scanRepository,
  scanSource,
} from "../tools/check_refresh_exact_count_assertions.mjs";

const POLICY = loadPolicy();
const REFRESHED = governedRefreshedArtifacts(POLICY);
const COUNT_RE = POLICY.count_property_pattern;
const TOOL = new URL("../tools/check_refresh_exact_count_assertions.mjs", import.meta.url).pathname;
const EMPIRICAL_COUNT = 14;

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
  assert.ok(REFRESHED.includes("warehouse/receipts/proof/zap-projects_bulk_latest.json"));
  assert.ok(POLICY.empirical_starting_set.test_files.length >= 10);
});

test("default scan discovers by content and exceeds the empirical starting set", () => {
  const empirical = empiricalProvenanceFiles(POLICY);
  const discovered = discoverGovernedTestFiles(POLICY);
  const targets = defaultScanTargets(POLICY);
  assert.equal(
    empirical.length,
    EMPIRICAL_COUNT,
    `empirical provenance stays the ${EMPIRICAL_COUNT}-file restamp set`,
  );
  assert.ok(
    discovered.length > empirical.length,
    `content discovery must exceed the empirical list (got ${discovered.length})`,
  );
  assert.ok(
    targets.length > EMPIRICAL_COUNT,
    `default scan targets must exceed ${EMPIRICAL_COUNT} (got ${targets.length})`,
  );
  const targetRels = new Set(targets.map((t) => t.relative));
  for (const file of empirical) {
    assert.ok(
      targetRels.has(file.relative),
      `empirical provenance file must stay covered: ${file.relative}`,
    );
  }
  assert.ok(
    targetRels.has("test/warehouse_bulk.test.mjs"),
    "warehouse bulk proof suite must stay covered",
  );
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

test("exact live record-id pins against land membership fail; membership invariants pass", () => {
  const pinned = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const membership = JSON.parse(readFileSync(new URL("../site/data/land_place_membership.json", import.meta.url), "utf8"));
const delivered = membership.by_geography.nta2020.SI0105 || [];
assert.ok(delivered.includes("2026R0127"));
assert.deepEqual(delivered, ["2026R0127"]);
`;
  const pinnedFindings = scanSource(pinned, {
    relativePath: "test/mutation_live_record_id.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.ok(pinnedFindings.length >= 2, `expected exact-record-id findings, got ${pinnedFindings.length}`);
  assert.ok(pinnedFindings.every((row) => row.kind === "exact-record-id"));
  assert.ok(pinnedFindings.some((row) => row.literal === "2026R0127"));

  const invariant = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const membership = JSON.parse(readFileSync(new URL("../site/data/land_place_membership.json", import.meta.url), "utf8"));
const members = membership.by_geography.nta2020.SI0105 || [];
assert.ok(members.length >= 1);
const delivered = [...members];
assert.deepEqual(delivered, members);
for (const id of delivered) assert.ok(members.includes(id));
`;
  const invariantFindings = scanSource(invariant, {
    relativePath: "test/mutation_membership_invariant.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.deepEqual(invariantFindings, []);
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
  assert.ok(
    count > EMPIRICAL_COUNT,
    `CLI scanned count must exceed ${EMPIRICAL_COUNT} (got ${count})`,
  );
});

test("warehouse proof join-load exact row_count fails; invariant conversion passes", async () => {
  // Positive control for the warehouse bulk rematerialization pattern:
  // join(WAREHOUSE_DIR, "receipts", "proof", "zap-projects_bulk_latest.json")
  // plus assert.equal(...row_count, 32_964) must fail closed.
  await withTempDir("refresh-exact-count-warehouse", async (root) => {
    const policy = {
      ...POLICY,
      empirical_starting_set: {
        ...POLICY.empirical_starting_set,
        test_files: [],
      },
    };
    writeTree(root, {
      "architecture/refresh-exact-count-guard.json": `${JSON.stringify(policy, null, 2)}\n`,
      "warehouse/receipts/proof/zap-projects_bulk_latest.json": `${JSON.stringify({
        register: { row_count: 3 },
        snapshot_profile: { row_count: 3 },
        raw: { row_count: 3, mode: "soda_bulk" },
        parquet: { row_count: 3 },
      }, null, 2)}\n`,
      "test/warehouse_bulk_probe.test.mjs": `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const WAREHOUSE_DIR = join(process.cwd(), "warehouse");
const proof = JSON.parse(readFileSync(
  join(WAREHOUSE_DIR, "receipts", "proof", "zap-projects_bulk_latest.json"),
  "utf8",
));
assert.equal(proof.register.row_count, 32_964);
assert.equal(proof.snapshot_profile.row_count, 32_964);
`,
    });

    const discovered = discoverGovernedTestFiles(policy, root);
    assert.ok(
      discovered.some((t) => t.relative === "test/warehouse_bulk_probe.test.mjs"),
      "content discovery must find the warehouse proof join-load",
    );

    const liveFindings = scanRepository({ rootDir: root, policy });
    assert.equal(liveFindings.length, 2, "exact register and snapshot row_count pins must fail");
    assert.equal(liveFindings[0].literal, 32964);
    assert.match(formatFinding(liveFindings[0], policy), /zap-projects_bulk_latest\.json/);
    assert.match(formatFinding(liveFindings[0], policy), /fixture-pin/);
    assert.match(formatFinding(liveFindings[0], policy), /refresh-invariant/);

    const failRun = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.notEqual(failRun.status, 0, "CI-shaped invocation must fail on warehouse exact row_count");
    assert.match(failRun.stderr, /warehouse_bulk_probe\.test\.mjs:\d+/);
    assert.match(failRun.stderr, /32964/);
    assert.match(failRun.stderr, /zap-projects_bulk_latest\.json/);

    writeFileSync(join(root, "test/warehouse_bulk_probe.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const WAREHOUSE_DIR = join(process.cwd(), "warehouse");
const proof = JSON.parse(readFileSync(
  join(WAREHOUSE_DIR, "receipts", "proof", "zap-projects_bulk_latest.json"),
  "utf8",
));
assert.ok(proof.register.row_count > 0);
assert.equal(proof.register.row_count, proof.snapshot_profile.row_count);
assert.equal(proof.register.row_count, proof.raw.row_count);
assert.equal(proof.register.row_count, proof.parquet.row_count);
`);
    const invariantFindings = scanRepository({ rootDir: root, policy });
    assert.deepEqual(invariantFindings, [], "warehouse refresh invariant must clear the guard");
    const passInvariant = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(passInvariant.status, 0, "warehouse invariant conversion must pass CI-shaped invocation");
    assert.match(passInvariant.stdout, /scanned \d+ test file/);
  });
});

test("discovery recognises a governed artifact loaded through a helper call", () => {
  // Bare string argument to any helper — not only readFileSync / new URL.
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const loadJsonFile = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const shared = loadJsonFile("site/data/shared_meeting_read_model.json");
assert.equal((shared.meetings || []).length, 2);
`;
  const findings = scanSource(source, {
    relativePath: "test/helper_load_probe.test.mjs",
    refreshedArtifacts: REFRESHED,
    countPropertyPattern: COUNT_RE,
  });
  assert.equal(findings.length, 1, "helper-loaded exact count must be flagged");
  assert.equal(findings[0].literal, 2);
  const message = formatFinding(findings[0], POLICY);
  assert.match(message, /helper_load_probe\.test\.mjs:\d+/);
  assert.match(message, /fixture-pin/);
  assert.match(message, /refresh-invariant/);
  assert.match(message, /shared_meeting_read_model\.json/);
});

test("helper-load mutation control: adding an exact count fails, converting it passes", async () => {
  await withTempDir("refresh-exact-count-helper", async (root) => {
    const policy = {
      ...POLICY,
      empirical_starting_set: {
        ...POLICY.empirical_starting_set,
        test_files: [],
      },
    };
    writeTree(root, {
      "architecture/refresh-exact-count-guard.json": `${JSON.stringify(policy, null, 2)}\n`,
      "site/data/shared_meeting_read_model.json": `${JSON.stringify({ meetings: [{}, {}] }, null, 2)}\n`,
      "test/fixtures/helper-probe/shared_meeting_read_model.json": `${JSON.stringify({ meetings: [{}, {}] }, null, 2)}\n`,
      "test/helper_load_refresh_count.test.mjs": `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const loadJsonFile = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const shared = loadJsonFile("site/data/shared_meeting_read_model.json");
assert.equal((shared.meetings || []).length, 2);
`,
    });

    const discovered = discoverGovernedTestFiles(policy, root);
    assert.ok(
      discovered.some((t) => t.relative === "test/helper_load_refresh_count.test.mjs"),
      "content discovery must find the helper-loading file",
    );

    const failRun = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.notEqual(failRun.status, 0, "CI-shaped invocation must fail on helper-loaded exact count");
    assert.match(failRun.stderr, /helper_load_refresh_count\.test\.mjs:\d+/);
    assert.match(failRun.stderr, /fixture-pin/);
    assert.match(failRun.stderr, /refresh-invariant/);
    assert.match(failRun.stderr, /scanned \d+ test file/);

    writeFileSync(join(root, "test/helper_load_refresh_count.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const loadJsonFile = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const shared = loadJsonFile("test/fixtures/helper-probe/shared_meeting_read_model.json");
assert.equal((shared.meetings || []).length, 2);
`);
    const passFixture = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(passFixture.status, 0, "fixture conversion of helper load must pass");
    assert.match(passFixture.stdout, /scanned \d+ test file/);

    writeFileSync(join(root, "test/helper_load_refresh_count.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const loadJsonFile = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const shared = loadJsonFile("site/data/shared_meeting_read_model.json");
const count = (shared.meetings || []).length;
assert.ok(count >= 1);
assert.equal(count, (shared.meetings || []).length);
`);
    const passInvariant = spawnSync(process.execPath, [TOOL, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(passInvariant.status, 0, "invariant conversion of helper load must pass");
    assert.match(passInvariant.stdout, /scanned \d+ test file/);
  });
});

test("mention-only governed paths stay unscanned (first_class_refresh fixture)", () => {
  // Lists governed paths in a string array and loads only an ungoverned one.
  const discovered = discoverGovernedTestFiles(POLICY);
  assert.equal(
    discovered.some((t) => t.relative === "test/first_class_refresh.test.mjs"),
    false,
    "first_class_refresh.test.mjs must stay unscanned: it mentions governed paths without loading them",
  );
  // Positive control: a real helper load of the same artifact is discovered.
  assert.ok(
    discovered.some((t) => t.relative === "test/district_activity_membership_role.test.mjs"),
    "district_activity_membership_role.test.mjs must be discovered via loadJsonFile helper",
  );
});

test("widened discovery scans more than the prior direct-load set and stays clean or reports", () => {
  const run = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
  assert.match(run.stdout + run.stderr, /scanned (\d+) test file/);
  const combined = `${run.stdout}\n${run.stderr}`;
  const count = Number(combined.match(/scanned (\d+) test file/)[1]);
  assert.ok(count > 97, `helper-aware discovery must scan more than 97 (got ${count})`);
  // Either a clean pass or explicit findings — never a silent miss of the new set.
  if (run.status === 0) {
    assert.match(run.stdout, /0 exact-count asserts/);
  } else {
    assert.match(run.stderr, /finding/);
  }
});

test("repository warehouse_bulk suite is discovered and stays invariant-clean", () => {
  const discovered = discoverGovernedTestFiles(POLICY);
  assert.ok(
    discovered.some((t) => t.relative === "test/warehouse_bulk.test.mjs"),
    "test/warehouse_bulk.test.mjs must be discovered via warehouse proof join-load",
  );
  const findings = scanRepository({
    policy: POLICY,
    files: [new URL("./warehouse_bulk.test.mjs", import.meta.url).pathname],
  });
  assert.deepEqual(
    findings,
    [],
    "converted warehouse_bulk invariants must leave zero exact-count findings",
  );
});

test("clean repository check exports messages only when findings exist", () => {
  // Shape check: the helper returns strings, not raw finding objects.
  const messages = checkRepository({
    files: [new URL("./refresh_exact_count_guard.test.mjs", import.meta.url).pathname],
  });
  assert.ok(Array.isArray(messages));
});
