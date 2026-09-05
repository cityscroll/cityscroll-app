import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactHash, freshnessFindings, writeArtifactManifest, ARTIFACT_MANIFEST_SCHEMA } from "../tools/artifact_manifest.mjs";
import { checkServedArtifactFreshness } from "../tools/check_served_artifact_freshness.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

test("artifact manifest records a stable content hash and healthy freshness", async () => {
  await withTempDir("manifest", async (dir) => {
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
});

test("artifact manifest carries the source-health receipt identity without publishing its contents", async () => {
  await withTempDir("manifest-source-receipt", async (dir) => {
    const sourceReceipt = join(dir, "source-health.json");
    await writeFile(join(dir, "index.html"), "<main>CityScroll</main>");
    await writeFile(sourceReceipt, JSON.stringify({
      schema: "cityscroll.source_health_observations.v1",
      generated_at: "2026-08-25T10:00:00.000Z",
      observations: [],
    }) + "\n");
    const manifest = await writeArtifactManifest(dir, { sourceReceiptPath: sourceReceipt });
    assert.deepEqual(manifest.source_receipt, {
      schema: "cityscroll.source_health_observations.v1",
      generated_at: "2026-08-25T10:00:00.000Z",
      sha256: "14194203e923595a522740cacbbef0e49ee407ef0b39572a01df70dce8c4c665",
    });
  });
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
