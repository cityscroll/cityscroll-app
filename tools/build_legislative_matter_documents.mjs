#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const OUTPUT = join(ROOT, "site/data/legislative_matter_lookup.json");
const TARGET = "78605";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clean(value, max = 1000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function matterHref(id) {
  return /^\d+$/.test(String(id)) ? `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${encodeURIComponent(id)}` : null;
}

function exactBodyId(event) {
  const value = event?.body_id || event?.committee_id || event?.body?.id;
  return /^\d+$/.test(String(value || "").trim()) ? String(value).trim() : null;
}

function appearanceFor(requestId, record, matter, snapshotGeneratedAt) {
  const event = record.event || {};
  const bodyId = exactBodyId(event);
  return {
    request_id: requestId,
    event: {
      event_id: clean(event.event_id, 80),
      name: clean(event.name || "Council meeting", 240),
      date: clean(event.date, 20),
      url: clean(event.url, 1000),
      body_id: bodyId,
      documents: (Array.isArray(event.documents) ? event.documents : []).map((document) => ({
        name: clean(document?.name || "Official meeting record", 120),
        url: clean(document?.url, 1000),
      })).filter((document) => /^https:\/\//.test(document.url)),
    },
    committee: {
      label: clean(event.name || "Committee not listed", 240),
      body_id: bodyId,
      join_state: bodyId ? "matched_exact_body_id" : "unresolved_no_explicit_body_id",
    },
    matter_id: TARGET,
    matter_file: clean(matter.matter_file, 120),
    actions: (Array.isArray(matter.actions) ? matter.actions : []).map((action) => clean(action, 240)).filter(Boolean),
    outcome: clean(matter.outcome, 240) || null,
    matter_type: clean(matter.matter_type, 120) || null,
    matter_status: clean(matter.status, 160) || null,
    votes: matter.votes || null,
    source_receipt: {
      source_system: "legistar",
      request_id: requestId,
      event_id: clean(event.event_id, 80),
      source_url: clean(event.url, 1000),
      input_artifact: "site/data/meeting_outcomes_snapshot.json",
      snapshot_generated_at: clean(snapshotGeneratedAt || "", 80) || null,
    },
  };
}

export function buildLegislativeMatterLookup(snapshot = {}) {
  const appearances = [];
  let identity = null;
  for (const [requestId, record] of Object.entries(snapshot.by_notice || {})) {
    if (record?.snapshot_state !== "present") continue;
    const matter = (Array.isArray(record.matters) ? record.matters : [])
      .find((candidate) => String(candidate?.matter_id || "") === TARGET);
    if (!matter) continue;
    const currentIdentity = {
      matter_file: clean(matter.matter_file, 120),
      title: clean(matter.title, 500),
      matter_type: clean(matter.matter_type, 120) || null,
      matter_status: clean(matter.status, 160) || null,
      matter_href: matterHref(TARGET),
    };
    if (!identity) identity = currentIdentity;
    for (const key of ["matter_file", "title", "matter_href"]) {
      if (identity[key] !== currentIdentity[key]) throw new Error(`matter ${TARGET} identity drift in ${requestId}: ${key}`);
    }
    appearances.push(appearanceFor(requestId, record, matter, snapshot.generated_at));
  }
  appearances.sort((left, right) => String(left.event.date).localeCompare(String(right.event.date)) || left.event.event_id.localeCompare(right.event.event_id));
  if (!identity || appearances.length < 2) throw new Error(`matter ${TARGET} requires at least two exact observed appearances`);
  return {
    schema: "cityscroll.legislative_matter_lookup.v1",
    generated_at: clean(snapshot.generated_at, 80) || null,
    source: {
      system: "legistar",
      input_artifact: "site/data/meeting_outcomes_snapshot.json",
      identity: "matter:{legistar_matter_id}",
      exact_key_only: true,
    },
    matters: {
      [TARGET]: {
        matter_id: TARGET,
        ...identity,
        appearances,
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const output = `${JSON.stringify(buildLegislativeMatterLookup(readJson(INPUT)), null, 2)}\n`;
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  if (check) {
    if (current !== output) {
      console.error("legislative matter lookup is stale");
      process.exit(1);
    }
    console.log("Legislative matter lookup is current");
  } else {
    writeFileSync(OUTPUT, output);
    console.log(`wrote ${OUTPUT}`);
  }
}
