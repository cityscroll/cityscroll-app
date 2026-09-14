import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, "docs/evidence/council-native-launch/event-22691-resident-surface-readback.json");
const IDS = ["meetings", "search", "now", "canonical-detail", "ics", "watch-preview"];

test("retained Council resident-surface read-back covers all six surfaces", async () => {
  const envelope = JSON.parse(await readFile(FILE, "utf8"));
  assert.equal(envelope.schema, "cityscroll.resident_surface_presence_readback.v1");
  assert.deepEqual(envelope.proceeding, {
    event_day: "2026-09-23",
    event_id: "22691",
    meeting_id: "meeting:nyc_legistar_events:22691",
  });
  assert.match(envelope.revisions.code, /^[0-9a-f]{40}$/);
  assert.match(envelope.revisions.data, /^[0-9a-f]{64}$/);
  assert.deepEqual(envelope.surfaces.map((entry) => entry.id), IDS);
  for (const entry of envelope.surfaces) {
    assert.equal(typeof entry.found, "boolean");
    assert.ok(!Number.isNaN(Date.parse(entry.read_at)));
    assert.match(entry.url, /^https:\/\//);
    assert.equal(entry.revisions.code, envelope.revisions.code);
    assert.equal(entry.revisions.data, envelope.revisions.data);
    if (entry.measurement_state === "measured") assert.ok(entry.seen?.excerpt.length <= 600);
    if (entry.measurement_state === "not_measured") assert.ok(entry.not_measured_reason);
  }
});
