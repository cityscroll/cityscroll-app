import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

import {
  SCHEMA,
  observationFromBacklog,
  mergeEnvelope,
  main,
} from "../tools/digest_owed_drain_observation.mjs";

const BACKLOG = {
  schema: "owed-backlog.v1",
  generated_at: "2026-09-10T11:31:52.657Z",
  subscribers: [{
    subscriber_id: "subscriber:7878af20a7538ed0a03e11f6",
    owed_count: 78,
    oldest_owed_at: "2026-08-13T10:00:59.502Z",
    oldest_lens: "district",
    oldest_item_id: "district:land:2019M0059:2023-03-13",
    oldest_watch_id: "watch:prior-district-key",
    last_sent_at: "2026-09-07T13:03:01.898Z",
    last_delivery_status: "sent",
  }],
};

test("before observation keeps the opaque subscriber id and the oldest owed row", () => {
  const row = observationFromBacklog(BACKLOG, { phase: "before", drainedCount: 0 });
  assert.equal(row.phase, "before");
  assert.equal(row.subscriber_id, "subscriber:7878af20a7538ed0a03e11f6");
  assert.equal(row.owed_count, 78);
  assert.equal(row.drained_count, 0);
  assert.equal(row.oldest_owed_row.item_id, "district:land:2019M0059:2023-03-13");
  assert.equal(row.oldest_owed_row.lens, "district");
  assert.doesNotMatch(JSON.stringify(row), /@/);
});

test("after observation appends without dropping the before read", () => {
  const before = observationFromBacklog(BACKLOG, { phase: "before" });
  const after = observationFromBacklog({
    ...BACKLOG,
    generated_at: "2026-09-10T13:05:00.000Z",
    subscribers: [{ ...BACKLOG.subscribers[0], owed_count: 0 }],
  }, { phase: "after", takenAt: "2026-09-10T13:05:00.000Z", drainedCount: 78 });
  const envelope = mergeEnvelope({ schema: SCHEMA, subscriber_id: before.subscriber_id, reads: [before] }, after);
  assert.equal(envelope.schema, SCHEMA);
  assert.deepEqual(envelope.reads.map((row) => row.phase), ["before", "after"]);
  assert.equal(envelope.reads[1].owed_count, 0);
  assert.equal(envelope.reads[1].drained_count, 78);
});

test("main writes the before envelope from an admin backlog body", async () => {
  await withTempDir("owed-drain", async (dir) => {
    const path = join(dir, "district-owed-drain-read.json");
    const envelope = await main(["--phase", "before"], { backlog: BACKLOG, evidencePath: path });
    assert.equal(envelope.schema, SCHEMA);
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.reads[0].phase, "before");
    assert.equal(written.reads[0].owed_count, 78);
  });
});
