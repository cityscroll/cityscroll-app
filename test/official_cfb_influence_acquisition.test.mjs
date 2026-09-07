import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CHECK_CADENCE_HOURS,
  acquire,
  contentFingerprint,
  inspectRetained,
  publisherUpdatedAt,
} from "../tools/acquire_official_cfb_influence.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const PUBLISHER_UPDATED = "2025-12-19T15:24:13.000Z";
const METADATA = { rowsUpdatedAt: 1766157853 };

const HUB = {
  person_count: 1,
  gate: { promoted: true },
  by_person_id: {
    7801: { person_id: "7801", person_name: "Christopher Marte" },
  },
};

const ROWS = [
  { name: "Genovese, Laura", recipid: "1", recipname: "Marte", candfirst: "Christopher", amnt: "500", election: "2021", officecd: "5" },
  { name: "Singh, Deodat", recipid: "1", recipname: "Marte", candfirst: "Christopher", amnt: "1600", election: "2021", officecd: "5" },
];

/**
 * One acquisition against a temporary tree, with a stubbed publisher whose
 * calls are recorded. Nothing here reaches the network.
 */
async function run(root, { now, metadata = METADATA, rows = ROWS, force = false } = {}) {
  const requested = [];
  const result = await acquire({
    now,
    force,
    artifactPath: join(root, "official_cfb_influence_lookup.json"),
    receiptPath: join(root, "receipts/official_cfb_influence_latest.json"),
    hubPath: join(root, "person_hub_lookup.json"),
    fetchImpl: async (url) => {
      requested.push(String(url));
      const body = String(url).includes("/api/views/") ? metadata : rows.slice(0, 1000);
      return { ok: true, status: 200, json: async () => body };
    },
  });
  return { result, requested };
}

function seed(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "person_hub_lookup.json"), JSON.stringify(HUB));
}

function artifactAt(root) {
  return JSON.parse(readFileSync(join(root, "official_cfb_influence_lookup.json"), "utf8"));
}

test("the publisher's row clock, not its description clock, decides whether anything changed", () => {
  assert.equal(publisherUpdatedAt(METADATA), PUBLISHER_UPDATED);
  assert.equal(publisherUpdatedAt({ rowsUpdatedAt: null }), null);
  assert.equal(publisherUpdatedAt({}), null);
});

test("the first acquisition materializes the edges and records both clocks", async () => {
  await withTempDir("cfb-first", async (root) => {
    seed(root);
    const { result, requested } = await run(root, { now: "2026-09-07T12:00:00.000Z" });
    assert.equal(result.outcome, "rebuilt_changed");
    const artifact = artifactAt(root);
    assert.equal(artifact.publisher_updated_at, PUBLISHER_UPDATED);
    assert.equal(artifact.checked_at, "2026-09-07T12:00:00.000Z");
    assert.equal(artifact.retrieved_at, "2026-09-07T12:00:00.000Z");
    assert.equal(artifact.content_fingerprint, contentFingerprint(artifact));
    assert.ok(artifact.edge_count > 0);
    assert.ok(requested.some((url) => url.includes("/resource/")), "the first run reads rows");
    assert.deepEqual(inspectRetained({ artifactPath: join(root, "official_cfb_influence_lookup.json") }).findings, []);
  });
});

test("a dormant publisher inside the cadence window rewrites nothing and reads no rows", async () => {
  await withTempDir("cfb-dormant", async (root) => {
    seed(root);
    await run(root, { now: "2026-09-07T12:00:00.000Z" });
    const before = readFileSync(join(root, "official_cfb_influence_lookup.json"));

    const { result, requested } = await run(root, { now: "2026-09-08T12:00:00.000Z" });
    assert.equal(result.outcome, "unchanged_within_cadence");
    assert.equal(result.wrote_artifact, false);
    assert.deepEqual(readFileSync(join(root, "official_cfb_influence_lookup.json")), before);
    assert.ok(!requested.some((url) => url.includes("/resource/")), "a quiet publisher costs one metadata request");
  });
});

test("a dormant publisher past the cadence window records the check and leaves the edges alone", async () => {
  await withTempDir("cfb-recheck", async (root) => {
    seed(root);
    await run(root, { now: "2026-09-07T12:00:00.000Z" });
    const before = artifactAt(root);

    const later = new Date(Date.parse("2026-09-07T12:00:00.000Z") + (CHECK_CADENCE_HOURS + 1) * 3_600_000).toISOString();
    const { result, requested } = await run(root, { now: later });
    assert.equal(result.outcome, "confirmed_unchanged");
    const after = artifactAt(root);
    assert.equal(after.checked_at, later);
    // The check clock moved; nothing the publisher filed did.
    assert.equal(after.retrieved_at, before.retrieved_at);
    assert.equal(after.publisher_updated_at, before.publisher_updated_at);
    assert.deepEqual(after.by_person_id, before.by_person_id);
    assert.equal(after.edge_count, before.edge_count);
    assert.ok(!requested.some((url) => url.includes("/resource/")), "an unchanged publisher is never re-read");
  });
});

test("a publisher that resumes filing is re-read and the new edges are materialized", async () => {
  await withTempDir("cfb-resumed", async (root) => {
    seed(root);
    await run(root, { now: "2026-09-07T12:00:00.000Z" });
    const before = artifactAt(root);

    const resumed = { rowsUpdatedAt: Math.floor(Date.parse("2026-09-10T09:00:00.000Z") / 1000) };
    const { result, requested } = await run(root, {
      now: "2026-09-10T12:00:00.000Z",
      metadata: resumed,
      rows: [...ROWS, { name: "New Donor", recipid: "1", recipname: "Marte", candfirst: "Christopher", amnt: "250", election: "2025", officecd: "5" }],
    });
    assert.equal(result.outcome, "rebuilt_changed");
    const after = artifactAt(root);
    assert.equal(after.publisher_updated_at, "2026-09-10T09:00:00.000Z");
    assert.equal(after.retrieved_at, "2026-09-10T12:00:00.000Z");
    assert.ok(after.edge_count > before.edge_count);
    assert.ok(requested.some((url) => url.includes("/resource/")), "a moved publisher is read in full");
    assert.ok(existsSync(join(root, "receipts/official_cfb_influence_latest.json")));
  });
});

test("a re-read that produces the same edges keeps the retained materialization date", async () => {
  await withTempDir("cfb-identical", async (root) => {
    seed(root);
    await run(root, { now: "2026-09-07T12:00:00.000Z" });
    const before = artifactAt(root);

    const { result } = await run(root, { now: "2026-09-20T12:00:00.000Z", force: true });
    assert.equal(result.outcome, "rebuilt_identical");
    const after = artifactAt(root);
    assert.equal(after.retrieved_at, before.retrieved_at);
    assert.equal(after.checked_at, "2026-09-20T12:00:00.000Z");
    assert.equal(after.content_fingerprint, before.content_fingerprint);
  });
});

test("a publisher outage leaves the retained edges exactly as they were", async () => {
  await withTempDir("cfb-outage", async (root) => {
    seed(root);
    await run(root, { now: "2026-09-07T12:00:00.000Z" });
    const before = readFileSync(join(root, "official_cfb_influence_lookup.json"));

    await assert.rejects(
      acquire({
        now: "2026-09-20T12:00:00.000Z",
        artifactPath: join(root, "official_cfb_influence_lookup.json"),
        receiptPath: join(root, "receipts/official_cfb_influence_latest.json"),
        hubPath: join(root, "person_hub_lookup.json"),
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      }),
      /could not read/,
    );
    assert.deepEqual(readFileSync(join(root, "official_cfb_influence_lookup.json")), before);
  });
});

test("the committed artifact carries the stamps the scheduled refresh reads", () => {
  const findings = inspectRetained().findings;
  assert.deepEqual(findings, []);
});
