/**
 * Digest receipt for a generator whose --check must not repeat its own build.
 *
 * A generator that emits large derived JSON pays for its work twice under the
 * derived-JSON build boundary: once to write the artifacts and once again for
 * the --check that proves they are current. This receipt records what a build
 * emitted, together with the inputs and the generator source it emitted them
 * from, so the following --check can make the same assertion from digests.
 *
 * The receipt is only allowed to stand in for a rebuild when the inputs and the
 * generator source are unchanged. Anything else — a missing receipt, a
 * different generator revision, different inputs — returns null so the caller
 * falls back to a full build-and-compare and the failure semantics are
 * unchanged.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const GENERATED_ARTIFACT_CHECK_RECEIPT_SCHEMA =
  "cityscroll.generated_artifact_check_receipt.v1";

const SHARD_FILE = /^shard-\d+\.json$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shardNamesOnDisk(dir) {
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SHARD_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    : [];
}

/**
 * @param {object} options
 * @param {string} options.generator repo-relative path of the generator
 * @param {string|null} options.generatedAt vintage of the emitted model
 * @param {number} options.rowCount object count the build reported
 * @param {string} options.generatorFingerprint fingerprint of the generator source graph
 * @param {Record<string,string>} options.inputs repo-relative input path to sha256
 * @param {Array<{artifactLabel:string, shardLabel:string|null, shardDir:string|null,
 *   expectedNames:Iterable<string>|null, outputs:Array<[string,string]>}>} options.groups
 *   emitted families as repo-relative path and serialized content
 */
export function buildCheckReceipt({
  generator,
  generatedAt = null,
  rowCount = null,
  generatorFingerprint,
  inputs,
  groups,
}) {
  return {
    schema: GENERATED_ARTIFACT_CHECK_RECEIPT_SCHEMA,
    generator,
    generated_at: generatedAt,
    row_count: rowCount,
    generator_fingerprint: generatorFingerprint,
    inputs: { ...inputs },
    outputs: groups.flatMap((group) => group.outputs.map(([path, content]) => ({
      path,
      label: group.artifactLabel,
      sha256: sha256(content),
    }))),
    shard_dirs: groups.filter((group) => group.shardDir).map((group) => ({
      path: group.shardDir,
      label: group.shardLabel,
      names: [...group.expectedNames].sort(),
    })),
  };
}

function usable(receipt, { generator, generatorFingerprint, inputs }) {
  if (receipt?.schema !== GENERATED_ARTIFACT_CHECK_RECEIPT_SCHEMA) return false;
  if (receipt.generator !== generator) return false;
  if (!Array.isArray(receipt.outputs)) return false;
  if (receipt.generator_fingerprint !== generatorFingerprint) return false;
  const recorded = receipt.inputs && typeof receipt.inputs === "object" ? receipt.inputs : {};
  const paths = Object.keys(inputs);
  if (paths.length !== Object.keys(recorded).length) return false;
  return paths.every((path) => recorded[path] === inputs[path]);
}

/**
 * Verify emitted artifacts against a receipt.
 *
 * @returns {{current: boolean, rowCount: number|null, stale: string[]}|null}
 *   null when the receipt cannot stand in for a rebuild.
 */
export function verifyFromCheckReceipt({
  receipt,
  root,
  generator,
  generatorFingerprint,
  inputs,
}) {
  if (!usable(receipt, { generator, generatorFingerprint, inputs })) return null;
  const stale = [];
  for (const output of receipt.outputs) {
    const path = join(root, output.path);
    let actual = null;
    try {
      actual = sha256(readFileSync(path));
    } catch {
      // A missing artifact is stale, exactly as a rebuild comparison would find.
    }
    if (actual !== output.sha256) stale.push(`${output.label}: ${path}`);
  }
  for (const dir of receipt.shard_dirs || []) {
    const dirPath = join(root, dir.path);
    const expected = new Set(dir.names || []);
    for (const name of shardNamesOnDisk(dirPath)) {
      if (!expected.has(name)) stale.push(`${dir.label}: ${join(dirPath, name)}`);
    }
  }
  return { current: stale.length === 0, rowCount: receipt.row_count ?? null, stale };
}
