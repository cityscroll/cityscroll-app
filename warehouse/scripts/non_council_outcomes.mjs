#!/usr/bin/env node
/**
 * Host-side, bounded collector for registered non-Council minutes/vote pages.
 * Source URLs are explicit registry data. The collector never guesses a URL,
 * retries a 403, or retains downloaded binaries.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { extractUlurpKeys } from "../../site/ulurp_tokens.mjs";
import {
  JOIN_METHOD,
  buildPrecisionReviewReceipt,
  joinBridgePromotionDecision,
  materializeOutcomeLookup,
  measureJoinBridge,
  parseSourceIndex,
} from "../lib/non_council_outcomes.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const REGISTRY = resolve(REPO, "site/data/non_council_outcome_sources/source_registry.json");
const NOTICES = resolve(REPO, "site/data/meetings_domain_observations.json");
const FIXTURE = resolve(REPO, "warehouse/fixtures/non_council_outcomes.json");
const EXTRACTOR = resolve(REPO, "warehouse/lib/attachment_text_extract.py");
const DEFAULT_RAW = resolve(REPO, "warehouse/raw/non-council-outcomes/daily");
const DEFAULT_CHECKPOINT = resolve(REPO, "warehouse/raw/non-council-outcomes/checkpoint.json");
const DEFAULT_RECEIPT = resolve(REPO, "warehouse/receipts/non_council_outcomes_latest.json");
const USER_AGENT = "CityScroll non-Council minutes collector (cityscroll.org; civic-data refresh)";
const MIN_DELAY_MS = 1200;
const MAX_EXTRACT_BYTES = 5_000_000;

function parseArgs(argv) {
  const out = {
    fixture: false,
    limit: 8,
    maxDocs: 25,
    delayMs: MIN_DELAY_MS,
    registry: REGISTRY,
    notices: NOTICES,
    checkpoint: DEFAULT_CHECKPOINT,
    sourcesJsonl: resolve(DEFAULT_RAW, "sources.jsonl"),
    documentsJsonl: resolve(DEFAULT_RAW, "documents.jsonl"),
    matchesJsonl: resolve(DEFAULT_RAW, "matches.jsonl"),
    payload: resolve(DEFAULT_RAW, "payload.json"),
    receipt: DEFAULT_RECEIPT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-fixture") out.fixture = true;
    else if (arg === "--limit") out.limit = Number(argv[++index]);
    else if (arg === "--max-docs") out.maxDocs = Number(argv[++index]);
    else if (arg === "--polite-delay-ms") out.delayMs = Number(argv[++index]);
    else if (arg === "--registry") out.registry = resolve(argv[++index]);
    else if (arg === "--notices") out.notices = resolve(argv[++index]);
    else if (arg === "--checkpoint") out.checkpoint = resolve(argv[++index]);
    else if (arg === "--sources-jsonl") out.sourcesJsonl = resolve(argv[++index]);
    else if (arg === "--documents-jsonl") out.documentsJsonl = resolve(argv[++index]);
    else if (arg === "--matches-jsonl") out.matchesJsonl = resolve(argv[++index]);
    else if (arg === "--payload") out.payload = resolve(argv[++index]);
    else if (arg === "--receipt") out.receipt = resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.fixture && out.delayMs < MIN_DELAY_MS) {
    throw new Error(`live collection cadence must be at least ${MIN_DELAY_MS} ms`);
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 64) {
    throw new Error("--limit must be 1..64");
  }
  if (!Number.isInteger(out.maxDocs) || out.maxDocs < 1 || out.maxDocs > 25) {
    throw new Error("--max-docs must be 1..25");
  }
  return out;
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

async function readJsonl(path) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

async function fetchChecked(url, accept) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: accept },
  });
  if (response.status === 403) throw new Error(`source refused host-side collector (HTTP 403): ${url}`);
  if (!response.ok) throw new Error(`source fetch failed (HTTP ${response.status}): ${url}`);
  return response;
}

function bodyIdForNotice(row) {
  const agency = String(row?.agency_name || "");
  const bp = agency.match(/(?:Borough President\s*-?\s*|Office of the Borough President of\s*)(Bronx|Brooklyn|Manhattan|Queens|Staten Island)/i)
    || agency.match(/(Bronx|Brooklyn|Manhattan|Queens|Staten Island)\s+Borough President/i);
  if (bp) return `${bp[1].toLowerCase().replace(/\s+/g, "-")}-bp`;
  const board = row?.affected_area?.community_boards?.[0]?.match(/Community Board\s+(\d+),\s*(Bronx|Brooklyn|Manhattan|Queens|Staten Island)/i);
  if (!board) return null;
  return `${board[2].toLowerCase().replace(/\s+/g, "-")}-cb-${String(board[1]).padStart(2, "0")}`;
}

function matterTokensForNotice(row) {
  // Publisher ULURP identifiers only — never promote free-text name/slug tokens.
  const keys = new Set();
  for (const key of Array.isArray(row?.ulurp_keys) ? row.ulurp_keys : []) {
    for (const token of extractUlurpKeys(String(key))) keys.add(token);
  }
  for (const token of extractUlurpKeys(String(row?.short_title || ""))) keys.add(token);
  for (const token of extractUlurpKeys(String(row?.title || ""))) keys.add(token);
  return [...keys].sort();
}

function normalizeNotices(document) {
  const rows = document?.rows || document?.notices || [];
  return rows.map((row) => ({
    request_id: String(row.request_id || ""),
    body_id: bodyIdForNotice(row),
    borough: row?.affected_area?.boroughs?.[0] || null,
    event_date: row.event_date || null,
    matter_tokens: matterTokensForNotice(row),
  })).filter((row) => row.request_id && row.body_id && row.event_date && row.matter_tokens.length);
}

function extractBinary(buffer, url) {
  const extension = extname(new URL(url).pathname).toLowerCase().slice(1);
  const kind = extension === "pdf" ? "pdf" : extension === "docx" ? "docx" : extension === "doc" ? "doc" : "unknown_high_value";
  const result = spawnSync(process.env.CITYSCROLL_WAREHOUSE_PYTHON || "python3", [EXTRACTOR, "--kind", kind], {
    input: buffer,
    encoding: "buffer",
    maxBuffer: MAX_EXTRACT_BYTES + 128_000,
  });
  if (result.status !== 0) {
    return { status: "extract_failed", reason: result.stderr?.toString("utf8").slice(0, 240) || "extractor_failed", text: "" };
  }
  try { return JSON.parse(result.stdout.toString("utf8")); }
  catch { return { status: "extract_failed", reason: "extractor_bad_json", text: "" }; }
}

async function collectLive(args, registry) {
  const checkpoint = await readJson(args.checkpoint, { completed: {} });
  const previousDocuments = new Map((await readJsonl(args.documentsJsonl)).map((row) => [row.document_id, row]));
  const sources = registry.sources.filter((row) => row.status === "collect" && row.source_url).slice(0, args.limit);
  const documents = [];
  let pageFetches = 0;
  let documentFetches = 0;
  let reused = 0;
  for (const source of sources) {
    const response = await fetchChecked(source.source_url, "text/html,application/xhtml+xml");
    const html = await response.text();
    pageFetches += 1;
    const observedAt = new Date().toISOString();
    const pageHash = hash(html);
    const indexed = parseSourceIndex(html, source, { observedAt });
    source.page_content_hash = pageHash;
    source.page_observed_at = observedAt;
    source.documents_indexed = indexed.length;
    await wait(args.delayMs);

    for (const item of indexed) {
      if (documents.length >= args.maxDocs) break;
      const completed = checkpoint.completed[item.document_id];
      const previous = previousDocuments.get(item.document_id);
      if (completed?.content_hash && previous?.content_hash === completed.content_hash) {
        documents.push(previous);
        reused += 1;
        continue;
      }
      const documentResponse = await fetchChecked(item.document_url, "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*");
      const declaredBytes = Number(documentResponse.headers.get("content-length") || 0);
      let row;
      if (declaredBytes > MAX_EXTRACT_BYTES) {
        row = { ...item, bytes: declaredBytes, content_hash: null, text_status: "skipped", text_reason: "too_large", extracted_text: null };
      } else {
        const buffer = Buffer.from(await documentResponse.arrayBuffer());
        if (buffer.byteLength > MAX_EXTRACT_BYTES) {
          row = { ...item, bytes: buffer.byteLength, content_hash: null, text_status: "skipped", text_reason: "too_large", extracted_text: null };
        } else {
          const extraction = extractBinary(buffer, item.document_url);
          row = {
            ...item,
            bytes: buffer.byteLength,
            content_hash: hash(buffer),
            text_status: extraction.status,
            text_reason: extraction.reason || null,
            text_method: extraction.method || null,
            text_chars: extraction.text?.length || 0,
            extracted_text: extraction.status === "ok" ? extraction.text : null,
          };
        }
      }
      documents.push(row);
      documentFetches += 1;
      checkpoint.completed[item.document_id] = {
        observed_at: observedAt,
        content_hash: row.content_hash,
        text_status: row.text_status,
      };
      await writeJson(args.checkpoint, checkpoint);
      await wait(args.delayMs);
    }
    checkpoint.sources ||= {};
    checkpoint.sources[source.body_id] = { observed_at: observedAt, page_content_hash: pageHash };
    await writeJson(args.checkpoint, checkpoint);
    if (documents.length >= args.maxDocs) break;
  }
  return { sources, documents, pageFetches, documentFetches, reused };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: non_council_outcomes.mjs [--from-fixture] [--limit 8] [--max-docs 25]");
    return;
  }
  const startedAt = new Date().toISOString();
  const registry = await readJson(args.registry);
  if (!registry?.sources) throw new Error("non-Council source registry is missing or invalid");
  let sources;
  let documents;
  let notices;
  let pageFetches = 0;
  let documentFetches = 0;
  let reused = 0;

  if (args.fixture) {
    const fixture = await readJson(FIXTURE);
    sources = registry.sources.filter((row) => row.status === "collect").slice(0, args.limit);
    documents = fixture.documents.slice(0, args.maxDocs);
    notices = fixture.notices;
  } else {
    const live = await collectLive(args, registry);
    ({ sources, documents, pageFetches, documentFetches, reused } = live);
    notices = normalizeNotices(await readJson(args.notices, { rows: [] }));
  }

  const fixtureStamp = "2026-08-05T12:00:00.000Z";
  const candidatePayload = materializeOutcomeLookup(notices, documents, {
    generatedAt: args.fixture ? fixtureStamp : new Date().toISOString(),
  });
  const candidateMatches = Object.values(candidatePayload.notices);
  const measurement = measureJoinBridge(notices, documents);
  const policyEnabled = registry.policy?.join_bridge_enabled === true;
  const promotion = joinBridgePromotionDecision(measurement, {
    // Registry remains the hard policy switch; both measurement bars must also clear.
    joinBridgeEnabledOverride: policyEnabled ? null : false,
  });
  const joinBridgeEnabled = policyEnabled && promotion.usefulness_ok && promotion.precision_ok;
  const payload = joinBridgeEnabled
    ? { ...candidatePayload, coverage: { ...candidatePayload.coverage, join_bridge_enabled: true } }
    : {
        ...candidatePayload,
        coverage: {
          ...candidatePayload.coverage,
          notices_matched: 0,
          match_rate: 0,
          join_bridge_enabled: false,
        },
        notices: {},
      };
  const matches = Object.values(payload.notices);
  await writeJsonl(args.sourcesJsonl, sources);
  await writeJsonl(args.documentsJsonl, documents);
  await writeJsonl(args.matchesJsonl, matches);
  await writeJson(args.payload, payload);

  const precisionReceipt = buildPrecisionReviewReceipt({
    notices,
    documents,
    observedOn: args.fixture ? "2026-08-05" : new Date().toISOString().slice(0, 10),
    joinBridgeEnabled: false, // promotion is gated; do not enable from collector alone
  });
  if (args.fixture) {
    const proofDir = resolve(REPO, "warehouse/receipts/proof");
    await writeJson(resolve(proofDir, "rc3_non_council_outcome_precision_2026-08-05.json"), precisionReceipt);
  }

  const receipt = {
    schema: "cityscroll.non_council_outcomes.collection_receipt.v1",
    run_id: args.fixture ? "non-council-fixture-deterministic" : `non-council-${randomUUID()}`,
    started_at: args.fixture ? fixtureStamp : startedAt,
    finished_at: args.fixture ? fixtureStamp : new Date().toISOString(),
    mode: args.fixture ? "fixture" : "live",
    sources_seen: sources.length,
    pages_fetched: pageFetches,
    documents_seen: documents.length,
    documents_fetched: documentFetches,
    documents_reused_from_checkpoint: reused,
    documents_with_text: documents.filter((row) => row.text_status === "ok").length,
    notices_seen: notices.length,
    notices_matched: matches.length,
    candidate_matches_with_bridge_disabled: joinBridgeEnabled ? 0 : candidateMatches.length,
    join_bridge_enabled: joinBridgeEnabled,
    join_method: JOIN_METHOD,
    candidate_measurement: measurement,
    precision_review: precisionReceipt.precision_review,
    authoritative_join_gate: {
      enabled: joinBridgeEnabled,
      policy_join_bridge_enabled: policyEnabled,
      usefulness_threshold: promotion.usefulness_threshold,
      precision_promotion_bar: promotion.precision_promotion_bar,
      usefulness_ok: promotion.usefulness_ok,
      precision_ok: promotion.precision_ok,
      reason: joinBridgeEnabled
        ? "policy_enabled_and_promotion_bars_cleared"
        : !policyEnabled
          ? "policy_join_bridge_disabled"
          : promotion.reason,
      receipt: "site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-04.json",
      precision_receipt: args.fixture
        ? "warehouse/receipts/proof/rc3_non_council_outcome_precision_2026-08-05.json"
        : null,
    },
    coverage_scope: "board_level_not_citywide",
    polite_delay_s: args.fixture ? 0 : args.delayMs / 1000,
    checkpoint: true,
    stop_on_403: true,
    user_agent: USER_AGENT,
    max_extract_bytes: MAX_EXTRACT_BYTES,
    binaries_stored: false,
    honest_absent: true,
  };
  await writeJson(args.receipt, receipt);
  console.log(JSON.stringify(receipt));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
