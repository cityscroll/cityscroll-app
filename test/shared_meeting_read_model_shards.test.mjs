import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SHARED_MEETING_SHARD_MAX_BYTES,
  buildSharedMeetingReadModelShardArtifacts,
  combineSharedMeetingReadModel,
  isShardedSharedMeetingReadModel,
  loadSharedMeetingReadModelDocument,
} from "../site/shared_meeting_read_model_shards.mjs";
import {
  readSharedMeetingReadModelDocument,
  writeSharedMeetingReadModelDocument,
} from "../tools/lib/shared_meeting_read_model_io.mjs";
import { PAGES_FILE_HEADROOM_BYTES } from "../tools/check_pages_bundle_sizes.mjs";

function meetingRow(id, pad = 256) {
  return {
    meeting_id: id,
    title: "x".repeat(pad),
    venue: { name: "City Hall", address: "City Hall Park" },
    schedule: { start_at: "2026-10-01T18:00:00-04:00" },
  };
}

test("a population too large for one shard is split, and an unsplittable row is refused", () => {
  const model = {
    schema: "cityscroll.shared_meeting_read_model.v1",
    version: 1,
    generated_at: "2026-10-08T00:00:00.000Z",
    counts: { total: 64 },
    rows: Array.from({ length: 64 }, (_, index) => meetingRow(`meeting:${index}`, 4096)),
    hearings: Array.from({ length: 64 }, (_, index) => meetingRow(`meeting:${index}`, 4096)),
  };
  const { manifest, shards } = buildSharedMeetingReadModelShardArtifacts(model, {
    maxShardBytes: 64 * 1024,
  });
  assert.ok(manifest.shards.length > 1, "a population past the ceiling is split across shards");
  assert.equal(manifest.row_count, model.rows.length);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "rows"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "hearings"), false);
  assert.deepEqual(manifest.shards.filter((descriptor) => descriptor.bytes > 64 * 1024), []);

  const roundTrip = combineSharedMeetingReadModel(manifest, shards);
  assert.deepEqual(roundTrip.rows, model.rows);
  assert.deepEqual(roundTrip.hearings, model.rows, "hearings is restored as the rows alias");
  assert.equal(roundTrip.schema, model.schema);
  assert.equal(roundTrip.generated_at, model.generated_at);

  assert.throws(
    () => buildSharedMeetingReadModelShardArtifacts(
      { rows: [meetingRow("meeting:huge", 50_000)] },
      { maxShardBytes: 512 },
    ),
    /above the 512-byte shard ceiling/,
    "a row larger than a whole shard fails the build with the path that cannot be split",
  );
});

test("disk write and read round-trip through the index", () => {
  const root = mkdtempSync(join(tmpdir(), "shared-meeting-shards-"));
  try {
    const indexPath = join(root, "shared_meeting_read_model.json");
    const model = {
      schema: "cityscroll.shared_meeting_read_model.v1",
      version: 1,
      generated_at: "2026-10-08T00:00:00.000Z",
      counts: { total: 8 },
      rows: Array.from({ length: 8 }, (_, index) => meetingRow(`meeting:${index}`, 2048)),
      hearings: Array.from({ length: 8 }, (_, index) => meetingRow(`meeting:${index}`, 2048)),
    };
    const artifacts = writeSharedMeetingReadModelDocument(indexPath, model, {
      maxShardBytes: 16 * 1024,
    });
    assert.ok(artifacts.manifest.shards.length > 1);
    assert.ok(isShardedSharedMeetingReadModel(JSON.parse(readFileSync(indexPath, "utf8"))));
    assert.ok(statSync(indexPath).size < 8 * 1024);

    const loaded = readSharedMeetingReadModelDocument(indexPath);
    assert.deepEqual(loaded.rows, model.rows);
    assert.deepEqual(loaded.hearings, model.rows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetch loader follows shard paths from the index URL", async () => {
  const model = {
    schema: "cityscroll.shared_meeting_read_model.v1",
    generated_at: "2026-10-08T00:00:00.000Z",
    rows: [meetingRow("meeting:a"), meetingRow("meeting:b"), meetingRow("meeting:c")],
    hearings: [meetingRow("meeting:a"), meetingRow("meeting:b"), meetingRow("meeting:c")],
  };
  const { manifest, shards } = buildSharedMeetingReadModelShardArtifacts(model, {
    maxShardBytes: 900,
  });
  assert.ok(manifest.shards.length > 1);
  const byUrl = new Map([
    ["/data/shared_meeting_read_model.json", manifest],
    ...manifest.shards.map((descriptor, index) => [
      `/data/${descriptor.path}`,
      shards[index],
    ]),
  ]);
  const loaded = await loadSharedMeetingReadModelDocument(
    "/data/shared_meeting_read_model.json",
    async (url) => byUrl.get(url) || null,
  );
  assert.deepEqual(loaded.rows.map((row) => row.meeting_id), [
    "meeting:a",
    "meeting:b",
    "meeting:c",
  ]);
  assert.equal(loaded.hearings, loaded.rows);
});

test("default shard ceiling stays under the 15 MiB structural target with headroom margin", () => {
  assert.ok(
    DEFAULT_SHARED_MEETING_SHARD_MAX_BYTES <= 12 * 1024 * 1024,
    "shard ceiling must stay at or below 12 MiB so each published part remains well under 15 MiB",
  );
  assert.ok(
    DEFAULT_SHARED_MEETING_SHARD_MAX_BYTES < PAGES_FILE_HEADROOM_BYTES,
    "shard ceiling must leave growth margin under the 18 MiB Pages refresh headroom mark",
  );
});
