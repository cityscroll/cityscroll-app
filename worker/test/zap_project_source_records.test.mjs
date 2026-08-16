// ZAP Projects immutable observation dual-write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  dualWriteZapProjectObservations,
  normalizeZapProjectObservation,
  zapProjectSourceSystemId,
  ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE_FLAG,
  ZAP_PROJECTS_SOURCE_SYSTEM,
} from "../src/lib/zap_project_source_records.mjs";
import { refreshZapOutcomes } from "../src/zap_outcomes.mjs";

const PROJECT = {
  project_id: "2022M0258",
  project_name: "343 Madison Avenue",
  public_status: "Completed",
  project_status: "Complete",
  ulurp_numbers: "C 220220 ZSM; N 220221 ZRM",
  borough: "Manhattan",
  community_district: "M05",
  actions: "ZS; ZR",
  current_milestone: "Mayor",
  current_milestone_date: "2022-12-01",
  primary_applicant: "Vornado Realty Trust",
  lookup_path: "warehouse",
};

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql);
          return {
            async run() { statement.run(...values); return { success: true }; },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

function database({ observations = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (observations) {
    sqlite.exec(readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8"));
  }
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

function kv() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

test("ZAP project identity uses the publisher project_id and rejects shells", () => {
  assert.equal(zapProjectSourceSystemId(PROJECT), "2022M0258");
  const normalized = normalizeZapProjectObservation(PROJECT, {
    observedAt: "2026-08-16T12:00:00.000Z",
  });
  assert.equal(normalized.source_system, ZAP_PROJECTS_SOURCE_SYSTEM);
  assert.equal(normalized.source_system_id, "2022M0258");
  assert.equal(normalized.source_url, "https://zap.planning.nyc.gov/projects/2022M0258");
  assert.equal(normalized.observed_at, "2026-08-16T12:00:00.000Z");
  assert.equal(normalized.lookup_path, undefined, "transport metadata is not publisher data");
  assert.equal(normalizeZapProjectObservation({ project_id: "2022M0258" }), null);
});

test("flag-on dual-write is immutable, provenance-complete, and flag-off is inert", async () => {
  const { sqlite, DB } = database();
  const off = await dualWriteZapProjectObservations({ DB }, [PROJECT]);
  assert.equal(off.skipped, "flag-off");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 0);

  const env = { DB, [ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const first = await dualWriteZapProjectObservations(
    env,
    [PROJECT],
    "2026-08-16T12:00:00.000Z",
  );
  assert.deepEqual(first, { written: 1, skipped: null, failed: false, rejected: 0 });
  const row = sqlite.prepare("SELECT * FROM source_records").get();
  assert.equal(row.source_system, ZAP_PROJECTS_SOURCE_SYSTEM);
  assert.equal(row.source_system_id, "2022M0258");
  assert.equal(row.ingested_at, "2026-08-16T12:00:00.000Z");
  const raw = JSON.parse(row.raw_snapshot);
  const normalized = JSON.parse(row.normalized_snapshot);
  assert.equal(raw.project_id, "2022M0258");
  assert.equal(raw.lookup_path, undefined);
  assert.equal(normalized.source_url, "https://zap.planning.nyc.gov/projects/2022M0258");
  assert.equal(normalized.observed_at, "2026-08-16T12:00:00.000Z");

  await dualWriteZapProjectObservations(env, [PROJECT], "2026-08-16T12:00:00.000Z");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 1);
  sqlite.close();
});

test("daily ZAP prewarm dual-writes only real Open Data rows without changing KV", async () => {
  const { sqlite, DB } = database();
  const ALERT_STATE = kv();
  const generatedAt = "2026-08-16T12:00:00.000Z";
  const publicRecord = {
    project_id: PROJECT.project_id,
    generated_at: generatedAt,
    open_data: PROJECT,
    join: { matched: true, method: "exact_project_id" },
    filled: true,
  };
  const result = await refreshZapOutcomes(
    { DB, ALERT_STATE, [ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" },
    {
      projectIds: [PROJECT.project_id],
      build: async () => structuredClone(publicRecord),
      force: true,
      nowMs: Date.parse(generatedAt),
    },
  );
  assert.equal(result.computed, 1);
  assert.deepEqual(result.dual_write, { written: 1, failed: 0, rejected: 0 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 1);
  const cached = JSON.parse(await ALERT_STATE.get("zap-outcome:v1:2022M0258"));
  assert.deepEqual(cached, publicRecord, "shadow telemetry must not enter the public record");
  sqlite.close();
});

test("unverified project shells and missing observation schema remain fail-soft", async () => {
  const { sqlite, DB } = database({ observations: false });
  const env = { DB, [ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const shell = await dualWriteZapProjectObservations(env, [{ project_id: "2022M0258" }]);
  assert.deepEqual(shell, { written: 0, skipped: "empty", failed: false, rejected: 1 });
  const unavailable = await dualWriteZapProjectObservations(env, [PROJECT]);
  assert.equal(unavailable.failed, true);
  sqlite.close();
});

test("production enables ZAP capture while beta remains off", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const [production, beta = ""] = wrangler.split("[env.beta.vars]");
  assert.match(production, /ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE\s*=\s*"true"/);
  assert.match(beta, /ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE\s*=\s*"false"/);
});
