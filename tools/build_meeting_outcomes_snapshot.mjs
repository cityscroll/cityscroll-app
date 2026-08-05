#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEETING_OUTCOMES_SNAPSHOT_SCHEMA,
  buildMeetingOutcomesSnapshot,
} from "../site/meeting_outcomes_static.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const API = process.env.MEETING_OUTCOMES_API || "https://api.cityscroll.org/meeting-outcomes";

async function fetchRecords(fetchImpl = fetch) {
  const records = [];
  let offset = 0;
  while (offset < 2000) {
    const response = await fetchImpl(`${API}?limit=100&offset=${offset}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`meeting outcomes HTTP ${response.status}`);
    const body = await response.json();
    const page = Array.isArray(body?.records) ? body.records : [];
    records.push(...page);
    offset += page.length;
    if (!page.length || offset >= Number(body?.pagination?.total || 0)) {
      return { records, generatedAt: body?.generated_at || new Date().toISOString() };
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
}

async function main() {
  if (process.argv.includes("--check")) {
    const snapshot = JSON.parse(await readFile(OUT, "utf8"));
    validate(snapshot);
    console.log(`ok site/data/meeting_outcomes_snapshot.json records=${snapshot.record_count}`);
    return;
  }
  const { records, generatedAt } = await fetchRecords();
  const snapshot = buildMeetingOutcomesSnapshot(records, { generatedAt });
  validate(snapshot);
  await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote site/data/meeting_outcomes_snapshot.json records=${snapshot.record_count} present=${snapshot.present_count} absent=${snapshot.absent_count}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
