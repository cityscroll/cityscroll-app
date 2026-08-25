/** Bounded manifest/shards for the source-native community-board meeting index. */

export const COMMUNITY_BOARD_MEETING_INDEX_SHARD_SCHEMA = "cityscroll.community_board_meeting_index_shard.v1";
export const DEFAULT_COMMUNITY_BOARD_SHARD_MAX_BYTES = 16 * 1024 * 1024;

function byteLength(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function shardPath(index) {
  return `community_board_meeting_index/shard-${String(index).padStart(3, "0")}.json`;
}

function shardPayload(shardId, kind, entries) {
  return { schema: COMMUNITY_BOARD_MEETING_INDEX_SHARD_SCHEMA, version: 1, shard_id: shardId, kind, entries };
}

function splitEntries(kind, entries, maxBytes) {
  const chunks = [];
  let current = [];
  let estimated = byteLength(shardPayload("candidate", kind, []));
  for (const entry of entries) {
    const itemBytes = byteLength(shardPayload("candidate", kind, [entry]));
    if (current.length && estimated + itemBytes > maxBytes) {
      chunks.push(current);
      current = [];
      estimated = byteLength(shardPayload("candidate", kind, []));
    }
    current.push(entry);
    estimated += itemBytes;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return chunks;
}

export function buildCommunityBoardMeetingIndexShardArtifacts(
  index,
  { maxShardBytes = DEFAULT_COMMUNITY_BOARD_SHARD_MAX_BYTES } = {},
) {
  const fields = [
    ["source_records_by_board", Object.entries(index?.source_records_by_board || {})],
    ["meeting_documents", Array.isArray(index?.meeting_documents) ? index.meeting_documents : []],
    ["by_board", Object.entries(index?.by_board || {})],
    ["rows", Array.isArray(index?.rows) ? index.rows : []],
  ];
  const shards = [];
  const descriptors = [];
  for (const [kind, entries] of fields) {
    for (const chunk of splitEntries(kind, entries, maxShardBytes)) {
      const shard = shardPayload(String(shards.length).padStart(3, "0"), kind, chunk);
      shards.push(shard);
      descriptors.push({
        path: shardPath(shards.length - 1),
        kind,
        bytes: byteLength(shard),
        entry_count: chunk.length,
      });
    }
  }
  const {
    source_records_by_board: _sourceRecords,
    meeting_documents: _meetingDocuments,
    by_board: _byBoard,
    rows: _rows,
    ...manifestBody
  } = index || {};
  return {
    manifest: {
      ...manifestBody,
      representation: "sharded",
      shard_schema: COMMUNITY_BOARD_MEETING_INDEX_SHARD_SCHEMA,
      shards: descriptors,
    },
    shards,
  };
}

export function combineCommunityBoardMeetingIndex(manifest, shards = []) {
  if (Array.isArray(manifest?.rows) && manifest?.by_board) return manifest;
  const sourceRecords = {};
  const byBoard = {};
  const meetingDocuments = [];
  const rows = [];
  for (const shard of Array.isArray(shards) ? shards : []) {
    const entries = Array.isArray(shard?.entries) ? shard.entries : [];
    if (shard.kind === "source_records_by_board") Object.assign(sourceRecords, Object.fromEntries(entries));
    else if (shard.kind === "by_board") Object.assign(byBoard, Object.fromEntries(entries));
    else if (shard.kind === "meeting_documents") meetingDocuments.push(...entries);
    else if (shard.kind === "rows") rows.push(...entries);
  }
  const {
    representation: _representation,
    shard_schema: _shardSchema,
    shards: _shards,
    ...body
  } = manifest || {};
  return {
    ...body,
    source_records_by_board: sourceRecords,
    meeting_documents: meetingDocuments,
    by_board: byBoard,
    rows,
  };
}
