import { processEnvelope, eventId, indexProcessSpine, PROCESS_SPINE_SCHEMA_VERSION } from "../worker/src/lib/process_spine.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const source = readJson("test/fixtures/wave4/source-events.json");
const sourceToEvent = new Map(source.events.map((row) => [row.source_key, eventId(row.source_system, row.source_key)]));

const events = source.events.map((row) => processEnvelope(row, sha256(row.payload), {
  parent_event_id: row.parent_source_key ? sourceToEvent.get(row.parent_source_key) : null,
  supersedes_event_id: row.supersedes_source_key ? sourceToEvent.get(row.supersedes_source_key) : null
}));

const bundle = {
  schema_version: PROCESS_SPINE_SCHEMA_VERSION,
  snapshot_date: source.snapshot_date,
  source_snapshot_hash: sha256(source),
  coverage: {
    scope: "published Wave 4 reference matters",
    process_count: new Set(events.map((row) => row.process_id)).size,
    event_count: events.length,
    full_corpus: false
  },
  events
};
indexProcessSpine(bundle);
writeOrCheck("test/fixtures/wave4/generated/process_spine.json", bundle, check);

const unresolved = {
  schema_version: "1.0.0",
  snapshot_date: source.snapshot_date,
  candidates: events
    .filter((row) => row.join.confidence !== "confirmed")
    .map((row) => ({
      event_id: row.event_id,
      source_system: row.source_system,
      source_key: row.source_key,
      candidate_process_id: row.process_id,
      confidence: row.join.confidence,
      matched_fields: row.join.matched_fields || [],
      decision: "human_review_required"
    }))
};
writeOrCheck("test/fixtures/wave4/generated/unresolved-joins.json", unresolved, check);
