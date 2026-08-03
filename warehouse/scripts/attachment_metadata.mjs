#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  mergeAttachmentSources,
  parseDatasetAttachments,
  parsePortalAttachments,
  shouldScrapePortal,
} from "../lib/attachment_metadata.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const FIXTURE = resolve(REPO, "warehouse/fixtures/attachment_metadata.json");
const DEFAULT_STATE = resolve(REPO, "warehouse/raw/attachment-metadata/checkpoint.json");
const DEFAULT_JSONL = resolve(REPO, "warehouse/raw/attachment-metadata/attachments.jsonl");
const DEFAULT_RECEIPT = resolve(REPO, "warehouse/receipts/attachment_metadata_latest.json");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const PORTAL = "https://a856-cityrecord.nyc.gov/RequestDetail/";
const USER_AGENT = "CityScroll attachment metadata collector (cityscroll.org; daily civic-data refresh)";

function parseArgs(argv) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const out = {
    startDate: yesterday, endDate: yesterday, limit: 200, delayMs: 1200,
    checkpoint: DEFAULT_STATE, jsonl: DEFAULT_JSONL, receipt: DEFAULT_RECEIPT,
    fixture: false, historicalTitles: false, pushUrl: process.env.CITYSCROLL_ATTACHMENT_ENDPOINT || "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-fixture") out.fixture = true;
    else if (arg === "--historical-titles") out.historicalTitles = true;
    else if (arg === "--start-date") out.startDate = argv[++i];
    else if (arg === "--end-date") out.endDate = argv[++i];
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--polite-delay-ms") out.delayMs = Number(argv[++i]);
    else if (arg === "--checkpoint") out.checkpoint = resolve(argv[++i]);
    else if (arg === "--jsonl") out.jsonl = resolve(argv[++i]);
    else if (arg === "--receipt") out.receipt = resolve(argv[++i]);
    else if (arg === "--push-url") out.pushUrl = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.fixture && out.delayMs < 1200) throw new Error("live portal cadence must be at least 1200 ms");
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 1000) throw new Error("--limit must be 1..1000");
  return out;
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function fetchText(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) } });
  if (response.status === 403) throw new Error(`portal refused polite collector (HTTP 403): ${url}`);
  if (!response.ok) throw new Error(`fetch failed (${response.status}): ${url}`);
  return response.text();
}

async function loadInputs(args) {
  if (args.fixture) return JSON.parse(await readFile(FIXTURE, "utf8"));
  const query = new URLSearchParams({
    "$select": "request_id,start_date,section_name,document_links",
    "$where": `start_date between '${args.startDate}T00:00:00' and '${args.endDate}T23:59:59'`,
    "$order": "request_id",
    "$limit": String(args.limit),
  });
  return { rows: JSON.parse(await fetchText(`${SODA}?${query}`)), portal_html: {} };
}

async function readCheckpoint(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return { completed: {} }; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function pushBatches(url, notices, receipt) {
  if (!url) return { pushed: false, batches: 0 };
  const key = process.env.CITYSCROLL_ADMIN_KEY || "";
  if (!key) throw new Error("CITYSCROLL_ADMIN_KEY is required with --push-url");
  let batches = 0;
  for (let i = 0; i < notices.length; i += 75) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ notices: notices.slice(i, i + 75), receipt }),
    });
    if (!response.ok) throw new Error(`metadata upload failed (${response.status})`);
    batches += 1;
  }
  return { pushed: true, batches };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: attachment_metadata.mjs [--from-fixture] [--start-date YYYY-MM-DD --end-date YYYY-MM-DD] [--limit 200] [--historical-titles] [--push-url URL]");
    return;
  }
  const startedAt = new Date().toISOString();
  const runId = `att-t0-${args.startDate}-${randomUUID()}`;
  const input = await loadInputs(args);
  const checkpoint = await readCheckpoint(args.checkpoint);
  const notices = [];
  let scraped = 0;
  let skippedPersonnel = 0;

  for (const row of input.rows.slice(0, args.limit)) {
    const requestId = String(row.request_id || "");
    if (!requestId) continue;
    if (row.section_name === "Changes in Personnel") { skippedPersonnel += 1; continue; }
    const dataset = parseDatasetAttachments(row);
    let portal = [];
    if (shouldScrapePortal(row, { historicalTitles: args.historicalTitles })) {
      const fixtureHtml = input.portal_html?.[requestId];
      const html = fixtureHtml ?? await fetchText(`${PORTAL}${encodeURIComponent(requestId)}`);
      portal = parsePortalAttachments(html, requestId);
      scraped += 1;
      checkpoint.completed[requestId] = { observed_at: new Date().toISOString(), attachments: portal.length };
      await writeJson(args.checkpoint, checkpoint);
      if (!args.fixture) await wait(args.delayMs);
    } else if (input.portal_html?.[requestId]) {
      portal = parsePortalAttachments(input.portal_html[requestId], requestId);
    }
    notices.push({ request_id: requestId, attachments: mergeAttachmentSources(dataset, portal) });
  }

  const attachments = notices.flatMap((notice) => notice.attachments);
  await mkdir(dirname(args.jsonl), { recursive: true });
  await writeFile(args.jsonl, attachments.map((item) => JSON.stringify(item)).join("\n") + (attachments.length ? "\n" : ""));
  const receipt = {
    schema: "cityscroll.attachment_metadata.receipt.v1",
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    window_start: args.startDate,
    window_end: args.endDate,
    mode: args.fixture ? "fixture" : "live",
    notices_seen: input.rows.length,
    notices_materialized: notices.length,
    notices_scraped: scraped,
    personnel_skipped: skippedPersonnel,
    attachments_found: attachments.length,
    source_counts: {
      dataset: attachments.filter((item) => item.source === "dataset").length,
      portal: attachments.filter((item) => item.source === "portal").length,
    },
    source_cliff_policy: "dataset_pre_2025_portal_2025_plus",
    polite_delay_s: args.fixture ? 0 : args.delayMs / 1000,
    checkpoint: true,
    binaries_stored: false,
  };
  const upload = await pushBatches(args.pushUrl, notices, receipt);
  receipt.upload = upload;
  await writeJson(args.receipt, receipt);
  console.log(JSON.stringify(receipt));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
