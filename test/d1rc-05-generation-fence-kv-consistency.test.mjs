import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  D1_GENERATION_FENCE_SCHEMA,
  checkGenerationCommit,
  claimGeneration,
  completeGeneration,
  createFileLedger,
  createMemoryLedger,
  createWranglerKvStore,
  renewGeneration,
} from "../tools/d1_generation_fence.mjs";

const FINGERPRINT = "e".repeat(64);
const HOLDER = "Deploy worker:1:1";
const OTHER_HOLDER = "Deploy worker:2:1";
const KEY = "d1-publication:state:v1";
const LEASE_MS = 600_000;
const WATERMARKS = {
  entity_intelligence: { __model__: "2026-09-01T00:00:00Z" },
  keyword_search: { alpha: "2026-09-01T00:00:00Z" },
  ocp_awards: { __model__: "2026-09-01T00:00:00Z" },
};

/**
 * A Workers KV stand-in. A put is accepted immediately but only becomes readable
 * after `lagReads` further reads, which is the shape of the eventual consistency
 * that broke the deploy: a read taken moments after a put still returns the value
 * the put replaced.
 */
function createLaggingKv({ lagReads = 3 } = {}) {
  const visible = new Map();
  const pending = [];
  let reads = 0;
  return {
    get reads() { return reads; },
    write(key, value) { pending.push({ key, value, readsLeft: lagReads }); },
    read(key) {
      reads += 1;
      for (const entry of pending) entry.readsLeft -= 1;
      while (pending.length > 0 && pending[0].readsLeft <= 0) {
        const entry = pending.shift();
        visible.set(entry.key, entry.value);
      }
      return visible.get(key) ?? "";
    },
  };
}

/** Drives the real Wrangler adapter against the fixture above. */
function laggingWranglerStore(kv, overrides = {}) {
  return createWranglerKvStore({
    key: KEY,
    readAfterWriteMs: 90_000,
    readAfterWritePollMs: 3_000,
    sleep: async () => {},
    run: async (args) => {
      const [, , command, key, value] = args;
      if (command === "get") return { stdout: kv.read(key) };
      if (command === "put") {
        kv.write(key, value);
        return { stdout: "" };
      }
      throw new Error(`unexpected wrangler kv command ${command}`);
    },
    ...overrides,
  });
}

/**
 * A store whose reads are served by a replica that has not caught up, while
 * writes still land on the current state. This reproduces the production
 * observation directly: the holder had already moved the generation to accepted,
 * and its next read came back claimed with a null accepted_at.
 */
function createStaleReadStore(current, staleValue) {
  let state = structuredClone(current);
  return {
    async read() { return staleValue == null ? null : structuredClone(staleValue); },
    async compareAndSet(expected, next) {
      if ((state?.generation ?? null) !== expected) return false;
      state = structuredClone(next);
      return true;
    },
    async appendAudit() {},
    get committed() { return structuredClone(state); },
  };
}

function fenceState(overrides = {}) {
  return {
    schema: D1_GENERATION_FENCE_SCHEMA,
    status: "claimed",
    generation: 1,
    holder: HOLDER,
    lease_until: "2026-09-05T08:27:45.535Z",
    fingerprint: FINGERPRINT,
    watermarks: WATERMARKS,
    accepted_at: null,
    ...overrides,
  };
}

const CLAIMED = fenceState();
const ACCEPTED = fenceState({ status: "accepted", accepted_at: "2026-09-05T08:17:30.000Z" });
const AT = Date.parse("2026-09-05T08:17:50.000Z");

test("a publication completes over a store whose reads lag its writes", async () => {
  const kv = createLaggingKv({ lagReads: 3 });
  const store = laggingWranglerStore(kv);
  const ledger = createFileLedger(join(mkdtempSync(join(tmpdir(), "d1-fence-")), "ledger.json"));
  const identity = { generation: 1, holder: HOLDER, fingerprint: FINGERPRINT };

  const claimed = await claimGeneration({
    store, ledger, holder: HOLDER, fingerprint: FINGERPRINT, watermarks: WATERMARKS, now: AT, leaseMs: LEASE_MS,
  });
  assert.equal(claimed.claimed, true, "the claim must survive a read that lags the put");
  assert.equal(claimed.generation, 1);

  const commit = await checkGenerationCommit({ store, ledger, ...identity, now: AT + 1_000 });
  assert.equal(commit.committable, true);
  assert.equal(commit.state.status, "accepted");

  // The two renewals that bracket the D1 SQL commands in the deploy.
  for (const offset of [7_000, 12_000]) {
    const renewed = await renewGeneration({ store, ledger, ...identity, now: AT + offset, leaseMs: LEASE_MS });
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.state.status, "accepted", "a renewal must not walk the generation back to claimed");
    assert.equal(renewed.state.accepted_at, commit.state.accepted_at);
  }

  const completed = await completeGeneration({ store, ledger, ...identity, now: AT + 20_000 });
  assert.equal(completed.completed, true, "the publication that ran must be recorded as published");
  assert.equal(completed.state.status, "published");
  assert.equal(completed.state.lease_until, null);
});

test("compare-and-set refuses to report a write it cannot read back", async () => {
  const kv = createLaggingKv({ lagReads: 1_000 });
  const store = laggingWranglerStore(kv, { readAfterWriteMs: 9_000, readAfterWritePollMs: 3_000 });
  assert.equal(await store.compareAndSet(null, fenceState()), false);
});

test("a renewal never regresses an accepted generation back to claimed", async () => {
  const store = createStaleReadStore(ACCEPTED, CLAIMED);
  const ledger = createMemoryLedger(ACCEPTED);
  const renewed = await renewGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT, leaseMs: LEASE_MS,
  });

  assert.equal(renewed.renewed, true);
  assert.equal(renewed.state.status, "accepted");
  assert.equal(renewed.state.accepted_at, ACCEPTED.accepted_at);
  assert.equal(store.committed.status, "accepted", "the stale read must not be written back over the acceptance");
  assert.equal(Date.parse(store.committed.lease_until), AT + LEASE_MS);
});

test("a stale read alone regresses the fence, which is the defect being fixed", async () => {
  const store = createStaleReadStore(ACCEPTED, CLAIMED);
  const renewed = await renewGeneration({
    store, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT, leaseMs: LEASE_MS,
  });

  assert.equal(renewed.state.status, "claimed");
  assert.equal(store.committed.status, "claimed");
  assert.equal(
    (await completeGeneration({ store, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT })).completed,
    false,
    "without a confirmed local view the run cannot record the publication it performed",
  );
});

test("completion accepts an acceptance this holder confirmed but cannot yet read back", async () => {
  const store = createStaleReadStore(ACCEPTED, CLAIMED);
  const ledger = createMemoryLedger(ACCEPTED);
  const completed = await completeGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT,
  });

  assert.equal(completed.completed, true);
  assert.equal(completed.state.status, "published");
  assert.equal(completed.state.accepted_at, ACCEPTED.accepted_at);
  assert.equal(store.committed.status, "published");
});

test("a newer generation still fences this holder despite its own confirmed view", async () => {
  const superseding = fenceState({ generation: 2, holder: OTHER_HOLDER, status: "claimed", accepted_at: null });
  const store = createStaleReadStore(superseding, superseding);
  const ledger = createMemoryLedger(ACCEPTED);

  const renewed = await renewGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT, leaseMs: LEASE_MS,
  });
  assert.equal(renewed.fenced, true);
  assert.equal(renewed.renewed, false);

  const completed = await completeGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT,
  });
  assert.equal(completed.fenced, true);
  assert.equal(completed.completed, false);
  assert.equal(store.committed.generation, 2, "the superseding claim survives untouched");
});

test("a different holder on the same generation is still fenced", async () => {
  const stolen = fenceState({ holder: OTHER_HOLDER });
  const store = createStaleReadStore(stolen, stolen);
  const ledger = createMemoryLedger(ACCEPTED);

  assert.equal((await renewGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT, leaseMs: LEASE_MS,
  })).fenced, true);
  assert.equal(store.committed.holder, OTHER_HOLDER);
});

test("an abandoned generation is terminal and is never revived by a local view", async () => {
  const abandoned = fenceState({ status: "abandoned", lease_until: "2026-09-05T08:17:40.000Z" });
  const store = createStaleReadStore(abandoned, abandoned);
  const ledger = createMemoryLedger(ACCEPTED);

  assert.equal((await renewGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT, leaseMs: LEASE_MS,
  })).fenced, true);
  assert.equal((await completeGeneration({
    store, ledger, generation: 1, holder: HOLDER, fingerprint: FINGERPRINT, now: AT,
  })).completed, false);
  assert.equal(store.committed.status, "abandoned");
});
