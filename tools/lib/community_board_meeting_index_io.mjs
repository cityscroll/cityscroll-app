import { readFileSync } from "node:fs";

import { combineCommunityBoardMeetingIndex } from "../../site/community_board_meeting_index_shards.mjs";

export function readCommunityBoardMeetingIndex(pathOrUrl) {
  const manifest = JSON.parse(readFileSync(pathOrUrl, "utf8"));
  if (!Array.isArray(manifest?.shards)) return manifest;
  const shards = manifest.shards.map((descriptor) => JSON.parse(readFileSync(
    new URL(`../../site/data/${descriptor.path}`, import.meta.url),
    "utf8",
  )));
  return combineCommunityBoardMeetingIndex(manifest, shards);
}
