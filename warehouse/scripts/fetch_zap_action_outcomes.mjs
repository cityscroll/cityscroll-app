#!/usr/bin/env node
/**
 * Resumable, bounded ZAP project-action enrichment for zoning outcome rates.
 * Bulk project/date columns remain owned by the capped WH loader; this pass
 * fetches only public action statuses missing from the Open Data export.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { queryWarehouse } from "../lib/query.mjs";

const WAREHOUSE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(WAREHOUSE, "raw/zap-action-outcomes");
const API = "https://zap-api-production.herokuapp.com/projects";

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, concurrency: 8, max: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = resolve(argv[++index]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++index]);
    else if (arg === "--max") args.max = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    throw new Error("--concurrency must be an integer from 1 to 8");
  }
  if (args.max != null && (!Number.isSafeInteger(args.max) || args.max < 1)) {
    throw new Error("--max must be a positive integer");
  }
  return args;
}

async function fetchOne(projectId, outDir) {
  const path = join(outDir, `${projectId}.json`);
  if (existsSync(path)) return "cached";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${API}/${encodeURIComponent(projectId)}`, {
        headers: { "User-Agent": "CityScrollWarehouse/0.2 (+https://cityscroll.org)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return "not_found";
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
      return "fetched";
    } catch (error) {
      if (attempt === 3) return `failed:${error?.message || error}`;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  return "failed:unknown";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });
  let rows = queryWarehouse(`
    SELECT project_id
    FROM zap_projects
    WHERE public_status = 'Completed'
      AND certified_referred >= DATE '2018-01-01'
    ORDER BY project_id
  `);
  if (args.max != null) rows = rows.slice(0, args.max);

  const counts = { cached: 0, fetched: 0, not_found: 0, failed: 0 };
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      const result = await fetchOne(String(rows[index].project_id), outDir);
      const key = result.startsWith("failed:") ? "failed" : result;
      counts[key] += 1;
      if ((index + 1) % 100 === 0 || index + 1 === rows.length) {
        console.log(`zap-action-outcomes heartbeat ${index + 1}/${rows.length} fetched=${counts.fetched} cached=${counts.cached} failed=${counts.failed}`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  writeFileSync(
    join(outDir, "cache_meta.json"),
    `${JSON.stringify({ schema_version: 1, source: API, requested: rows.length, ...counts }, null, 2)}\n`,
    "utf8",
  );
  if (counts.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
