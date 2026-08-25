#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { freshnessFindings, ARTIFACT_MANIFEST_SCHEMA } from "./artifact_manifest.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

export async function checkServedArtifactFreshness({ origin, expectedManifest, fetchImpl = fetch, now = new Date(), maxAgeMs } = {}) {
  const url = `${String(origin).replace(/\/$/, "")}/artifact-manifest.json`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) return { ok: false, findings: [`live manifest request returned HTTP ${response.status}`], live: null };
  let live;
  try { live = await response.json(); } catch { return { ok: false, findings: ["live manifest is not JSON"], live: null }; }
  if (live?.schema !== ARTIFACT_MANIFEST_SCHEMA) return { ok: false, findings: ["live manifest missing or invalid"], live };
  const findings = freshnessFindings(live, expectedManifest, { now, maxAgeMs });
  return { ok: findings.length === 0, findings, live };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const origin = arg("--origin", "https://cityscroll.org");
  const expectedPath = arg("--expected-manifest");
  const expected = expectedPath ? JSON.parse(await readFile(expectedPath, "utf8")) : null;
  const result = await checkServedArtifactFreshness({ origin, expectedManifest: expected });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
