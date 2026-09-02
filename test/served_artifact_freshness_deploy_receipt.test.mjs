// The served-artifact freshness check compares the live manifest against the
// manifest a deploy actually published. Rebuilding the same revision does not
// reproduce the deployed bytes, because the production build refreshes decision
// outcomes from live sources, so a rebuild basis fails unconditionally.
//
// The specimen is workflow run 33574860994 (2026-09-02T00:34Z), whose retained
// receipt reported exactly one finding, "artifact hash mismatch", while the
// served artifact carried main's own revision.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { freshnessFindings } from "../tools/artifact_manifest.mjs";
import { evaluateServedArtifactFreshness } from "../tools/release_surface_reconciliation.mjs";

const MAIN_REVISION = "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace";
const SERVED_HASH = "21fa43eba688d2095629ec55b70c0d59d11521c751d6d6a33a9e7ece960675e8";
const REBUILD_HASH = "2ddd2888fde7f715b6029942c26caa4edc46db1ee12bdaa4a6a6bc850511153a";
const OBSERVED_AT = new Date("2026-09-02T00:34:05.000Z");

function manifest({ hash, revision = MAIN_REVISION, deploymentAt = "2026-09-02T00:20:00.000Z" }) {
  return {
    schema: "cityscroll.served-artifact-manifest.v1",
    source_commit_sha: revision,
    generated_at: deploymentAt,
    artifact_hash: hash,
    deployment_at: deploymentAt,
  };
}

const at = (live, expected) => freshnessFindings(live, expected, { now: OBSERVED_AT });

test("the cited run reproduces: a rebuild of main mismatches the served artifact it deployed", () => {
  const served = manifest({ hash: SERVED_HASH });
  const rebuilt = manifest({ hash: REBUILD_HASH });
  const result = evaluateServedArtifactFreshness({
    liveManifest: served,
    expectedManifest: rebuilt,
    freshnessFindings: at,
  });
  assert.equal(result.status, "FAIL");
  // The run's own receipt: one finding, and the served revision matched main,
  // so the served artifact was never behind. The rebuild was the wrong basis.
  assert.deepEqual(result.findings, ["artifact hash mismatch"]);
  assert.equal(result.evidence.live_source_commit_sha, MAIN_REVISION);
});

test("the same served artifact passes against the manifest its deploy published", () => {
  const deployed = manifest({ hash: SERVED_HASH });
  const result = evaluateServedArtifactFreshness({
    liveManifest: manifest({ hash: SERVED_HASH }),
    expectedManifest: deployed,
    freshnessFindings: at,
    mainRevision: MAIN_REVISION,
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.findings, []);
  assert.equal(result.evidence.deployed_artifact_hash, SERVED_HASH);
  assert.equal(result.evidence.main_source_commit_sha, MAIN_REVISION);
});

test("an artifact that matches no deploy stays nonzero and never gets a false pass", () => {
  const result = evaluateServedArtifactFreshness({
    liveManifest: manifest({ hash: "0".repeat(64) }),
    expectedManifest: manifest({ hash: SERVED_HASH }),
    freshnessFindings: at,
    mainRevision: MAIN_REVISION,
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("artifact hash mismatch"));
  assert.equal(result.evidence.live_artifact_hash, "0".repeat(64));
  assert.equal(result.evidence.deployed_artifact_hash, SERVED_HASH);
});

test("a served artifact matching an older deploy is reported as behind, with its own signature", () => {
  const behind = "b".repeat(40);
  const result = evaluateServedArtifactFreshness({
    liveManifest: manifest({ hash: SERVED_HASH, revision: behind }),
    expectedManifest: manifest({ hash: SERVED_HASH, revision: behind }),
    freshnessFindings: at,
    mainRevision: MAIN_REVISION,
  });
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.findings, [
    `deployed revision ${behind} is behind main revision ${MAIN_REVISION}`,
  ]);
  // Deploy lag and a byte mismatch are separate findings, so one broken cause
  // cannot be read from the other's alarm.
  assert.ok(!result.findings.includes("artifact hash mismatch"));
});

test("a stale deployment window still fails even when the bytes match the deploy", () => {
  const stale = manifest({ hash: SERVED_HASH, deploymentAt: "2026-08-30T00:00:00.000Z" });
  const result = evaluateServedArtifactFreshness({
    liveManifest: stale,
    expectedManifest: stale,
    freshnessFindings: at,
    mainRevision: MAIN_REVISION,
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("deployment is older than one release window"));
});

test("the freshness workflow compares against published deploy evidence and names its own run", () => {
  const workflow = readFileSync(new URL("../.github/workflows/served-artifact-freshness.yml", import.meta.url), "utf8");
  assert.match(workflow, /--expected-manifest \.deployed\/_site\/artifact-manifest\.json/);
  assert.match(workflow, /--main-revision "\$GITHUB_SHA"/);
  assert.match(workflow, /gh run download "\$DEPLOY_RUN_ID"/);
  // The rebuild basis is gone; nothing rebuilds main to compare hashes.
  assert.doesNotMatch(workflow, /uses: \.\/\.github\/actions\/build-site/);
  // The alarm carries the evidence the relay now requires.
  assert.match(workflow, /workflow:process\.env\.GITHUB_WORKFLOW/);
  assert.match(workflow, /source_revision:process\.env\.GITHUB_SHA/);
  // A failing check stays nonzero; no suppression on the freshness path.
  assert.match(workflow, /\n {10}exit 1\n/);
  assert.doesNotMatch(workflow, /\|\| true/);
});

test("the watchdog workflow sends the observing run identity with its scheduler probe", () => {
  const workflow = readFileSync(new URL("../.github/workflows/reliability-watchdogs.yml", import.meta.url), "utf8");
  assert.match(workflow, /observer_workflow=/);
  assert.match(workflow, /observer_run_url=\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID/);
  assert.match(workflow, /observer_revision=\$GITHUB_SHA/);
  assert.match(workflow, /admin\/reliability\/scheduler\?\$observer/);
});

test("the independent scheduler trigger supplies the credential its cycle needs", () => {
  const plist = readFileSync(new URL("../ops/launchd/com.cityscroll.external-schedules.plist.template", import.meta.url), "utf8");
  // launchd inherits no login shell, which is why the heartbeat write never ran.
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /CITYSCROLL_ADMIN_KEY_FILE/);
  assert.match(plist, /CROL_EXTERNAL_SCHEDULE_STATE_DIR/);
  // The credential is referenced by path, never embedded in the tracked template.
  assert.doesNotMatch(plist, /<key>CITYSCROLL_ADMIN_KEY<\/key>/);
});
