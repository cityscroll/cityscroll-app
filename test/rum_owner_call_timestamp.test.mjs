import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createBufferedSemanticMilestones,
  projectProductionObservation,
} from "../site/rum_production.mjs";
import { createRumSemanticMilestones } from "../site/rum_semantic_milestones.mjs";

const MANIFEST = JSON.parse(readFileSync(
  new URL("../site/data/performance-classification-manifest.v1.json", import.meta.url),
  "utf8",
));
const RELEASE_ID = "a".repeat(40);

function recordSink() {
  const records = [];
  return { records, record(value) { records.push(structuredClone(value)); } };
}

test("buffer-then-install preserves the owner-call timestamp and readiness value", () => {
  let ownerClock = 137.5;
  const runtime = { performance: { now: () => ownerClock } };
  const buffer = createBufferedSemanticMilestones(runtime);
  const args = { surfaceId: "notice", resultState: "content" };
  assert.equal(buffer.surfaceReady(args).state, "buffered");

  const immediateSink = recordSink();
  const immediate = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => ownerClock,
    record: immediateSink.record,
  });
  assert.equal(immediate.surfaceReady(args).state, "recorded");

  ownerClock = 9_000;
  const delayedSink = recordSink();
  const delayed = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => ownerClock,
    record: delayedSink.record,
  });
  assert.equal(buffer.drain(delayed), 1);

  assert.equal(delayedSink.records[0].value, immediateSink.records[0].value);
  assert.equal(delayedSink.records[0].owner_timestamp_ms, 137.5);
  assert.equal(delayedSink.records[0].owner_timestamp_ms, immediateSink.records[0].owner_timestamp_ms);

  const projected = projectProductionObservation(delayedSink.records[0], {
    manifest: MANIFEST,
    classification: { surface_id: "notice", delivery_class: "pages_edge" },
    releaseId: RELEASE_ID,
    deviceClass: "mobile",
  });
  assert.equal(projected.owner_timestamp_ms, 137.5);
});
