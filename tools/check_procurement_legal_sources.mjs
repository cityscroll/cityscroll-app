#!/usr/bin/env node
// Re-check the register's retained legal source sections against the BetaNYC mirror.
//
// Prototype location: imports "./source_watch.mjs". In cityscroll-app this lands as
// tools/check_procurement_legal_sources.mjs and the import becomes
// "../ontology/procurement_legal_source_watch.mjs"; the register and targets default to
// ontology/procurement_legal_register.v1.json and ontology/procurement_legal_source_targets.v1.json.
//
// Acquisition (see acquisition-observations.json): per aggregate file one HEAD (ETag gate), then a
// bounded Range request around the last-known byte offset of each section; only if the section heading
// is not inside the window does it fall back to one capped full stream. Fetching is injected so tests
// never touch the network. The register is only read. Failures never touch the last-good state.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSourceCaptures, normalizeCapture } from "../ontology/procurement_legal_source_watch.mjs";

export const HOST_ALLOWLIST = Object.freeze(["raw.githubusercontent.com"]);
export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 20_000,
  windowMaxBytes: 1_048_576,
  windowPadBytes: 131_072,
  fullMaxBytes: 41_943_040,
  maxRedirects: 3,
  attempts: 2,
});
/** 0 clean; 2 usage/config error; 3 changes found; 4 could not check; 5 both. */
export const EXIT = Object.freeze({ CLEAN: 0, USAGE: 2, CHANGES: 3, COULD_NOT_CHECK: 4, BOTH: 5 });

export function exitCodeFor(receipt) {
  if (receipt.changes_found && receipt.could_not_check) return EXIT.BOTH;
  if (receipt.changes_found) return EXIT.CHANGES;
  if (receipt.could_not_check) return EXIT.COULD_NOT_CHECK;
  return EXIT.CLEAN;
}

class AcquireError extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

async function readCapped(response, cap, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new AcquireError("oversize", response.status);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new AcquireError("timeout", response.status);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        throw new AcquireError("oversize", response.status);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released by cancel */ }
  }
  return Buffer.concat(chunks);
}

/** One bounded request: allowlisted hosts only, manual bounded redirects, timeout, byte cap. */
async function boundedRequest(fetchImpl, url, { method = "GET", headers = {}, cap, limits }) {
  let current = url;
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || !HOST_ALLOWLIST.includes(parsed.hostname)) throw new AcquireError("host_not_allowed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      const response = await fetchImpl(current, { method, headers, redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new AcquireError("redirect_without_location", response.status);
        current = new URL(location, current).toString();
        continue;
      }
      const body = method === "HEAD" ? Buffer.alloc(0) : await readCapped(response, cap, controller.signal);
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (error instanceof AcquireError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") throw new AcquireError("timeout");
      throw new AcquireError("network_error");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AcquireError("too_many_redirects");
}

async function withRetry(fn, limits) {
  let last;
  for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
    try {
      const result = await fn();
      if (result.status >= 500 && attempt < limits.attempts) { last = new AcquireError(`http_${result.status}`, result.status); continue; }
      return result;
    } catch (error) {
      last = error;
      const transient = error instanceof AcquireError && ["timeout", "network_error"].includes(error.reason);
      if (!transient || attempt === limits.attempts) throw error;
    }
  }
  throw last;
}

/** Find the section starting at `heading` inside buffer; returns {text, offsetInBuffer} or a miss reason. */
export function extractSection(buffer, heading, { atStart, atEof }) {
  const needle = Buffer.from(`\n${heading}\n`);
  let found = buffer.indexOf(needle);
  let startIndex;
  if (found === -1 && atStart && buffer.subarray(0, heading.length + 1).equals(Buffer.from(`${heading}\n`))) {
    startIndex = 0;
  } else if (found === -1) {
    return { miss: "heading_not_in_window" };
  } else {
    if (buffer.indexOf(needle, found + 1) !== -1) return { miss: "ambiguous_heading" };
    startIndex = found + 1;
  }
  const delimiter = Buffer.from("\n---\n\n## ");
  const end = buffer.indexOf(delimiter, startIndex);
  if (end !== -1) return { text: buffer.subarray(startIndex, end + 5).toString("utf8"), offsetInBuffer: startIndex };
  if (atEof) return { text: buffer.subarray(startIndex).toString("utf8"), offsetInBuffer: startIndex };
  return { miss: "section_end_not_in_window" };
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function groupWindows(items, size, limits) {
  const sorted = [...items].sort((a, b) => a.hint - b.hint);
  const windows = [];
  for (const item of sorted) {
    const start = Math.max(0, item.hint - limits.windowPadBytes);
    const end = Math.min(size - 1, item.hint + item.bytes + limits.windowPadBytes);
    const last = windows[windows.length - 1];
    if (last && Math.max(last.end, end) - last.start + 1 <= limits.windowMaxBytes) {
      last.end = Math.max(last.end, end);
      last.items.push(item);
    } else {
      windows.push({ start, end, items: [item] });
    }
  }
  return windows;
}

/**
 * Observe every target. Returns { observations, acquisition, stateWrites }. Never throws for a
 * per-source failure: it becomes a fetched:false observation.
 */
export async function observeTargets({ targets, fetchImpl, state, limits = DEFAULT_LIMITS, stateDir = null }) {
  const observations = [];
  const acquisition = {};
  const stateUpdates = [];
  const byAggregate = new Map();
  for (const target of targets.targets) {
    if (!byAggregate.has(target.aggregate)) byAggregate.set(target.aggregate, []);
    byAggregate.get(target.aggregate).push(target);
  }
  const failAll = (items, reason, status = null) => {
    for (const target of items) {
      observations.push({ source_file: target.source_file, fetched: false, status, reason });
      acquisition[target.source_file] = { method: "none", reason };
    }
  };

  for (const [aggregate, items] of byAggregate) {
    const url = `${targets.mirror.raw_base}${aggregate}`;
    let head;
    try {
      head = await withRetry(() => boundedRequest(fetchImpl, url, { method: "HEAD", cap: 0, limits }), limits);
    } catch (error) {
      failAll(items, error.reason || "network_error", error.status ?? null);
      continue;
    }
    if (head.status !== 200) { failAll(items, `http_${head.status}`, head.status); continue; }
    const etag = head.headers.get("etag");
    const size = Number(head.headers.get("content-length"));
    const need = [];
    for (const target of items) {
      const prior = state.index[target.source_file];
      const cachedPath = stateDir ? join(stateDir, "observed", target.source_file) : null;
      if (etag && prior?.aggregate_etag === etag && cachedPath && existsSync(cachedPath)) {
        observations.push({ source_file: target.source_file, fetched: true, status: 200, text: readFileSync(cachedPath, "utf8") });
        acquisition[target.source_file] = { method: "cache", aggregate_etag: etag, bytes_fetched: 0 };
      } else {
        need.push({ target, hint: prior?.hint_offset ?? target.hint_offset, bytes: prior?.bytes ?? target.expected_bytes });
      }
    }
    if (need.length === 0) continue;
    if (!Number.isFinite(size) || size <= 0) { failAll(need.map((n) => n.target), "no_content_length"); continue; }

    const pending = new Map(need.map((n) => [n.target.source_file, n]));
    let bytesFetched = 0;
    const record = (item, extracted, base, method) => {
      const file = item.target.source_file;
      observations.push({ source_file: file, fetched: true, status: 200, text: extracted.text });
      acquisition[file] = { method, aggregate_etag: etag, bytes_fetched: bytesFetched };
      stateUpdates.push({ file, text: extracted.text, aggregate_etag: etag, hint_offset: base + extracted.offsetInBuffer, bytes: Buffer.byteLength(extracted.text) });
      pending.delete(file);
    };

    for (const window of groupWindows(need, size, limits)) {
      let response;
      try {
        response = await withRetry(() => boundedRequest(fetchImpl, url, {
          headers: { Range: `bytes=${window.start}-${window.end}`, "Accept-Encoding": "identity" },
          cap: limits.windowMaxBytes + 1,
          limits,
        }), limits);
      } catch (error) {
        for (const item of window.items) {
          if (!pending.has(item.target.source_file)) continue;
          pending.delete(item.target.source_file);
          observations.push({ source_file: item.target.source_file, fetched: false, status: error.status ?? null, reason: error.reason || "network_error" });
          acquisition[item.target.source_file] = { method: "none", reason: error.reason || "network_error" };
        }
        continue;
      }
      if (response.status !== 206 && response.status !== 200) {
        for (const item of window.items) {
          pending.delete(item.target.source_file);
          observations.push({ source_file: item.target.source_file, fetched: false, status: response.status, reason: `http_${response.status}` });
          acquisition[item.target.source_file] = { method: "none", reason: `http_${response.status}` };
        }
        continue;
      }
      bytesFetched += response.body.length;
      const base = response.status === 206 ? window.start : 0;
      for (const item of window.items) {
        const extracted = extractSection(response.body, item.target.heading, {
          atStart: base === 0,
          atEof: base + response.body.length >= size,
        });
        if (extracted.text !== undefined) record(item, extracted, base, "range");
      }
    }

    if (pending.size > 0) {
      // Fallback: one capped full stream for whatever the windows could not place.
      let full;
      try {
        full = await withRetry(() => boundedRequest(fetchImpl, url, {
          headers: { "Accept-Encoding": "identity" }, cap: limits.fullMaxBytes, limits,
        }), limits);
      } catch (error) {
        for (const [file] of pending) {
          observations.push({ source_file: file, fetched: false, status: error.status ?? null, reason: error.reason || "network_error" });
          acquisition[file] = { method: "none", reason: error.reason || "network_error" };
        }
        continue;
      }
      bytesFetched += full.body.length;
      for (const [file, item] of [...pending]) {
        const extracted = extractSection(full.body, item.target.heading, { atStart: true, atEof: true });
        if (extracted.text !== undefined) {
          record(item, extracted, 0, "full_stream");
        } else {
          pending.delete(file);
          observations.push({ source_file: file, fetched: false, status: full.status, reason: extracted.miss });
          acquisition[file] = { method: "full_stream", reason: extracted.miss };
        }
      }
    }
  }
  return { observations, acquisition, stateUpdates };
}

/** Run the whole watch. Reads the register/targets, observes, compares, writes state and receipt. */
export async function runSourceWatch({ register, targets, fetchImpl, stateDir, now = new Date(), limits = {} }) {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const state = stateDir ? readJson(join(stateDir, "index.json"), { index: {} }) : { index: {} };
  state.index ||= {};
  const { observations, acquisition, stateUpdates } = await observeTargets({ targets, fetchImpl, state, limits: merged, stateDir });
  const receipt = compareSourceCaptures(register, observations, { checkedAt: now.toISOString() });
  receipt.acquisition = acquisition;
  receipt.limits = { ...merged, host_allowlist: [...HOST_ALLOWLIST] };

  if (stateDir) {
    // State is written only for sources that were actually observed; a failure leaves it untouched.
    const statusByFile = new Map(receipt.sources.map((row) => [row.source_file, row.status]));
    for (const update of stateUpdates) {
      const normalized = normalizeCapture(update.text);
      atomicWrite(join(stateDir, "observed", update.file), normalized);
      if (statusByFile.get(update.file) === "unchanged") atomicWrite(join(stateDir, "last-good", update.file), normalized);
      state.index[update.file] = {
        aggregate_etag: update.aggregate_etag,
        hint_offset: update.hint_offset,
        bytes: update.bytes,
        observed_at: now.toISOString(),
        status: statusByFile.get(update.file),
      };
    }
    if (stateUpdates.length) atomicWrite(join(stateDir, "index.json"), `${JSON.stringify(state, null, 2)}\n`);
  }
  return receipt;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, now = new Date() } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) { stderr.write(`usage: --register <file> --targets <file> [--state-dir <dir>] [--out <file>]\n`); return EXIT.USAGE; }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.register || !args.targets) { stderr.write("usage: --register <file> --targets <file> [--state-dir <dir>] [--out <file>]\n"); return EXIT.USAGE; }
  let register;
  let targets;
  try {
    register = JSON.parse(readFileSync(resolve(args.register), "utf8"));
    targets = JSON.parse(readFileSync(resolve(args.targets), "utf8"));
  } catch (error) {
    stderr.write(`cannot read inputs: ${error.message}\n`);
    return EXIT.USAGE;
  }
  const receipt = await runSourceWatch({ register, targets, fetchImpl, stateDir: args["state-dir"] ? resolve(args["state-dir"]) : null, now });
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.out) atomicWrite(resolve(args.out), text);
  stdout.write(text);
  return exitCodeFor(receipt);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error?.stack || error); process.exitCode = EXIT.USAGE; });
}
