#!/usr/bin/env node
/**
 * T2: extract structured tables from high-value T0 attachments (docx/pdf).
 * Budget-bounded; polite download cadence; tables as JSON (see ADR).
 * Storage judgment: docs/adr/attachment-tables-storage.md
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  classifyAttachmentForTables,
  MAX_DOCS_PER_RUN,
  MAX_EXTRACT_BYTES,
  recommendTableStorage,
  stampAttachmentTables,
  tablesToSearchText,
} from "../lib/attachment_tables.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const FIXTURE_META = resolve(REPO, "warehouse/fixtures/attachment_metadata.json");
const FIXTURE_BIN = resolve(REPO, "warehouse/fixtures/attachment_binaries");
const DEFAULT_INVENTORY = resolve(REPO, "warehouse/raw/attachment-metadata/attachments.jsonl");
const DEFAULT_JSONL = resolve(REPO, "warehouse/raw/attachment-tables/attachments_with_tables.jsonl");
const DEFAULT_RECEIPT = resolve(REPO, "warehouse/receipts/attachment_tables_latest.json");
const DEFAULT_CHECKPOINT = resolve(REPO, "warehouse/raw/attachment-tables/checkpoint.json");
const EXTRACTOR = resolve(REPO, "warehouse/lib/attachment_tables_extract.py");
const USER_AGENT = "CityScroll attachment tables collector (cityscroll.org; daily civic-data refresh)";

function parseArgs(argv) {
  const out = {
    fixture: false,
    limit: MAX_DOCS_PER_RUN,
    delayMs: 1200,
    inventory: DEFAULT_INVENTORY,
    jsonl: DEFAULT_JSONL,
    receipt: DEFAULT_RECEIPT,
    checkpoint: DEFAULT_CHECKPOINT,
    pushUrl: process.env.CITYSCROLL_ATTACHMENT_ENDPOINT || "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-fixture") out.fixture = true;
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--polite-delay-ms") out.delayMs = Number(argv[++i]);
    else if (arg === "--inventory") out.inventory = resolve(argv[++i]);
    else if (arg === "--jsonl") out.jsonl = resolve(argv[++i]);
    else if (arg === "--receipt") out.receipt = resolve(argv[++i]);
    else if (arg === "--checkpoint") out.checkpoint = resolve(argv[++i]);
    else if (arg === "--push-url") out.pushUrl = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.fixture && out.delayMs < 1200) throw new Error("live portal cadence must be at least 1200 ms");
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > MAX_DOCS_PER_RUN) {
    throw new Error(`--limit must be 1..${MAX_DOCS_PER_RUN}`);
  }
  return out;
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readCheckpoint(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return { completed: {} }; }
}

async function loadInventory(args) {
  if (args.fixture) {
    const meta = JSON.parse(await readFile(FIXTURE_META, "utf8"));
    const rows = [] // source: runtime accumulator (not a published dataset);
    for (const row of meta.rows) {
      if (row.section_name === "Changes in Personnel") continue;
      const html = meta.portal_html?.[row.request_id] || "";
      const titleMatch = html.match(/documentId=(\d+)[^>]*>([^<]+)/i)
        || html.match(/documentId=(\d+)/i);
      const documentId = titleMatch?.[1] || null;
      const title = titleMatch?.[2]?.replace(/&amp;/g, "&").trim() || null;
      const url = row.document_links
        || (documentId
          ? `https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=3&requestId=${row.request_id}&requestStatus=Archived&documentId=${documentId}`
          : null);
      if (!documentId || !url) continue;
      rows.push({
        request_id: String(row.request_id),
        document_id: String(documentId),
        title,
        url,
        content_type: documentId === "37470"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : null,
        bytes: null,
        source: "portal",
      });
    }
    return rows;
  }
  const raw = await readFile(args.inventory, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runExtractor(buffer, kind) {
  const result = spawnSync("python3", [EXTRACTOR, "--kind", kind || ""], {
    input: buffer,
    encoding: "buffer",
    maxBuffer: MAX_EXTRACT_BYTES + 64_000,
  });
  if (result.status !== 0) {
    const err = result.stderr?.toString?.() || result.error?.message || "extractor failed";
    return { status: "extract_failed", reason: err.slice(0, 200), tables: [] };
  }
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    return { status: "extract_failed", reason: "extractor_bad_json", tables: [] };
  }
}

async function loadBinary(attachment, args) {
  if (args.fixture) {
    const local = resolve(FIXTURE_BIN, `${attachment.document_id}-cannonsville.docx`);
    try {
      return await readFile(local);
    } catch {
      try { return await readFile(resolve(FIXTURE_BIN, `${attachment.document_id}.docx`)); }
      catch { return null; }
    }
  }
  const response = await fetch(attachment.url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
  });
  if (response.status === 403) throw new Error(`portal refused polite collector (HTTP 403): ${attachment.url}`);
  if (!response.ok) throw new Error(`fetch failed (${response.status}): ${attachment.url}`);
  const lengthHeader = Number(response.headers.get("content-length") || 0);
  if (lengthHeader > MAX_EXTRACT_BYTES) return { tooLarge: true, bytes: lengthHeader };
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_EXTRACT_BYTES) return { tooLarge: true, bytes: buffer.byteLength };
  const contentType = response.headers.get("content-type");
  return { buffer, contentType, bytes: buffer.byteLength };
}

async function pushBatches(url, notices, receipt) {
  if (!url) return { pushed: false, batches: 0 };
  const key = process.env.CITYSCROLL_ADMIN_KEY || "";
  if (!key) throw new Error("CITYSCROLL_ADMIN_KEY is required with --push-url");
  let batches = 0;
  for (let i = 0; i < notices.length; i += 75) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ notices: notices.slice(i, i + 75), receipt, tier: "t2_tables" }),
    });
    if (!response.ok) throw new Error(`attachment tables upload failed (${response.status})`);
    batches += 1;
  }
  return { pushed: true, batches };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: attachment_tables.mjs [--from-fixture] [--limit 25] [--push-url URL]");
    return;
  }
  const startedAt = new Date().toISOString();
  const runId = `att-t2-${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;
  const inventory = await loadInventory(args);
  const checkpoint = await readCheckpoint(args.checkpoint);
  const stamped = [] // source: runtime accumulator (not a published dataset);
  let attempted = 0;
  let extracted = 0;
  let skipped = 0;
  let failed = 0;
  let totalTables = 0;
  let totalCells = 0;

  for (const item of inventory) {
    if (attempted >= args.limit) break;
    const key = `${item.request_id}:${item.document_id}`;
    if (checkpoint.completed[key]?.tables_status === "ok" && !args.fixture) {
      skipped += 1;
      continue;
    }
    const classification = classifyAttachmentForTables(item);
    if (!classification.eligible) {
      stamped.push(stampAttachmentTables(item, {
        status: "skipped",
        reason: classification.reason,
        method: classification.class,
      }));
      skipped += 1;
      continue;
    }
    attempted += 1;
    let binary;
    try {
      binary = await loadBinary(item, args);
    } catch (error) {
      failed += 1;
      stamped.push(stampAttachmentTables(item, {
        status: "extract_failed",
        reason: String(error.message || error).slice(0, 200),
      }));
      continue;
    }
    if (!binary || binary.tooLarge) {
      skipped += 1;
      stamped.push(stampAttachmentTables(item, {
        status: "skipped",
        reason: "too_large",
      }));
      continue;
    }
    if (Buffer.isBuffer(binary)) {
      binary = { buffer: binary, contentType: item.content_type, bytes: binary.byteLength };
    }
    const withMeta = {
      ...item,
      content_type: item.content_type || binary.contentType || null,
      bytes: item.bytes ?? binary.bytes ?? null,
    };
    const kind = classifyAttachmentForTables(withMeta).class || classification.class;
    const extract = runExtractor(binary.buffer, kind);
    const row = stampAttachmentTables(withMeta, {
      ...extract,
      extracted_at: new Date().toISOString(),
    });
    stamped.push(row);
    if (row.tables_status === "ok" && row.tables_count > 0) {
      extracted += 1;
      totalTables += row.tables_count;
      for (const table of row.extracted_tables || []) {
        totalCells += (table.n_cols || 0) * ((table.n_rows || 0) + 1);
      }
    } else if (row.tables_status === "skipped") skipped += 1;
    else if (row.tables_status === "ok" && !row.tables_count) {
      // Eligible doc with no recoverable tables — not a failure.
      skipped += 1;
    } else failed += 1;
    checkpoint.completed[key] = {
      observed_at: new Date().toISOString(),
      tables_status: row.tables_status,
      tables_count: row.tables_count,
    };
    await writeJson(args.checkpoint, checkpoint);
    if (!args.fixture) await wait(args.delayMs);
  }

  const byNotice = new Map();
  for (const row of stamped) {
    if (!byNotice.has(row.request_id)) byNotice.set(row.request_id, []);
    byNotice.get(row.request_id).push(row);
  }
  const notices = [...byNotice.entries()].map(([request_id, attachments]) => ({
    request_id,
    attachments,
  }));

  await mkdir(dirname(args.jsonl), { recursive: true });
  const jsonlBody = stamped.map((item) => JSON.stringify(item)).join("\n") + (stamped.length ? "\n" : "");
  await writeFile(args.jsonl, jsonlBody);

  const storage = recommendTableStorage({
    docsWithTables: extracted,
    totalTables,
    totalCells,
    payloadBytes: Buffer.byteLength(jsonlBody, "utf8"),
    needsCrossDocSql: false,
    ciMustInstallDuckdb: false,
  });

  const receipt = {
    schema: "cityscroll.attachment_tables.receipt.v1",
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    mode: args.fixture ? "fixture" : "live",
    tier: "t2_structured_tables",
    inventory_seen: inventory.length,
    docs_attempted: attempted,
    docs_with_tables: extracted,
    docs_skipped: skipped,
    docs_failed: failed,
    total_tables: totalTables,
    total_cells: totalCells,
    max_docs_per_run: MAX_DOCS_PER_RUN,
    max_extract_bytes: MAX_EXTRACT_BYTES,
    binaries_stored: false,
    images_ocr: false,
    pdf_limits: "text_layer_row_recovery_only",
    storage_decision: storage,
    storage_adr: "docs/adr/attachment-tables-storage.md",
    polite_delay_s: args.fixture ? 0 : args.delayMs / 1000,
    checkpoint: true,
    parallel_lane: {
      t3: "att-t3-embeddings",
      note: "embeddings are a separate tier; this run only writes table JSON",
    },
  };
  const upload = await pushBatches(args.pushUrl, notices, receipt);
  receipt.upload = upload;
  await writeJson(args.receipt, receipt);
  console.log(JSON.stringify(receipt));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
