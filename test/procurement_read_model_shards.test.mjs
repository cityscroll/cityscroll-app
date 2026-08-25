import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { buildCommunityBoardMeetingIndexShardArtifacts } from "../site/community_board_meeting_index_shards.mjs";
import {
  buildSharedProcurementReadModelShardArtifacts,
  combineSharedProcurementReadModel,
  SHARED_PROCUREMENT_READ_MODEL_SHARD_SCHEMA,
} from "../site/procurement_read_model_shards.mjs";
import { MAX_PAGES_FILE_BYTES } from "../tools/check_pages_bundle_sizes.mjs";
import { readCommunityBoardMeetingIndex } from "../tools/lib/community_board_meeting_index_io.mjs";

const guard = new URL("../tools/check_pages_bundle_sizes.mjs", import.meta.url);

function record(id, snapshot) {
  return {
    source_system: "checkbook_contracts",
    source_system_id: id,
    content_hash: `hash:${id}`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-20T00:00:00Z",
  };
}

test("shards retain the read-model contract and round-trip rows and observations", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: [
      record("contract:one", { id: "CTONE", title: "One", vendor: "Vendor One" }),
      record("contract:two", { id: "CTTWO", title: "Two", vendor: "Vendor Two" }),
    ],
    generatedAt: "2026-08-20T00:00:00Z",
  });
  const artifacts = buildSharedProcurementReadModelShardArtifacts(model, { maxShardBytes: 2_000 });
  const roundTrip = combineSharedProcurementReadModel(artifacts.manifest, artifacts.shards);

  assert.equal(artifacts.manifest.schema, "cityscroll.shared_procurement_read_model.v1");
  assert.equal(artifacts.manifest.version, 1);
  assert.equal(artifacts.manifest.shard_schema, SHARED_PROCUREMENT_READ_MODEL_SHARD_SCHEMA);
  assert.ok(artifacts.shards.length >= 2);
  assert.deepEqual(roundTrip.rows, model.rows);
  assert.deepEqual(roundTrip.observations, model.observations);
  assert.deepEqual(roundTrip.coherence_receipt, model.coherence_receipt);
  for (const shard of artifacts.shards) {
    assert.ok(Buffer.byteLength(`${JSON.stringify(shard, null, 2)}\n`) <= 2_000);
  }
});

test("Pages bundle guard passes the committed site and fails a planted oversized file", () => {
  const workerWorkflow = readFileSync(new URL("../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");
  assert.match(workerWorkflow, /tools\/worker_deploy_guard\.mjs/);
  assert.match(workerWorkflow, /64 MiB uncompressed budget/);
  const committed = spawnSync(process.execPath, [guard.pathname, "--site-dir", "site"], { encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);

  const root = mkdtempSync(join(tmpdir(), "cityscroll-pages-size-"));
  try {
    mkdirSync(join(root, "data"));
    const planted = join(root, "data", "too-large.json");
    writeFileSync(planted, Buffer.alloc(MAX_PAGES_FILE_BYTES + 1));
    const result = spawnSync(process.execPath, [guard.pathname, "--site-dir", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /too-large\.json/);
    assert.match(result.stderr, /24 MiB guard/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("community-board meeting index round-trips through bounded shards", () => {
  const index = readCommunityBoardMeetingIndex(new URL(
    "../site/data/community_board_meeting_index.json",
    import.meta.url,
  ));
  const artifacts = buildCommunityBoardMeetingIndexShardArtifacts(index);
  assert.equal(artifacts.manifest.schema, "cityscroll.community_board_meeting_index.v1");
  assert.equal(artifacts.manifest.shard_schema, "cityscroll.community_board_meeting_index_shard.v1");
  assert.equal(artifacts.manifest.shards.length, artifacts.shards.length);
  assert.equal(artifacts.shards.flatMap((shard) => shard.kind === "rows" ? shard.entries : []).length, index.rows.length);
  assert.ok(artifacts.shards.every((shard) => Buffer.byteLength(`${JSON.stringify(shard, null, 2)}\n`) < 16 * 1024 * 1024));
});
