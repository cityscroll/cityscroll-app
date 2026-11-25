#!/usr/bin/env node
/**
 * Read-only measure of the public file list on open City Record solicitations.
 *
 * Fetches the public open list, the public PASSPort RFx dump, and the Navigator
 * page for each round that already matches on PIN, title and dates. For each
 * listed file it reads the body up to the published byte cap and, for a PDF,
 * counts pages with pdfinfo. A file over the cap is listed and not read.
 * One request at a time, with a pause between them. Bodies are not retained.
 *
 * Offline: --notices <json> --rfx <dump-or-json> --navigator-dir <dir of rfp_id.html>
 *
 * --out writes the artifact; the measurement summary (counts, samples and the
 * fetch log) is written beside it unless --summary-out names another path, so
 * a scheduled publisher can keep the request log in ignored scratch space
 * instead of the served tree.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PASSPORT_FETCH_HEADERS } from "../worker/src/passport.mjs";
import { RFX_DATA_URL, parseRfxDump } from "../worker/src/lib/passport_parse.mjs";
import { MAX_DOCUMENT_BYTES, navigatorUrlForRfpId } from "../warehouse/lib/navigator_rfx_documents.mjs";
import { buildOpenNoticeDocumentListings } from "./lib/open_notice_document_listing.mjs";

const OPEN_LIST_URL = "https://cityscroll.org/data/money_open_solicitations.json";
const PAUSE_MS = 1200;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, headers) {
  const response = await fetch(url, { redirect: "manual", headers });
  const text = await response.text();
  return { status: response.status, text, bytes: Buffer.byteLength(text) };
}

function loadRfx(file) {
  const text = readFileSync(file, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.rows;
  }
  return parseRfxDump(text);
}

function pdfPageCount(bytes) {
  const result = spawnSync("pdfinfo", ["-"], { input: bytes });
  if (result.status !== 0) return null;
  const match = Buffer.from(result.stdout || "").toString("utf8").match(/^Pages:\s+(\d+)/m);
  return match ? Number(match[1]) : null;
}

function filenameFromDisposition(value) {
  const match = String(value || "").match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/i);
  return match ? decodeURIComponent(match[1].replace(/"/g, "")) : null;
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, oversize: bytes.length > MAX_DOCUMENT_BYTES };
  }
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    length += chunk.length;
    if (length > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return { bytes: null, oversize: true };
    }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks, length), oversize: false };
}

async function observeListedFiles(artifact, log) {
  const observations = {};
  const files = [];
  for (const entry of artifact.notices) {
    for (const file of entry.coverage.documents_listed.data.files || []) {
      if (Object.prototype.hasOwnProperty.call(observations, file.document_id)) continue;
      observations[file.document_id] = null;
      files.push(file);
    }
  }
  for (const file of files) {
    await sleep(PAUSE_MS);
    process.stderr.write(`observe ${file.document_id}\n`);
    const head = await fetch(file.official_url, { method: "HEAD", redirect: "manual", headers: PASSPORT_FETCH_HEADERS });
    const declared = Number.parseInt(head.headers.get("content-length") || "", 10);
    const observation = {
      size_bytes: Number.isInteger(declared) && declared >= 0 ? declared : null,
      content_type: head.headers.get("content-type"),
      filename: filenameFromDisposition(head.headers.get("content-disposition")),
    };
    log.push({
      at: new Date().toISOString(), url: file.official_url, method: "HEAD", status: head.status,
      bytes: observation.size_bytes,
    });
    const declaredOversize = Number.isInteger(declared) && declared > MAX_DOCUMENT_BYTES;
    if (head.status === 200 && !declaredOversize) {
      const body = await fetch(file.official_url, { redirect: "manual", headers: PASSPORT_FETCH_HEADERS });
      if (body.status === 200) {
        const read = await readBounded(body);
        log.push({
          at: new Date().toISOString(), url: file.official_url, method: "GET", status: body.status,
          bytes: read.bytes?.length ?? null, oversize: read.oversize,
        });
        if (read.oversize) {
          observation.oversize = true;
          observation.size_bytes = Number.isInteger(declared) ? declared : null;
        } else if (read.bytes) {
          observation.size_bytes = read.bytes.length;
          if (read.bytes.subarray(0, 5).toString() === "%PDF-") observation.page_count = pdfPageCount(read.bytes);
        }
      } else {
        log.push({ at: new Date().toISOString(), url: file.official_url, method: "GET", status: body.status, bytes: null });
      }
    } else if (declaredOversize) {
      observation.oversize = true;
    }
    observations[file.document_id] = observation;
  }
  return observations;
}

function loadNavigatorDir(dir) {
  const pages = {};
  if (!dir) return pages;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".html")) continue;
    pages[name.slice(0, -".html".length)] = readFileSync(path.join(dir, name), "utf8");
  }
  return pages;
}

async function main() {
  const out = arg("--out");
  const noticesPath = arg("--notices");
  const rfxPath = arg("--rfx");
  const navigatorDir = arg("--navigator-dir");
  const log = [];
  let noticesDoc;
  let rows;
  let rfxFailure = null;
  if (noticesPath && rfxPath) {
    noticesDoc = JSON.parse(readFileSync(noticesPath, "utf8"));
    rows = loadRfx(rfxPath);
  } else {
    const open = await fetchText(OPEN_LIST_URL);
    log.push({ at: new Date().toISOString(), url: OPEN_LIST_URL, status: open.status, bytes: open.bytes });
    if (open.status !== 200) throw new Error(`open list HTTP ${open.status}`);
    noticesDoc = JSON.parse(open.text);
    const rfx = await fetchText(RFX_DATA_URL, PASSPORT_FETCH_HEADERS);
    log.push({ at: new Date().toISOString(), url: RFX_DATA_URL, status: rfx.status, bytes: rfx.bytes });
    if (rfx.status !== 200) rfxFailure = `rfx-http-${rfx.status}`;
    else rows = parseRfxDump(rfx.text);
  }
  const notices = noticesDoc.notices || [];
  const asOf = noticesDoc.open_as_of;
  const pages = loadNavigatorDir(navigatorDir);
  if (!rfxPath) {
    const preview = buildOpenNoticeDocumentListings({
      notices,
      rfxRows: rows || [],
      navigatorByRfpId: {},
      asOf,
      rfxFailure,
    });
    const wanted = new Set();
    for (const entry of preview.notices) {
      const record = entry.coverage.documents_listed;
      if (record.data.reason_code === "navigator_not_observed" && record.data.rfp_id) wanted.add(record.data.rfp_id);
    }
    let first = true;
    for (const rfpId of [...wanted].sort()) {
      if (!first) await sleep(PAUSE_MS);
      first = false;
      const url = navigatorUrlForRfpId(rfpId);
      const result = await fetchText(url, PASSPORT_FETCH_HEADERS);
      log.push({ at: new Date().toISOString(), url, status: result.status, bytes: result.bytes });
      pages[rfpId] = result.status === 200 ? result.text : { ok: false, failure: `navigator-http-${result.status}` };
    }
  }
  const listed = buildOpenNoticeDocumentListings({
    notices,
    rfxRows: rows || [],
    navigatorByRfpId: pages,
    asOf,
    observedAt: new Date().toISOString(),
    rfxFailure,
  });
  const fileObservations = rfxPath ? {} : await observeListedFiles(listed, log);
  const artifact = buildOpenNoticeDocumentListings({
    notices,
    rfxRows: rows || [],
    navigatorByRfpId: pages,
    fileObservations,
    asOf,
    observedAt: listed.observed_at,
    rfxFailure,
  });
  const summary = {
    schema: artifact.schema,
    state: artifact.state,
    as_of: artifact.as_of,
    observed_at: artifact.observed_at,
    open_notice_generated_at: noticesDoc.generated_at || null,
    rfx_rows: rows?.length ?? 0,
    coverage: artifact.documents_listed_coverage,
    samples: {},
    fetch_log: log,
  };
  for (const entry of artifact.notices) {
    const code = entry.coverage.documents_listed.state === "available"
      ? "available"
      : entry.coverage.documents_listed.data.reason_code;
    summary.samples[code] = summary.samples[code] || [];
    if (summary.samples[code].length >= 5) continue;
    summary.samples[code].push({
      request_id: entry.request_id,
      rfp_id: entry.coverage.documents_listed.data.rfp_id,
      file_count: entry.coverage.documents_listed.data.file_count || 0,
      file_names: (entry.coverage.documents_listed.data.files || []).slice(0, 3).map((file) => file.name),
    });
  }
  const text = JSON.stringify(out ? artifact : summary, null, 1) + "\n";
  if (out) {
    const summaryOut = arg("--summary-out") || `${out}.summary.json`;
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(artifact));
    mkdirSync(path.dirname(path.resolve(summaryOut)), { recursive: true });
    writeFileSync(summaryOut, JSON.stringify(summary, null, 1) + "\n");
    process.stdout.write(`${summary.state} available ${summary.coverage.available} of ${summary.coverage.open_notices}\n`);
  } else {
    process.stdout.write(text);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
