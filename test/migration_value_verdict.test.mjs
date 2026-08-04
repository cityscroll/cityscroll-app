import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const verdictPath = new URL("../docs/evidence/migration-value-verdict.json", import.meta.url);
const pagePath = new URL("../docs/evidence/migration-value-verdict.html", import.meta.url);
const baselinePath = new URL("../docs/evidence/hosting-migration-baseline.json", import.meta.url);
const scorecardPath = new URL("../docs/evidence/migration-value-scorecard.md", import.meta.url);

const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
const page = readFileSync(pagePath, "utf8");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const scorecard = readFileSync(scorecardPath, "utf8");

function quantile(sorted, p) {
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

test("migration verdict covers every registered scorecard claim", () => {
  const registered = baseline.claims_to_measure_after_cutover.map((claim) => claim.id).sort();
  const measured = verdict.claims.map((claim) => claim.id).sort();

  assert.deepEqual(measured, registered);
  assert.equal(verdict.claims.length, 3);
  for (const claim of verdict.claims) {
    assert.ok(
      ["confirmed", "not-confirmed", "cant-measure-yet"].includes(claim.verdict),
      `${claim.id} has an unsupported verdict`,
    );
    assert.ok(claim.before?.tag, `${claim.id} must label its before evidence`);
    assert.ok(claim.after?.tag, `${claim.id} must label its after evidence`);
  }

  assert.deepEqual(verdict.overall.counts, {
    confirmed: 1,
    not_confirmed: 0,
    cant_measure_yet: 2,
  });
  assert.equal(verdict.overall.verdict, "not-confirmed");
});

test("merge-to-deploy summary is derived from the 50 named samples", () => {
  const samples = verdict.merge_to_deploy_samples;
  assert.equal(samples.length, 50);
  assert.equal(new Set(samples.map((sample) => sample.pr)).size, 50);
  assert.equal(new Set(samples.map((sample) => sample.run)).size, 50);

  for (const sample of samples) {
    const derived = (Date.parse(sample.deployed_at) - Date.parse(sample.merged_at)) / 1000;
    assert.ok(Math.abs(derived - sample.latency_s) < 0.001, `PR ${sample.pr} latency drifted`);
    assert.match(String(sample.run), /^30\d{9}$/);
  }

  const sorted = samples.map((sample) => sample.latency_s).sort((a, b) => a - b);
  const after = verdict.claims.find((claim) => claim.id === "ship-faster").after;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  assert.equal(after.n, samples.length);
  assert.equal(after.min_s, sorted[0]);
  assert.equal(after.max_s, sorted.at(-1));
  assert.ok(Math.abs(after.mean_s - mean) < 0.000001);
  assert.ok(Math.abs(after.median_s - quantile(sorted, 0.5)) < 0.000001);
  assert.ok(Math.abs(after.p95_s - quantile(sorted, 0.95)) < 0.000001);
  assert.equal(after.under_60_s, samples.filter((sample) => sample.latency_s < 60).length);
});

test("after-cutover baseline points to the measured verdict without upgrading unknowns", () => {
  const after = baseline.after_cutover;
  assert.equal(after.status, "value-partially-confirmed");
  assert.equal(after.overall_verdict, "not-confirmed");
  assert.equal(after.merge_to_live.verdict, "confirmed");
  assert.equal(after.merge_to_live.n, 50);
  assert.equal(after.detection_latency.verdict, "cant-measure-yet");
  assert.equal(after.rollback_wall_clock.verdict, "cant-measure-yet");
  assert.equal(after.rollback_wall_clock.actual_restore_s, null);
  assert.equal(after.rollback_wall_clock.production_mutation_performed, false);
});

test("button page exposes every claim and evidence class accessibly", () => {
  assert.equal((page.match(/<button[^>]+role="tab"/g) || []).length, 3);
  assert.equal((page.match(/<section[^>]+role="tabpanel"/g) || []).length, 3);
  for (const id of ["ship", "catch", "rollback"]) {
    assert.match(page, new RegExp(`id="tab-${id}"[^>]+aria-controls="panel-${id}"`));
    assert.match(page, new RegExp(`id="panel-${id}"[^>]+aria-labelledby="tab-${id}"`));
  }

  assert.match(page, /Measured/);
  assert.match(page, /Esti&#109;ated/);
  assert.match(page, /Can't measure yet/);
  assert.match(page, /migration-value-verdict\.json/);
  assert.match(page, /hosting-migration-baseline\.json/);
  assert.match(page, /actions\/runs\/30885970932/);
  assert.match(scorecard, /migration-value-verdict\.html/);
  assert.match(scorecard, /migration-value-verdict\.json/);
});
