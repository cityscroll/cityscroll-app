#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MEETING_OUTCOMES_SNAPSHOT_SCHEMA,
  buildMeetingOutcomesSnapshot,
} from "../site/meeting_outcomes_static.mjs";
import { unboundRollCalls } from "../ops/first-class-refresh/guard-publication.mjs";
import {
  MAX_AGE_MS,
  meetingOutcomesViewNeedsRefresh,
} from "../worker/src/lib/meeting_outcomes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const API = process.env.MEETING_OUTCOMES_API || "https://api.cityscroll.org/meeting-outcomes";

/**
 * Refuse to publish a site snapshot from a Worker view that is already stale.
 * Scheduled first-class refresh previously treated a successful HTTP copy of a
 * stale generated_at as acquisition success, so the committed vintage never
 * advanced and Pages eventually blocked on hard_maximum_age.
 */
export function assertMeetingOutcomesSourceFresh(body, { nowMs = Date.now() } = {}) {
  if (!body || typeof body !== "object") {
    throw new Error("meeting outcomes source body is missing");
  }
  if (body.ok === false) {
    throw new Error(`meeting outcomes source unavailable (${body.reason || "ok=false"})`);
  }
  const generatedAt = body.generated_at;
  if (!generatedAt || !Number.isFinite(Date.parse(String(generatedAt)))) {
    throw new Error("meeting outcomes source is missing generated_at; refusing to fabricate a vintage");
  }
  const needsRefresh = meetingOutcomesViewNeedsRefresh(
    { generated_at: generatedAt, schema_version: body.schema_version },
    nowMs,
  );
  if (body.stale === true || needsRefresh) {
    throw new Error(
      `meeting outcomes source is stale (generated_at=${generatedAt}, max_age_ms=${MAX_AGE_MS}); refusing to publish a non-advancing snapshot`,
    );
  }
  return String(generatedAt);
}

export async function fetchMeetingOutcomesRecords(fetchImpl = fetch, { nowMs = Date.now() } = {}) {
  const records = [];
  let offset = 0;
  let generatedAt = null;
  while (offset < 2000) {
    const response = await fetchImpl(`${API}?limit=100&offset=${offset}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`meeting outcomes HTTP ${response.status}`);
    const body = await response.json();
    if (generatedAt == null) {
      generatedAt = assertMeetingOutcomesSourceFresh(body, { nowMs });
    }
    const page = Array.isArray(body?.records) ? body.records : [];
    records.push(...page);
    offset += page.length;
    if (!page.length || offset >= Number(body?.pagination?.total || 0)) {
      return { records, generatedAt };
    }
  }
  throw new Error("meeting outcomes pagination exceeded the 2,000-record safety cap");
}

function validate(snapshot) {
  assert.equal(snapshot?.schema, MEETING_OUTCOMES_SNAPSHOT_SCHEMA);
  assert.equal(snapshot?.delivery_tier, "inline-at-build");
  assert.equal(snapshot?.record_count, Object.keys(snapshot?.by_notice || {}).length);
  assert.ok(snapshot.record_count > 0, "meeting outcomes snapshot must not be empty");
  assert.equal(snapshot.record_count, snapshot.present_count + snapshot.absent_count);
  const unbound = unboundRollCalls(snapshot);
  assert.equal(
    unbound.length,
    0,
    `retained roll calls must carry exact event and agenda-item references; unbound=${unbound.length}`,
  );
}

async function main() {
  if (process.argv.includes("--check")) {
    const snapshot = JSON.parse(await readFile(OUT, "utf8"));
    validate(snapshot);
    console.log(`ok site/data/meeting_outcomes_snapshot.json records=${snapshot.record_count}`);
    return;
  }
  const { records, generatedAt } = await fetchMeetingOutcomesRecords();
  const snapshot = buildMeetingOutcomesSnapshot(records, { generatedAt });
  validate(snapshot);
  await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote site/data/meeting_outcomes_snapshot.json records=${snapshot.record_count} present=${snapshot.present_count} absent=${snapshot.absent_count}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
