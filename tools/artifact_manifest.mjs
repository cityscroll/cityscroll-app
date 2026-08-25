#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const ARTIFACT_MANIFEST = "artifact-manifest.json";
export const ARTIFACT_MANIFEST_SCHEMA = "cityscroll.served-artifact-manifest.v1";

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile() && relative(root, path) !== ARTIFACT_MANIFEST) files.push(path);
  }
  return files.sort();
}

export async function artifactHash(siteDir) {
  const root = resolve(siteDir);
  const hash = createHash("sha256");
  for (const path of await filesUnder(root)) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function writeArtifactManifest(siteDir, {
  sourceCommitSha = process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || null,
  generatedAt = new Date().toISOString(),
  deploymentAt = new Date().toISOString(),
} = {}) {
  const manifest = {
    schema: ARTIFACT_MANIFEST_SCHEMA,
    source_commit_sha: sourceCommitSha || null,
    generated_at: generatedAt,
    artifact_hash: await artifactHash(siteDir),
    deployment_at: deploymentAt,
  };
  await writeFile(join(siteDir, ARTIFACT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function freshnessFindings(live, expected, { now = new Date(), maxAgeMs = 26 * 60 * 60 * 1000 } = {}) {
  const findings = [];
  if (!live || live.schema !== ARTIFACT_MANIFEST_SCHEMA) findings.push("live manifest missing or invalid");
  if (expected && live?.artifact_hash !== expected.artifact_hash) findings.push("artifact hash mismatch");
  if (expected && live?.source_commit_sha !== expected.source_commit_sha) findings.push("source commit mismatch");
  const deploymentMs = Date.parse(live?.deployment_at || "");
  if (!Number.isFinite(deploymentMs)) findings.push("deployment timestamp missing or invalid");
  else if (now.getTime() - deploymentMs > maxAgeMs) findings.push("deployment is older than one release window");
  if (deploymentMs > now.getTime() + 5 * 60 * 1000) findings.push("deployment timestamp is in the future");
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const value = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] || fallback : fallback;
  };
  const siteDir = value("--site-dir", "_site");
  const manifest = await writeArtifactManifest(siteDir, {
    sourceCommitSha: value("--source-commit") || undefined,
    deploymentAt: value("--deployment-at") || undefined,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
