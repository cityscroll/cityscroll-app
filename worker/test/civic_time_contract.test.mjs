/**
 * Characterization: civic-time event contract.
 * verify: node --test worker/test/civic_time_contract.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  EVENT_KIND_REGISTRY,
  clockTable,
  isRegisteredEventKind,
  listEventKinds,
  makeEventId,
  mapCivicEvent,
  mapFixtureDoc,
  publicDiff,
  semanticDiff,
} from "../src/lib/civic_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = join(ROOT, "worker/test/fixtures/civic-time");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

const LENS_FIXTURES = {
  money: "money_award.json",
  rules: "rules_comment_open.json",
  land: "land_zap_milestone.json",
  meetings: "meetings_council.json",
};

test("event-kind registry is bounded and covers the four lenses", () => {
  const lenses = new Set(Object.values(EVENT_KIND_REGISTRY).map((m) => m.lens));
  assert.deepEqual([...lenses].sort(), ["land", "meetings", "money", "rules"]);
  assert.equal(isRegisteredEventKind("rules.comment_close"), true);
  assert.equal(isRegisteredEventKind("procurement.award_and_amendment"), false);
  assert.ok(listEventKinds("rules").every((k) => k.lens === "rules"));
});

test("four lens fixtures map with explicit clock labels and null unknowns", () => {
  for (const [lens, file] of Object.entries(LENS_FIXTURES)) {
    const doc = loadFixture(file);
    assert.equal(doc.lens, lens);
    const events = mapFixtureDoc(doc);
    assert.ok(events.length >= 1, `${lens} should emit events`);
    for (const event of events) {
      assert.equal(event.schema_version, 1);
      assert.ok(isRegisteredEventKind(event.event_kind));
      assert.match(event.event_id, /^cte:[a-f0-9]{24}$/);
      assert.match(event.payload_hash, /^[a-f0-9]{64}$/);
      // Clocks are always named (null when unknown) — never omitted.
      for (const clock of ["valid_at", "valid_from", "valid_to", "published_at", "observed_at", "processed_at"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(event, clock), `${lens} missing ${clock}`);
      }
    }
    // Fixture-level clock annotations when present
    for (const assertion of doc.assertions) {
      if (assertion.clocks) {
        const table = clockTable(assertion);
        for (const row of table) {
          assert.ok(
            ["valid", "publication", "observation", "processing"].includes(row.clock),
            `bad clock ${row.clock} on ${lens}`,
          );
        }
      }
    }
  }
});

test("mapper refuses unknown event kinds and does not invent publication from processing", () => {
  assert.throws(
    () =>
      mapCivicEvent({
        event_kind: "procurement.mystery_stage",
        subject_ref: "notice:1",
        source_record_ref: "x",
        source_revision: "r1",
        valid_at: "2026-01-01",
      }),
    /unknown event_kind/,
  );

  // Explicit processing without publication stays null publication.
  const env = mapCivicEvent({
    event_kind: "procurement.award_registered",
    subject_ref: "contract:CT1",
    source_record_ref: "checkbook:CT1",
    source_revision: "rev-a",
    valid_at: "2024-08-01",
    published_at: null,
    observed_at: "2024-08-02T00:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(env.published_at, null);
  assert.equal(env.processed_at, "2026-08-01T12:00:00.000Z");
  assert.equal(env.valid_at, "2024-08-01");
});

test("same source revision maps twice with byte-stable event_id and payload_hash", () => {
  const doc = loadFixture("rules_comment_open.json");
  const a = mapFixtureDoc(doc, { run_id: "run-a" });
  const b = mapFixtureDoc(doc, { run_id: "run-b" });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].event_id, b[i].event_id);
    assert.equal(a[i].payload_hash, b[i].payload_hash);
    // run_id may differ; identity does not depend on it
    assert.equal(a[i].source_revision, b[i].source_revision);
  }
  const again = makeEventId({
    subject_ref: a[0].subject_ref,
    event_kind: a[0].event_kind,
    source_revision: a[0].source_revision,
  });
  assert.equal(again, a[0].event_id);
});

test("revised source revision supersedes prior comment_close without silent overwrite", () => {
  const baseline = mapFixtureDoc(loadFixture("rules_comment_open.json"));
  const revisedDoc = loadFixture("rules_comment_revised.json");
  // Wire supersedes to the baseline comment_close event id.
  const priorComment = baseline.find((e) => e.event_kind === "rules.comment_close");
  assert.ok(priorComment);
  const assertions = revisedDoc.assertions.map((a) => {
    if (a.event_kind === "rules.comment_close") {
      return { ...a, supersedes_event_id: priorComment.event_id };
    }
    return a;
  });
  const revised = mapFixtureDoc({ ...revisedDoc, assertions });
  const diff = publicDiff(semanticDiff(baseline, revised));

  assert.equal(diff.counts.superseded, 1);
  assert.equal(diff.superseded[0].previous.event_kind, "rules.comment_close");
  assert.equal(diff.superseded[0].current.event_kind, "rules.comment_close");
  assert.notEqual(diff.superseded[0].previous.event_id, diff.superseded[0].current.event_id);
  assert.equal(diff.superseded[0].current.supersedes_event_id, priorComment.event_id);
  assert.equal(diff.superseded[0].current.valid_at, "2026-09-22");
  assert.equal(diff.superseded[0].previous.valid_at, "2026-09-15");
  // Unchanged proposal + hearing remain current
  assert.ok(diff.counts.unchanged >= 2);
  // History is additive: both event ids exist across the two runs
  assert.ok(baseline.some((e) => e.event_id === priorComment.event_id));
  assert.ok(revised.some((e) => e.event_id === diff.superseded[0].current.event_id));
});

test("empty previous run reports all current events as added", () => {
  const money = mapFixtureDoc(loadFixture("money_award.json"));
  const diff = publicDiff(semanticDiff([], money));
  assert.equal(diff.counts.added, money.length);
  assert.equal(diff.counts.unchanged, 0);
  assert.equal(diff.counts.superseded, 0);
});

test("fixture corpus is complete for the four lenses", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("expected"));
  for (const name of Object.values(LENS_FIXTURES)) {
    assert.ok(files.includes(name), `missing fixture ${name}`);
  }
});
