import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactHash, freshnessFindings, writeArtifactManifest, ARTIFACT_MANIFEST_SCHEMA } from "../tools/artifact_manifest.mjs";
import { checkServedArtifactFreshness } from "../tools/check_served_artifact_freshness.mjs";

test("artifact manifest records a stable content hash and healthy freshness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cityscroll-manifest-"));
  await writeFile(join(dir, "index.html"), "<main>CityScroll</main>");
  const manifest = await writeArtifactManifest(dir, {
    sourceCommitSha: "a".repeat(40),
    generatedAt: "2026-08-25T10:00:00.000Z",
    deploymentAt: "2026-08-25T10:05:00.000Z",
  });
  assert.equal(manifest.schema, ARTIFACT_MANIFEST_SCHEMA);
  assert.equal(manifest.artifact_hash, await artifactHash(dir));
  assert.deepEqual(freshnessFindings(manifest, manifest, { now: new Date("2026-08-25T11:00:00Z") }), []);
});

test("freshness watchdog fires on a planted stale and mismatched manifest", () => {
  const live = {
    schema: ARTIFACT_MANIFEST_SCHEMA,
    source_commit_sha: "old",
    artifact_hash: "old-hash",
    deployment_at: "2026-08-20T00:00:00Z",
  };
  const expected = { source_commit_sha: "new", artifact_hash: "new-hash" };
  const findings = freshnessFindings(live, expected, { now: new Date("2026-08-25T12:00:00Z") });
  assert.deepEqual(findings, ["artifact hash mismatch", "source commit mismatch", "deployment is older than one release window"]);
});

test("freshness probe fires against a stale live origin", async () => {
  const result = await checkServedArtifactFreshness({
    origin: "https://cityscroll.org",
    expectedManifest: { source_commit_sha: "new", artifact_hash: "new-hash" },
    now: new Date("2026-08-25T12:00:00Z"),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        schema: ARTIFACT_MANIFEST_SCHEMA,
        source_commit_sha: "old",
        artifact_hash: "old-hash",
        deployment_at: "2026-08-20T00:00:00Z",
      }),
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("; "), /mismatch|older than one release window/);
});
