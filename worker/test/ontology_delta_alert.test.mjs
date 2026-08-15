import assert from "node:assert/strict";
import test from "node:test";

import {
  ONTOLOGY_DELTA_EVENT_SCHEMA,
  buildOntologyDeltaCandidates,
  reconcileOntologyDeltaCandidates,
} from "../src/lib/ontology_delta_alert.mjs";

const PREVIOUS = {
  as_of: "2026-08-01T00:00:00.000Z",
  root_kinds: ["agency"],
  edge_types: ["issued_rule"],
};

const CURRENT = {
  generated_at: "2026-08-15T10:00:00.000Z",
  by_ref: {
    "agency:id:buildings": {
      root: { kind: "agency" },
      links: [{ type: "issued_rule" }, { type: "paid_to_vendor" }],
    },
    "vendor:stem:acme": {
      root: { kind: "vendor" },
      links: [{ type: "paid_to_vendor" }],
    },
  },
};

test("ontology inventory additions become stable OLD STATE to NEW STATE semantic events", () => {
  const first = buildOntologyDeltaCandidates({ previous: PREVIOUS, current: CURRENT });
  const rerun = buildOntologyDeltaCandidates({
    previous: PREVIOUS,
    current: { ...CURRENT, generated_at: "2026-08-16T10:00:00.000Z" },
  });

  assert.deepEqual(first.map((event) => [event.dimension, event.value]), [
    ["edge_type", "paid_to_vendor"],
    ["entity_type", "vendor"],
  ]);
  assert.ok(first.every((event) => event.schema === ONTOLOGY_DELTA_EVENT_SCHEMA));
  assert.ok(first.every((event) => event.event_type === "ontology_delta"));
  assert.ok(first.every((event) => event.old_state.present === false));
  assert.ok(first.every((event) => event.new_state.present === true));
  assert.ok(first.every((event) => event.shadow_only === true));
  assert.deepEqual(
    rerun.map((event) => event.transition_key),
    first.map((event) => event.transition_key),
    "observation timestamps must not change transition identity",
  );
});

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE")) {
                const [key, eventType, dimension, value, firstObservedAt, lastObservedAt, eventJson] = args;
                if (rows.has(key)) return { meta: { changes: 0 } };
                rows.set(key, {
                  transition_key: key,
                  event_type: eventType,
                  dimension,
                  value,
                  first_observed_at: firstObservedAt,
                  last_observed_at: lastObservedAt,
                  observation_count: 1,
                  event_json: eventJson,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE ontology_delta_shadow_events")) {
                const [lastObservedAt, eventJson, key] = args;
                const row = rows.get(key);
                row.last_observed_at = lastObservedAt;
                row.observation_count += 1;
                row.event_json = eventJson;
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test("shadow reconciliation emits each transition once and records digest-compatible receipts", async () => {
  const db = memoryDb();
  const candidates = buildOntologyDeltaCandidates({ previous: PREVIOUS, current: CURRENT });

  const first = await reconcileOntologyDeltaCandidates(db, candidates, {
    observedAt: "2026-08-15T10:00:00.000Z",
  });
  const second = await reconcileOntologyDeltaCandidates(db, candidates, {
    observedAt: "2026-08-16T10:00:00.000Z",
  });

  assert.equal(first.emitted.length, 2);
  assert.equal(second.emitted.length, 0);
  assert.deepEqual(first.receipts.map((receipt) => receipt.action), [
    "shadow_candidate",
    "shadow_candidate",
  ]);
  assert.deepEqual(second.receipts.map((receipt) => receipt.action), [
    "deduplicated",
    "deduplicated",
  ]);
  for (const receipt of [...first.receipts, ...second.receipts]) {
    assert.equal(receipt.kind, "semantic_event");
    assert.equal(receipt.lens, "ontology");
    assert.equal(receipt.sent, false);
    assert.equal(receipt.error, null);
    assert.equal(receipt.zeroMatch, false);
  }
  assert.equal(db.rows.size, 2);
  assert.ok([...db.rows.values()].every((row) => row.observation_count === 2));
});
