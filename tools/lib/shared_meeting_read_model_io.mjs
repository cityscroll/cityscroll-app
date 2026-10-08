/**
 * Read and write the shared meeting catalog through its index, so build-time
 * and test consumers never have to know whether the population is sharded.
 * Shard paths resolve against the index's own directory — the same relation
 * the browser and Pages edge use.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSharedMeetingReadModelShardArtifacts,
  combineSharedMeetingReadModel,
  isShardedSharedMeetingReadModel,
  sharedMeetingReadModelShardPaths,
  SHARED_MEETING_READ_MODEL_SHARD_DIRECTORY,
} from "../../site/shared_meeting_read_model_shards.mjs";

function resolvePath(path) {
  return path instanceof URL ? fileURLToPath(path) : String(path);
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readSharedMeetingReadModelDocument(path) {
  const filePath = resolvePath(path);
  const manifest = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isShardedSharedMeetingReadModel(manifest)) {
    return combineSharedMeetingReadModel(manifest);
  }
  const directory = dirname(filePath);
  const shards = sharedMeetingReadModelShardPaths(manifest)
    .map((shardPath) => JSON.parse(readFileSync(join(directory, shardPath), "utf8")));
  return combineSharedMeetingReadModel(manifest, shards);
}

/**
 * Write the catalog as an index plus bounded row shards beside it. Removes
 * leftover shard files that the new index no longer names. Callers that need
 * atomic activation may pass `writeFile` (path, contents).
 */
export function writeSharedMeetingReadModelDocument(path, model, options = {}) {
  const {
    writeFile = writeFileSync,
    mkdir = mkdirSync,
    remove = rmSync,
    listDir = readdirSync,
    pathExists = existsSync,
    ...shardOptions
  } = options;
  const filePath = resolvePath(path);
  const artifacts = buildSharedMeetingReadModelShardArtifacts(model, shardOptions);
  const directory = dirname(filePath);
  const shardDir = join(directory, SHARED_MEETING_READ_MODEL_SHARD_DIRECTORY);
  mkdir(shardDir, { recursive: true });

  const expectedNames = new Set(
    artifacts.manifest.shards.map((descriptor) => descriptor.path.split("/").at(-1)),
  );
  if (pathExists(shardDir)) {
    for (const name of listDir(shardDir)) {
      if (!expectedNames.has(name)) remove(join(shardDir, name), { force: true });
    }
  }

  writeFile(filePath, serialize(artifacts.manifest));
  for (let index = 0; index < artifacts.shards.length; index += 1) {
    const descriptor = artifacts.manifest.shards[index];
    writeFile(join(directory, descriptor.path), serialize(artifacts.shards[index]));
  }
  return artifacts;
}

/** Output pairs for builders that emit [[path, body], ...] groups. */
export function sharedMeetingReadModelOutputPairs(indexPath, model, options = {}) {
  const filePath = resolvePath(indexPath);
  const artifacts = buildSharedMeetingReadModelShardArtifacts(model, options);
  const directory = dirname(filePath);
  return {
    artifacts,
    outputs: [
      [filePath, serialize(artifacts.manifest)],
      ...artifacts.manifest.shards.map((descriptor, index) => [
        join(directory, descriptor.path),
        serialize(artifacts.shards[index]),
      ]),
    ],
  };
}
