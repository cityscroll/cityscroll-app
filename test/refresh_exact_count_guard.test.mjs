/**
 * Mutation controls for the refresh exact-count guard.
 *
 * Adding an exact population count against refreshed site/data must fail.
 * Converting that assert to a fixture pin or a refresh-surviving invariant must
 * pass. Exact counts against committed fixtures stay unflagged.
 *
 *   node --test test/refresh_exact_count_guard.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import {
  checkRepository,
  formatFinding,
  loadPolicy,
  scanRepository,
  scanSource,
} from "../tools/check_refresh_exact_count_assertions.mjs";

const POLICY = loadPolicy();
const REFRESHED = POLICY.scope.refreshed_site_data_artifacts;
const COUNT_RE = POLICY.count_property_pattern;

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

test("clean repository check exports messages only when findings exist", () => {
  // Shape check: the helper returns strings, not raw finding objects.
  const messages = checkRepository({
    files: [new URL("./refresh_exact_count_guard.test.mjs", import.meta.url).pathname],
  });
  assert.ok(Array.isArray(messages));
});
