#!/usr/bin/env node

/**
 * Bounded host-side observations for priority sources whose primary producer is
 * the scheduled Worker. These probes acquire only a small publisher slice and
 * retain a checksum, input vintage, and explicit attempt/result clocks. A
 * repeated checksum is a successful no-change check, not a newly published
 * snapshot.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fetchLegistarEventsWindow, LEGISTAR_API_BASE } from "../worker/src/lib/legistar_client.mjs";
import {
  looksLikeBotChallenge,
  RULES_RSS_HEADERS,
  RULES_RSS_URL,
} from "../worker/src/rules.mjs";
import { resolveCredentialSource } from "./lib/credential_files.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RECEIPT_DIR = "warehouse/receipts/proof";
export const PRODUCER = "warehouse-priority-source-observer";
export const RECEIPT_SCHEMA = "cityscroll.source_acquisition_receipt.v1";
export const OBSERVER_PROVENANCE_SCHEMA = "cityscroll.priority_source_observation_provenance.v1";
export const MAX_RULES_BYTES = 2 * 1024 * 1024;

const SOURCES = Object.freeze({
  "nyc-council-legistar": {
    file: "priority_source_nyc_council_legistar_latest.json",
    source_url: `${LEGISTAR_API_BASE}/Events`,
    bounds: { endpoint: "Events", page_size: 1, max_pages: 1, lookback_days: 180 },
  },
  "nyc-rules-rss": {
    file: "priority_source_nyc_rules_rss_latest.json",
    source_url: RULES_RSS_URL,
    bounds: { endpoint: RULES_RSS_URL, max_bytes: MAX_RULES_BYTES },
  },
});

function validAt(value) {
  const epoch = Date.parse(String(value || ""));
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function readPrevious(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function tokenFromEnvironment(env = process.env) {
  const resolution = resolveCredentialSource({
    fileVars: ["LEGISTAR_API_TOKEN_FILE"],
    inlineVars: ["LEGISTAR_API_TOKEN"],
    env,
    requireOwnerOnly: true,
  });
  return resolution.value || null;
}

function provenance({ source, observedAt, response }) {
  return {
    schema: OBSERVER_PROVENANCE_SCHEMA,
    evidence_class: "scheduled-rail",
    isolated: false,
    observed_at: observedAt,
    producer: PRODUCER,
    source: source.source_url,
    bounds: source.bounds,
    response,
  };
}

function receipt({ sourceId, source, attemptAt, resultAt, status, eventKind, inputVintage, contentHash, response, error }) {
  const row = {
    schema: RECEIPT_SCHEMA,
    source_contract_id: sourceId,
    source_url: source.source_url,
    attempt_at: attemptAt,
    result_at: resultAt,
    observed_at: resultAt,
    status,
    run_id: `${PRODUCER}:${sourceId}:${resultAt}`,
    producer: PRODUCER,
    adapter: PRODUCER,
    publisher_clock_basis: null,
    publisher_updated_at: null,
    clock_kind: eventKind === "successful-no-change-check" ? "check" : "acquisition",
    event_kind: eventKind,
    input_vintage: inputVintage,
    ...(contentHash ? { content_hash: `sha256:${contentHash}` } : {}),
    provenance: provenance({
      source,
      observedAt: resultAt,
      response: { ...response, content_sha256: contentHash ? `sha256:${contentHash}` : null },
    }),
    ...(error ? { exact_error: String(error) } : {}),
  };
  return row;
}

function responseHeader(response, name) {
  return validAt(response?.headers?.get?.(name)) || null;
}

async function readRulesResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RULES_BYTES) {
    throw new Error("NYC Rules RSS response exceeded bounded byte limit");
  }
  if (looksLikeBotChallenge(text)) throw new Error("NYC Rules RSS returned a bot challenge");
  if (!/<rss[\s>]/i.test(text) || !/<item[\s>]/i.test(text)) {
    throw new Error("NYC Rules RSS response is not a feed with items");
  }
  return text;
}

async function observeLegistar({ now, clock, fetchImpl, token, previous, source }) {
  const attemptAt = validAt(now);
  let response;
  try {
    response = await fetchLegistarEventsWindow({
      token,
      fetchImpl,
      now: new Date(attemptAt),
      pageSize: 1,
      maxPages: 1,
    });
    const resultAt = validAt(clock());
    if (!response.ok) {
      return receipt({
        sourceId: "nyc-council-legistar", source, attemptAt, resultAt,
        status: "failed", eventKind: "failed-check", inputVintage: previous?.input_vintage || null,
        contentHash: null, response: { status: response.status, kind: response.kind, row_count: 0 },
        error: `Legistar observation failed (${response.kind})`,
      });
    }
    const contentHash = hash(stableJson(response.rows));
    const unchanged = previous?.content_hash === `sha256:${contentHash}`;
    const inputVintage = unchanged && previous.input_vintage
      ? previous.input_vintage
      : responseHeader(response, "last-modified") || resultAt;
    return receipt({
      sourceId: "nyc-council-legistar", source, attemptAt, resultAt,
      status: "succeeded",
      eventKind: unchanged ? "successful-no-change-check" : "bounded-acquisition",
      inputVintage,
      contentHash,
      response: { status: response.status, kind: response.kind, row_count: response.rows.length, complete: response.complete },
    });
  } catch (error) {
    const resultAt = validAt(clock());
    return receipt({
      sourceId: "nyc-council-legistar", source, attemptAt, resultAt,
      status: "failed", eventKind: "failed-check", inputVintage: previous?.input_vintage || null,
      contentHash: null, response: { status: response?.status || null, row_count: 0 }, error: error?.message || error,
    });
  }
}

async function observeRules({ now, clock, fetchImpl, previous, source }) {
  const attemptAt = validAt(now);
  let response;
  try {
    response = await fetchImpl(RULES_RSS_URL, {
      headers: { ...RULES_RSS_HEADERS },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await readRulesResponse(response);
    if (!response.ok) throw new Error(`NYC Rules RSS HTTP ${response.status}`);
    const resultAt = validAt(clock());
    const contentHash = hash(text);
    const unchanged = previous?.content_hash === `sha256:${contentHash}`;
    const inputVintage = unchanged && previous.input_vintage
      ? previous.input_vintage
      : responseHeader(response, "last-modified") || resultAt;
    return receipt({
      sourceId: "nyc-rules-rss", source, attemptAt, resultAt,
      status: "succeeded",
      eventKind: unchanged ? "successful-no-change-check" : "bounded-acquisition",
      inputVintage,
      contentHash,
      response: { status: response.status, row_count: (text.match(/<item[\s>]/gi) || []).length },
    });
  } catch (error) {
    const resultAt = validAt(clock());
    return receipt({
      sourceId: "nyc-rules-rss", source, attemptAt, resultAt,
      status: "failed", eventKind: "failed-check", inputVintage: previous?.input_vintage || null,
      contentHash: null, response: { status: response?.status || null, row_count: 0 }, error: error?.message || error,
    });
  }
}

export async function runPrioritySourceObservations({
  now = new Date().toISOString(),
  clock = () => new Date().toISOString(),
  fetchImpl = fetch,
  token = tokenFromEnvironment(),
  receiptDir = join(ROOT, RECEIPT_DIR),
  sourceIds = Object.keys(SOURCES),
} = {}) {
  mkdirSync(receiptDir, { recursive: true });
  const results = [];
  for (const sourceId of sourceIds) {
    const source = SOURCES[sourceId];
    if (!source) throw new Error(`unknown priority observation source: ${sourceId}`);
    const path = join(receiptDir, source.file);
    const previous = readPrevious(path);
    const result = sourceId === "nyc-council-legistar"
      ? await observeLegistar({ now, clock, fetchImpl, token, previous, source })
      : await observeRules({ now, clock, fetchImpl, previous, source });
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    results.push({ source_id: sourceId, status: result.status, receipt: path });
  }
  return results;
}

function parseArgs(argv) {
  const args = { bounded: false, sourceIds: Object.keys(SOURCES) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bounded") args.bounded = true;
    else if (arg === "--source") args.sourceIds = [argv[++index]];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: node tools/priority_source_observation_producers.mjs --bounded [--source <source-id>]");
    return;
  }
  if (!args.bounded) throw new Error("refusing to run without --bounded");
  const results = await runPrioritySourceObservations({ sourceIds: args.sourceIds });
  console.log(JSON.stringify(results.map(({ source_id, status }) => ({ source_id, status }))));
  if (results.some((row) => row.status === "failed")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
