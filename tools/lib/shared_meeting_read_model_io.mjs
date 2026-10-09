/**
 * Read the shared meeting catalog through its index, so build-time and test
 * consumers never have to know whether the population is sharded. Shard paths
 * resolve against the index's own directory — the same relation the browser
 * and Pages edge use. Writers emit [[path, body], ...] pairs via
 * sharedMeetingReadModelOutputPairs and persist through their own build
 * boundary; this module stays read-only for check-mode determinism.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSharedMeetingReadModelShardArtifacts,
  combineSharedMeetingReadModel,
  isShardedSharedMeetingReadModel,
  sharedMeetingReadModelShardPaths,
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
