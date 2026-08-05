#!/usr/bin/env node
/** Merge successful T0/T1/T2 rows into the committed attachment lookup twins. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = resolve(ROOT, "site/data/attachment_metadata_lookup.json");
const WORKER = resolve(ROOT, "worker/src/data/attachment_metadata_lookup.json");

function argsOf(argv) {
  const out = { metadata: null, text: null, tables: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--metadata") out.metadata = resolve(argv[++i]);
    else if (arg === "--text") out.text = resolve(argv[++i]);
    else if (arg === "--tables") out.tables = resolve(argv[++i]);
    else if (arg === "--check") out.check = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function jsonl(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function key(row) {
  return `${row.request_id}:${row.document_id}`;
}

function sourceBacked(row) {
  return Boolean(row.request_id && row.document_id && row.url
    && (row.source === "portal" || row.source === "dataset"));
}

function stripBuiltAt(value) {
  const { built_at, ...rest } = value;
  return rest;
}

const args = argsOf(process.argv.slice(2));
if (args.check) {
  const site = JSON.parse(readFileSync(SITE, "utf8"));
  const worker = JSON.parse(readFileSync(WORKER, "utf8"));
  if (JSON.stringify(stripBuiltAt(site)) !== JSON.stringify(stripBuiltAt(worker))) {
    throw new Error("attachment lookup site/worker drift");
  }
  console.log(`attachment lookup ok: notices=${Object.keys(site.notices || {}).length}`);
  process.exit(0);
}

if (!args.metadata) throw new Error("--metadata is required when rebuilding");
const current = JSON.parse(readFileSync(SITE, "utf8"));
const rows = new Map();
for (const attachments of Object.values(current.notices || {})) {
  for (const row of attachments) rows.set(key(row), row);
}
for (const row of jsonl(args.metadata)) {
  if (sourceBacked(row)) rows.set(key(row), { ...rows.get(key(row)), ...row });
}
for (const row of jsonl(args.text)) {
  if (row.text_status === "ok" && row.extracted_text && rows.has(key(row))) {
    rows.set(key(row), { ...rows.get(key(row)), ...row });
  }
}
for (const row of jsonl(args.tables)) {
  if (row.tables_status === "ok" && row.tables_count > 0 && rows.has(key(row))) {
    rows.set(key(row), { ...rows.get(key(row)), ...row });
  }
}

const notices = {};
for (const row of [...rows.values()].sort((a, b) => key(a).localeCompare(key(b)))) {
  (notices[row.request_id] ||= []).push(row);
}
const output = { ...current, built_at: new Date().toISOString(), notices };
writeFileSync(SITE, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(WORKER, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote attachment lookup twins: notices=${Object.keys(notices).length} attachments=${rows.size}`);
