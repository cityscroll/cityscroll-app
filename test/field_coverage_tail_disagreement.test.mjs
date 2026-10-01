/**
 * Acceptance for the two-artifact notice-context tail disagreement retained on
 * the field-coverage lattice read-back.
 *
 * Checks:
 * 1. Both measuring artifacts are named by path with values and difference.
 * 2. Agreement is an explicit difference_ms 0 (never an omitted field).
 * 3. Below-floor tails keep insufficient_sample and withhold percentiles.
 * 4. Mutation control: perturbing one value moves the difference; restore → 0.
 * 5. No device-identity keys are introduced.
 * 6. Observation counts, percentiles, and too-few markers stay unchanged.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildFieldCoverageTailDisagreement,
} from "../tools/build_field_coverage_tail_disagreement.mjs";
import {
  LATTICE_PATH,
  READINESS_PATH,
  buildTailArtifactDisagreement,
  collectForbiddenDeviceIdentityKeys,
  latticeNoticeContextMeasurement,
  readinessPrimaryMeasurement,
} from "../tools/lib/tail_artifact_disagreement.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATTICE_FILE = join(ROOT, LATTICE_PATH);
const READINESS_FILE = join(ROOT, READINESS_PATH);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertAncestor(revision) {
  assert.match(revision, /^[0-9a-f]{40}$/);
  // merge-base --is-ancestor exits 0 on success; execFileSync throws otherwise.
  execFileSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("retained lattice names both artifacts, both p95 values, and the difference", () => {
  const lattice = readJson(LATTICE_FILE);
  const readiness = readJson(READINESS_FILE);
  const disagreement = lattice.tail_artifact_disagreement;
  assert.ok(disagreement, "tail_artifact_disagreement must be retained on the lattice");

  assert.equal(disagreement.metric_id, "component_ready_ms");
  assert.equal(disagreement.surface_id, "notice");
  assert.equal(disagreement.component_id, "notice-context");
  assert.equal(disagreement.percentile, "p95");
  assert.equal(disagreement.artifacts.length, 2);

  const [latticeArtifact, readinessArtifact] = disagreement.artifacts;
  assert.equal(latticeArtifact.path, LATTICE_PATH);
  assert.equal(readinessArtifact.path, READINESS_PATH);

  const expectedLattice = latticeNoticeContextMeasurement(lattice);
  const expectedReadiness = readinessPrimaryMeasurement(readiness);
  assert.equal(latticeArtifact.state, "measured");
  assert.equal(readinessArtifact.state, "measured");
  assert.equal(
    latticeArtifact.p95_ms,
    Math.round(expectedLattice.p95_ms * 10) / 10,
  );
  assert.equal(readinessArtifact.p95_ms, expectedReadiness.p95_ms);
  assert.equal(
    disagreement.difference_ms,
    Math.round((latticeArtifact.p95_ms - readinessArtifact.p95_ms) * 10) / 10,
  );
  assert.equal(disagreement.agreement, "disagree");
  assert.equal(disagreement.percentile_published, true);
  assert.notEqual(disagreement.difference_ms, 0);

  // Keywords the acceptance search looks for must be present as retained fields.
  const text = JSON.stringify(disagreement);
  assert.match(text, /artifact/);
  assert.match(text, /disagree/);
  assert.match(text, /difference_ms/);

  assertAncestor(disagreement.repository_revision);
});

test("agreement is an explicit difference_ms of zero, never an omitted field", () => {
  const equal = buildTailArtifactDisagreement({
    lattice: { state: "measured", sampled_count: 40, p95_ms: 3000 },
    readiness: { state: "measured", sampled_count: 40, p95_ms: 3000 },
  });
  assert.equal(equal.agreement, "agree");
  assert.equal(equal.difference_ms, 0);
  assert.equal(equal.percentile_published, true);
  assert.equal(Object.prototype.hasOwnProperty.call(equal, "difference_ms"), true);

  // Positive control: a record that omits difference_ms fails the retained shape.
  const stripped = { ...equal };
  delete stripped.difference_ms;
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "difference_ms"), false);
  assert.equal(stripped.difference_ms, undefined);
  // Readers must not treat a missing field as zero agreement:
  assert.notEqual(stripped.difference_ms, 0);

  // The builder always pairs agreement=agree with difference_ms=0.
  assert.equal(
    buildTailArtifactDisagreement({
      lattice: { state: "measured", sampled_count: 40, p95_ms: 100 },
      readiness: { state: "measured", sampled_count: 40, p95_ms: 100 },
    }).difference_ms,
    0,
  );
});

test("below-floor tails stay insufficient_sample and withhold percentiles", () => {
  const withheld = buildTailArtifactDisagreement({
    lattice: {
      state: "insufficient_sample",
      sampled_count: 5,
      p95_ms: 9999,
      reason: "below_floor",
    },
    readiness: { state: "measured", sampled_count: 127, p95_ms: 3119.8 },
  });
  assert.equal(withheld.artifacts[0].state, "insufficient_sample");
  assert.equal(withheld.artifacts[0].p95_ms, null);
  assert.equal(withheld.artifacts[0].percentile_withheld, true);
  assert.equal(withheld.artifacts[0].reason, "below_floor");
  assert.equal(withheld.difference_ms, null);
  assert.equal(withheld.agreement, "not_comparable");
  assert.equal(withheld.percentile_published, false);

  // Positive control: a measured pair does publish the percentile.
  const measured = buildTailArtifactDisagreement({
    lattice: { state: "measured", sampled_count: 85, p95_ms: 8001.9 },
    readiness: { state: "measured", sampled_count: 127, p95_ms: 3119.8 },
  });
  assert.equal(measured.percentile_published, true);
  assert.equal(measured.artifacts[0].p95_ms, 8001.9);
  assert.ok(Number.isFinite(measured.difference_ms));
});

test("mutation control: perturbing one artifact moves the difference; restore returns zero", () => {
  const base = { state: "measured", sampled_count: 50, p95_ms: 4000 };
  const agreed = buildTailArtifactDisagreement({
    lattice: base,
    readiness: { ...base },
  });
  assert.equal(agreed.difference_ms, 0);
  assert.equal(agreed.agreement, "agree");

  const perturbed = buildTailArtifactDisagreement({
    lattice: { ...base, p95_ms: 4500 },
    readiness: { ...base },
  });
  assert.equal(perturbed.difference_ms, 500);
  assert.equal(perturbed.agreement, "disagree");

  const restored = buildTailArtifactDisagreement({
    lattice: { ...base, p95_ms: 4000 },
    readiness: { ...base },
  });
  assert.equal(restored.difference_ms, 0);
  assert.equal(restored.agreement, "agree");

  // Positive control in the other direction (readiness moves).
  const otherWay = buildTailArtifactDisagreement({
    lattice: { ...base },
    readiness: { ...base, p95_ms: 3500 },
  });
  assert.equal(otherWay.difference_ms, 500);
  assert.equal(otherWay.agreement, "disagree");
});

test("no device identity keys are introduced; bucket keys remain", () => {
  const lattice = readJson(LATTICE_FILE);
  const forbidden = collectForbiddenDeviceIdentityKeys(lattice);
  assert.deepEqual(forbidden, []);

  // Positive control: the collector fires when a forbidden key is present.
  const planted = collectForbiddenDeviceIdentityKeys({
    observation_counts: { device_cells: 1 },
    distinct_devices: 3,
  });
  assert.deepEqual(planted, ["distinct_devices"]);

  const text = JSON.stringify(lattice);
  assert.match(text, /"device_class"/);
  assert.match(text, /"device_cells"/);
  assert.match(text, /"device_states"/);
  assert.doesNotMatch(text, /"distinct_devices"/);
  assert.doesNotMatch(text, /"device_id"/);
});

test("observation counts, percentiles, and too-few markers are unchanged by the stamp", () => {
  const before = readJson(LATTICE_FILE);
  // Snapshot the protected fields from the committed lattice before a rebuild.
  const protectedSnapshot = {
    observation_counts: clone(before.observation_counts),
    sample_floor: before.sample_floor,
    acceptance_checks: clone(before.acceptance_checks),
  };
  assert.equal(protectedSnapshot.observation_counts.retained_readiness_rows, 555);
  assert.equal(protectedSnapshot.observation_counts.readiness_cells, 23);
  assert.equal(protectedSnapshot.observation_counts.device_cells, 48);
  assert.equal(protectedSnapshot.observation_counts.phase_cells, 36);
  assert.equal(protectedSnapshot.observation_counts.device_states.insufficient_sample, 12);
  assert.ok(protectedSnapshot.observation_counts.device_states.measured >= 1);

  const noticeContext = before.readiness_by_surface.notice.cells.find(
    (cell) => cell.metric_id === "component_ready_ms" && cell.component_id === "notice-context",
  );
  assert.equal(noticeContext.state, "measured");
  assert.ok(Number.isFinite(noticeContext.percentiles.p75));
  assert.ok(Number.isFinite(noticeContext.percentiles.p95));

  // Rebuild into a temp copy; the protected lattice body must match.
  const dir = mkdtempSync(join(tmpdir(), "tail-disagreement-"));
  tempDirs.push(dir);
  const rebuilt = buildFieldCoverageTailDisagreement({
    lattice: before,
    readiness: readJson(READINESS_FILE),
    repository_revision: before.tail_artifact_disagreement.repository_revision,
  });
  writeFileSync(join(dir, "read-back.json"), `${JSON.stringify(rebuilt, null, 2)}\n`);

  assert.deepEqual(rebuilt.observation_counts, protectedSnapshot.observation_counts);
  assert.equal(rebuilt.sample_floor, protectedSnapshot.sample_floor);
  assert.deepEqual(rebuilt.acceptance_checks, protectedSnapshot.acceptance_checks);
  assert.deepEqual(
    rebuilt.readiness_by_surface.notice.cells,
    before.readiness_by_surface.notice.cells,
  );

  // insufficient_sample / below_floor markers remain present across the lattice.
  const asText = JSON.stringify(rebuilt);
  assert.match(asText, /insufficient_sample/);
  assert.match(asText, /below_floor/);
  assert.match(asText, /"p75"/);
  assert.match(asText, /"p95"/);
});

test("builder --check / stamp round-trip stays derived from both sources", () => {
  const lattice = readJson(LATTICE_FILE);
  const readiness = readJson(READINESS_FILE);
  const stamped = buildFieldCoverageTailDisagreement({
    lattice,
    readiness,
    repository_revision: lattice.tail_artifact_disagreement.repository_revision,
  });
  assert.deepEqual(
    stamped.tail_artifact_disagreement,
    lattice.tail_artifact_disagreement,
  );

  // Positive control: changing readiness p95 changes the retained difference.
  const readinessPerturbed = clone(readiness);
  readinessPerturbed.primary.p95_ms = readiness.primary.p95_ms + 100;
  const moved = buildFieldCoverageTailDisagreement({
    lattice,
    readiness: readinessPerturbed,
    repository_revision: lattice.tail_artifact_disagreement.repository_revision,
  });
  assert.equal(
    moved.tail_artifact_disagreement.difference_ms,
    Math.round((lattice.tail_artifact_disagreement.difference_ms - 100) * 10) / 10,
  );
  assert.notEqual(
    moved.tail_artifact_disagreement.difference_ms,
    lattice.tail_artifact_disagreement.difference_ms,
  );
});
