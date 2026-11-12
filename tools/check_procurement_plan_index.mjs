#!/usr/bin/env node
// Scheduled staleness check for the MOCS procurement-plan index pages.
//
//   node tools/check_procurement_plan_index.mjs [--manifest site/data/procurement_planning_payload.json] [--out receipt.json]
//
// Fetches the two index pages named in the committed manifest (two GETs, about
// 85 KB in all), compares the workbook link set and per-link notes with what
// the manifest recorded at collection, prints one receipt as JSON, and exits:
// 0 unchanged, 3 changes found, 4 could not check, 5 both, 2 usage.
// It never downloads a workbook and never writes the payload: collection stays
// a deliberate host-side run of warehouse/scripts/procurement_plans_run.py.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { comparePlanIndexes, recordedIndex, INDEX_SOURCES } from "./procurement_plan_index_watch.mjs";

export const EXIT = Object.freeze({ clean: 0, usage: 2, changed: 3, could_not_check: 4, both: 5 });
export const HOST_ALLOWLIST = Object.freeze(["www.nyc.gov"]);
export const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 20000, maxBytes: 1048576, maxRedirects: 3 });
// nyc.gov answers 403 to some default client user agents; a generic one works.
export const USER_AGENT = "Mozilla/5.0 (compatible; CityScroll plan index check)";

export function exitCodeFor(receipt) {
  if (receipt.changes_found && receipt.could_not_check) return EXIT.both;
  if (receipt.changes_found) return EXIT.changed;
  if (receipt.could_not_check) return EXIT.could_not_check;
  return EXIT.clean;
}

class CheckError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function allowed(url, hosts) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && hosts.includes(parsed.hostname);
  } catch { return false; }
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new CheckError("oversize");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new CheckError("oversize");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new CheckError("oversize"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** GET one page with manual, allowlisted, bounded redirects and a byte cap. */
export async function fetchIndexPage(url, { fetchImpl = globalThis.fetch, hosts = HOST_ALLOWLIST, limits = DEFAULT_LIMITS } = {}) {
  let current = url;
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    if (!allowed(current, hosts)) return { ok: false, reason: "host_not_allowed", url: current };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location) return { ok: false, reason: `redirect_without_location_${response.status}` };
        current = new URL(location, current).href;
        continue;
      }
      if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
      const html = await readCapped(response, limits.maxBytes);
      return { ok: true, html, url: current };
    } catch (error) {
      if (error instanceof CheckError) return { ok: false, reason: error.reason };
      if (error?.name === "AbortError" || controller.signal.aborted) return { ok: false, reason: "timeout" };
      return { ok: false, reason: `fetch_failed: ${String(error?.message || error).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "too_many_redirects" };
}

export async function runPlanIndexWatch(manifest, { fetchImpl, hosts, limits, now = new Date() } = {}) {
  const observations = {};
  for (const source of Object.keys(INDEX_SOURCES)) {
    const { url } = recordedIndex(manifest, source);
    observations[source] = url ? await fetchIndexPage(url, { fetchImpl, hosts, limits }) : { ok: false, reason: "no index url recorded" };
  }
  return comparePlanIndexes(manifest, observations, { checkedAt: now.toISOString() });
}

export async function main(argv = process.argv.slice(2), { fetchImpl, stdout = process.stdout } = {}) {
  let manifestPath = "site/data/procurement_planning_payload.json";
  let outPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest" && argv[i + 1]) manifestPath = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) outPath = argv[++i];
    else { stdout.write(`usage: check_procurement_plan_index.mjs [--manifest file] [--out file]\n`); return EXIT.usage; }
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8")); } catch (error) {
    stdout.write(`cannot read manifest: ${error.message}\n`);
    return EXIT.usage;
  }
  const receipt = await runPlanIndexWatch(manifest, { fetchImpl });
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, text);
  stdout.write(text);
  return exitCodeFor(receipt);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main();
}
