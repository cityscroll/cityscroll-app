import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

import {
  SCHEMA,
  OBSERVER_TOOL,
  observationFromBacklog,
  mergeEnvelope,
  pairVerification,
  assertOwedDrainEnvelope,
  main,
} from "../tools/digest_owed_drain_observation.mjs";
import {
  PRODUCTION_EVIDENCE_CLASS,
  PRODUCTION_PROVENANCE_SCHEMA,
} from "../tools/lib/production_provenance.mjs";

const BACKLOG = {
  schema: "owed-backlog.v1",
  generated_at: "2026-09-10T11:31:52.657Z",
  summary: { subscriber_count: 1, owed_count: 78, overdue_subscriber_count: 1 },
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

const PROVENANCE = {
  schema: PRODUCTION_PROVENANCE_SCHEMA,
  evidence_class: PRODUCTION_EVIDENCE_CLASS,
  isolated: false,
  observed_at: "2026-09-11T20:40:00.000Z",
  observer: {
    tool: OBSERVER_TOOL,
    source_revision: "233a42d95a73c0d10b49ce5e96d59f6ebf386b65",
  },
  methods: ["GET"],
  bases: ["https://api.cityscroll.org"],
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

test("after observation pins the envelope subscriber and records drained_count", async () => {
  await withTempDir("owed-drain-after", async (dir) => {
    const path = join(dir, "district-owed-drain-read.json");
    await main(["--phase", "before"], {
      backlog: BACKLOG,
      evidencePath: path,
      sourceRevision: PROVENANCE.observer.source_revision,
    });
    const later = {
      ...BACKLOG,
      generated_at: "2026-09-11T20:40:00.000Z",
      summary: { subscriber_count: 2, owed_count: 3, overdue_subscriber_count: 1 },
      subscribers: [
        {
          subscriber_id: "subscriber:other-district",
          owed_count: 3,
          oldest_owed_at: "2026-07-01T00:00:00.000Z",
          oldest_lens: "district",
          oldest_item_id: "district:land:other",
          last_sent_at: "2026-09-11T13:04:54.799Z",
          last_delivery_status: "sent",
        },
        {
          ...BACKLOG.subscribers[0],
          owed_count: 0,
          last_sent_at: "2026-09-11T13:04:54.799Z",
        },
      ],
    };
    const envelope = await main(["--phase", "after"], {
      backlog: later,
      evidencePath: path,
      takenAt: "2026-09-11T20:40:00.000Z",
      sourceRevision: PROVENANCE.observer.source_revision,
      health: { commit: "88df5a1a74dced739540763eea0f811cd798d7ee", environment: "production" },
    });
    assert.deepEqual(envelope.reads.map((row) => row.phase), ["before", "after"]);
    assert.equal(envelope.subscriber_id, "subscriber:7878af20a7538ed0a03e11f6");
    assert.equal(envelope.reads[1].subscriber_id, "subscriber:7878af20a7538ed0a03e11f6");
    assert.equal(envelope.reads[1].owed_count, 0);
    assert.equal(envelope.reads[1].drained_count, 78);
    assert.equal(envelope.provenance.schema, PRODUCTION_PROVENANCE_SCHEMA);
    assert.equal(envelope.provenance.isolated, false);
    assert.equal(envelope.provenance.observer.source_revision, PROVENANCE.observer.source_revision);
    assert.equal(envelope.verification.owed_count_fell, true);
    assert.equal(envelope.verification.owed_drained_nonzero, true);
    assert.equal(envelope.verification.backlog_did_not_grow, true);
  });
});

test("after observation keeps a zero drain when owed_count does not fall and the backlog does not grow", async () => {
  await withTempDir("owed-drain-unchanged", async (dir) => {
    const path = join(dir, "district-owed-drain-read.json");
    await main(["--phase", "before"], {
      backlog: BACKLOG,
      evidencePath: path,
      sourceRevision: PROVENANCE.observer.source_revision,
    });
    const later = {
      ...BACKLOG,
      generated_at: "2026-09-11T20:40:00.000Z",
      subscribers: [{
        ...BACKLOG.subscribers[0],
        oldest_watch_id: "watch:8e67765e3a9423e7e0126c2f",
        last_sent_at: "2026-09-11T13:04:54.799Z",
      }],
    };
    const envelope = await main(["--phase", "after"], {
      backlog: later,
      evidencePath: path,
      takenAt: "2026-09-11T20:40:00.000Z",
      sourceRevision: PROVENANCE.observer.source_revision,
      health: { commit: "88df5a1a74dced739540763eea0f811cd798d7ee", environment: "production" },
    });
    assert.equal(envelope.reads[1].owed_count, 78);
    assert.equal(envelope.reads[1].drained_count, 0);
    assert.equal(envelope.verification.owed_count_fell, false);
    assert.equal(envelope.verification.owed_drained_nonzero, false);
    assert.equal(envelope.verification.backlog_did_not_grow, true);
    assert.equal(envelope.verification.last_sent_advanced, true);
    assertOwedDrainEnvelope(envelope, { requireAfter: true });
    const checked = await main(["--check"], { evidencePath: path });
    assert.equal(checked.reads.length, 2);
  });
});

test("pair verification treats a missing after read as not yet observed", () => {
  const before = observationFromBacklog(BACKLOG, { phase: "before" });
  const verification = pairVerification({ schema: SCHEMA, subscriber_id: before.subscriber_id, reads: [before] });
  assert.equal(verification.owed_count_fell, false);
  assert.equal(verification.backlog_did_not_grow, false);
});

test("the committed district owed-drain evidence keeps the before/after pair and provenance", async () => {
  const envelope = await main(["--check"]);
  assert.equal(envelope.schema, SCHEMA);
  assert.deepEqual(envelope.reads.map((row) => row.phase), ["before", "after"]);
  assert.equal(envelope.reads[0].owed_count, 78);
  assert.equal(envelope.verification.backlog_did_not_grow, true);
  assert.equal(envelope.provenance.schema, PRODUCTION_PROVENANCE_SCHEMA);
  assert.equal(envelope.provenance.isolated, false);
  assert.equal(envelope.provenance.observer.source_revision, "233a42d95a73c0d10b49ce5e96d59f6ebf386b65");
  assert.doesNotMatch(JSON.stringify(envelope), /@/);
});
