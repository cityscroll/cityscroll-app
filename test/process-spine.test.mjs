import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexProcessSpine, processEnvelope } from "../worker/src/lib/process_spine.mjs";

const spine = JSON.parse(readFileSync(new URL("../data/process_spine.json", import.meta.url)));
const unresolved = JSON.parse(readFileSync(new URL("../data/unresolved-joins.json", import.meta.url)));
const gaps = JSON.parse(readFileSync(new URL("../data/ocds-gap-table.json", import.meta.url)));

test("canonical events round-trip through their native source key", () => {
  const { byProcess, bySource } = indexProcessSpine(spine);
  assert.equal(byProcess.size, spine.coverage.process_count);
  for (const event of spine.events) assert.equal(bySource.get(event.source_key), event);
});

test("event envelope keeps the complete narrow-waist contract", () => {
  for (const event of spine.events) {
    assert.match(event.process_id, /^process:/);
    assert.match(event.project_id, /^project:/);
    assert.match(event.content_hash, /^[a-f0-9]{64}$/);
    assert.ok(Object.hasOwn(event, "parent_event_id"));
    assert.ok(Object.hasOwn(event, "supersedes_event_id"));
    assert.ok(Object.hasOwn(event, "amount"));
  }
});

test("NYSCR metadata candidates cannot silently become confirmed joins", () => {
  assert.equal(unresolved.candidates.length, 1);
  assert.equal(unresolved.candidates[0].decision, "human_review_required");
  const candidate = spine.events.find((event) => event.source_system === "nyscr");
  assert.throws(
    () => processEnvelope(
      {...candidate, process_key: "x", project_key: "y", join: {method: "candidate_metadata", confidence: "confirmed"}},
      "0".repeat(64)
    ),
    /human review/
  );
});

test("OCDS gap table names all five lifecycle stages and every missing reason", () => {
  assert.deepEqual(gaps.stages.map((row) => row.stage), ["planning", "tender", "award", "contract", "implementation"]);
  for (const stage of gaps.stages) {
    if (stage.missing_fields.length) assert.ok(stage.missing_reason);
  }
  assert.equal(gaps.coverage.full_corpus, false);
});
