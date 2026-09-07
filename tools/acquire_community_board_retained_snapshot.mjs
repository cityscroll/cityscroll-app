#!/usr/bin/env node

/**
 * Acquire a retained snapshot for a community-board source that the board's own
 * site does not serve to a program.
 *
 * Some boards publish their calendar and minutes only behind an interactive
 * bot check. The board source inventory already records that constraint as
 * `fetch_mode: browser-required`, and the meeting index therefore leaves those
 * roles unread. This tool closes that gap without inventing a publisher: it
 * resolves an immutable public capture of the board's own page, retains the
 * source records the existing adapter reads out of it, and stamps the capture
 * time as the observation date so every downstream field can say when the
 * record was seen.
 *
 * The tool is an acquisition operation, not a read path. The meeting index and
 * every public read consume the committed artifact this writes; neither
 * contacts the archive or the board.
 *
 *   node tools/acquire_community_board_retained_snapshot.mjs --board manhattan-cb-05
 *   node tools/acquire_community_board_retained_snapshot.mjs --check
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeObservedReceipt,
  parseHtmlPdfSource,
  communityBoardSourceAdapterId,
} from "../site/community_board_source_adapters.mjs";

const ROOT = join(import.meta.dirname, "..");
const INVENTORY = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const COMMITTEE_REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/community_board_committees.json");
export const RETAINED_SNAPSHOT_DIR = join(ROOT, "site/data/non_council_outcome_sources/retained_snapshots");
export const RETAINED_SNAPSHOT_SCHEMA = "cityscroll.community_board_retained_snapshot.v1";
export const RETAINED_SNAPSHOT_ROLES = Object.freeze(["upcoming_meetings", "minutes"]);
const ARCHIVE_SERVICE = Object.freeze({
  id: "public_web_archive",
  name: "Internet Archive Wayback Machine",
  index_url: "https://web.archive.org/cdx/search/cdx",
  home_url: "https://web.archive.org/",
});
const SUPPORTED_ADAPTERS = new Set(["html_pdf_v1", "html_document_index_v1"]);

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

export function retainedSnapshotFileName(boardId, role) {
  return `${boardId}.${role}.json`;
}

/** Read every committed retained snapshot, keyed by `<board_id>:<role>`. */
export function readRetainedCommunityBoardSnapshots(directory = RETAINED_SNAPSHOT_DIR) {
  const snapshots = new Map();
  if (!existsSync(directory)) return snapshots;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const snapshot = readJson(join(directory, entry.name));
    if (snapshot?.schema !== RETAINED_SNAPSHOT_SCHEMA) continue;
    snapshots.set(`${snapshot.board_id}:${snapshot.source_role}`, snapshot);
  }
  return snapshots;
}

function captureTimestampToIso(timestamp) {
  const match = String(timestamp || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

async function resolveLatestCapture(sourceUrl, fetchImpl) {
  const url = new URL(ARCHIVE_SERVICE.index_url);
  url.searchParams.set("url", sourceUrl);
  url.searchParams.set("output", "json");
  url.searchParams.set("filter", "statuscode:200");
  url.searchParams.set("fl", "timestamp,original,digest,mimetype");
  url.searchParams.set("limit", "-1");
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`capture index HTTP ${response.status} for ${sourceUrl}`);
  const rows = await response.json();
  const body = Array.isArray(rows) ? rows.slice(1) : [];
  const latest = body.at(-1);
  if (!latest) return null;
  const capturedAt = captureTimestampToIso(latest[0]);
  if (!capturedAt) return null;
  return {
    timestamp: latest[0],
    captured_at: capturedAt,
    snapshot_url: `https://web.archive.org/web/${latest[0]}id_/${sourceUrl}`,
  };
}

async function fetchSnapshotText(snapshotUrl, fetchImpl) {
  const response = await fetchImpl(snapshotUrl, {
    redirect: "follow",
    headers: { "Accept-Encoding": "identity", Accept: "text/html,*/*" },
  });
  if (!response.ok) throw new Error(`retained snapshot HTTP ${response.status} for ${snapshotUrl}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    text: new TextDecoder().decode(bytes),
    content_length: bytes.byteLength,
    content_sha256: createHash("sha256").update(bytes).digest("hex"),
    content_type: response.headers?.get?.("content-type") || null,
  };
}

function descriptorFor(board, role) {
  const source = role === "minutes" ? board.minutes : board.upcoming;
  if (!source?.url) return null;
  return {
    ...source,
    role,
    source_role: role,
    board_id: board.id,
    body_id: board.id,
    body_name: board.name,
  };
}

/**
 * Build one retained snapshot record set from already-fetched bytes.
 *
 * Separated from the network so the shape stays testable and so the artifact
 * is a pure function of the capture it names.
 */
export function buildRetainedCommunityBoardSnapshot({
  board,
  role,
  descriptor,
  capture,
  payload,
  committeeRegistry = {},
  acquiredAt,
}) {
  const adapter = communityBoardSourceAdapterId(descriptor) || "html_pdf_v1";
  const receipt = normalizeObservedReceipt({
    observed_at: capture.captured_at,
    status: "ok",
    fetch_status: "200",
    content_type: payload.content_type,
    content_length: payload.content_length,
    parser: adapter,
  }, descriptor);
  const sourceRecords = parseHtmlPdfSource(payload.text, {
    ...descriptor,
    adapter,
    observed_receipt: receipt,
  }, { committeeRegistry, observedAt: capture.captured_at, receipt })
    .map((record) => ({
      ...record,
      source_role: role,
      source_url: record.source_url || descriptor.url,
      observed_receipt: receipt,
    }));
  return {
    schema: RETAINED_SNAPSHOT_SCHEMA,
    board_id: board.id,
    board_name: board.name,
    borough: board.borough,
    source_role: role,
    publisher: descriptor.publisher || board.name,
    publisher_kind: descriptor.publisher_kind || null,
    source_url: descriptor.url,
    access_constraint: descriptor.access_constraint || descriptor.fetch_mode || null,
    retention_reason: "the publisher serves this page only to an interactive browser session",
    adapter,
    retention: {
      service: ARCHIVE_SERVICE.id,
      service_name: ARCHIVE_SERVICE.name,
      service_url: ARCHIVE_SERVICE.home_url,
      snapshot_url: capture.snapshot_url,
      captured_at: capture.captured_at,
      acquired_at: acquiredAt,
      content_type: payload.content_type,
      content_length: payload.content_length,
      content_sha256: payload.content_sha256,
    },
    observed_receipt: receipt,
    record_count: sourceRecords.length,
    event_record_count: sourceRecords.filter((record) => record.record_kind === "event").length,
    document_record_count: sourceRecords.filter((record) => record.record_kind === "document").length,
    source_records: sourceRecords,
  };
}

/** Validate one committed snapshot without contacting any publisher. */
export function checkRetainedCommunityBoardSnapshot(snapshot) {
  const problems = [];
  const label = `${snapshot?.board_id || "unknown"}:${snapshot?.source_role || "unknown"}`;
  if (snapshot?.schema !== RETAINED_SNAPSHOT_SCHEMA) problems.push(`${label} has an unexpected schema`);
  if (!RETAINED_SNAPSHOT_ROLES.includes(snapshot?.source_role)) problems.push(`${label} has an unexpected source role`);
  if (!snapshot?.source_url) problems.push(`${label} does not name the publisher page it retains`);
  const retention = snapshot?.retention || {};
  if (!retention.snapshot_url) problems.push(`${label} does not name the retained capture`);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(retention.captured_at || ""))) problems.push(`${label} has no capture time`);
  if (!/^[0-9a-f]{64}$/.test(String(retention.content_sha256 || ""))) problems.push(`${label} has no capture digest`);
  if (snapshot?.observed_receipt?.observed_at !== retention.captured_at) {
    problems.push(`${label} observes a different time from the capture it retains`);
  }
  const records = Array.isArray(snapshot?.source_records) ? snapshot.source_records : [];
  if (records.length !== snapshot?.record_count) problems.push(`${label} miscounts its retained records`);
  for (const record of records) {
    if (record.board_id !== snapshot.board_id) problems.push(`${label} retains a record for another board`);
    if (!record.record_id || !record.date) problems.push(`${label} retains a record without an identifier and date`);
    if (record.observed_receipt?.observed_at !== retention.captured_at) {
      problems.push(`${label} retains a record observed outside its capture`);
    }
  }
  return problems;
}

export async function acquireRetainedCommunityBoardSnapshots({
  boardIds = [],
  roles = RETAINED_SNAPSHOT_ROLES,
  fetchImpl = fetch,
  acquiredAt = new Date().toISOString(),
} = {}) {
  const inventory = readJson(INVENTORY);
  const committeeRegistry = readJson(COMMITTEE_REGISTRY);
  const selected = (inventory.boards || []).filter((board) => boardIds.includes(board.id));
  const written = [];
  const skipped = [];
  for (const board of selected) {
    for (const role of roles) {
      const descriptor = descriptorFor(board, role);
      if (!descriptor) {
        skipped.push({ board_id: board.id, role, reason: "no_explicit_source_url" });
        continue;
      }
      const adapter = communityBoardSourceAdapterId(descriptor);
      if (!SUPPORTED_ADAPTERS.has(String(adapter || "html_pdf_v1"))) {
        skipped.push({ board_id: board.id, role, reason: `unsupported_adapter:${adapter}` });
        continue;
      }
      const capture = await resolveLatestCapture(descriptor.url, fetchImpl);
      if (!capture) {
        skipped.push({ board_id: board.id, role, reason: "no_public_capture" });
        continue;
      }
      const payload = await fetchSnapshotText(capture.snapshot_url, fetchImpl);
      const snapshot = buildRetainedCommunityBoardSnapshot({
        board, role, descriptor, capture, payload, committeeRegistry, acquiredAt,
      });
      if (!snapshot.record_count) {
        skipped.push({ board_id: board.id, role, reason: "capture_holds_no_explicit_records" });
        continue;
      }
      mkdirSync(RETAINED_SNAPSHOT_DIR, { recursive: true });
      writeJson(join(RETAINED_SNAPSHOT_DIR, retainedSnapshotFileName(board.id, role)), snapshot);
      written.push(snapshot);
    }
  }
  return { written, skipped };
}

function flagValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--check")) {
    const snapshots = [...readRetainedCommunityBoardSnapshots().values()];
    const problems = snapshots.flatMap((snapshot) => checkRetainedCommunityBoardSnapshot(snapshot));
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(`checked ${snapshots.length} retained community board snapshots`);
  } else {
    const boardIds = flagValues(process.argv, "--board");
    if (!boardIds.length) throw new Error("name at least one board with --board <board_id>");
    const roles = flagValues(process.argv, "--role");
    const result = await acquireRetainedCommunityBoardSnapshots({
      boardIds,
      roles: roles.length ? roles : RETAINED_SNAPSHOT_ROLES,
    });
    for (const snapshot of result.written) {
      console.log(`retained ${snapshot.board_id} ${snapshot.source_role}: ${snapshot.record_count} records captured ${snapshot.retention.captured_at}`);
    }
    for (const skip of result.skipped) console.log(`skipped ${skip.board_id} ${skip.role}: ${skip.reason}`);
  }
}
