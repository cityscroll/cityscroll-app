// Loads the ENGINE's own fetchSodaRowsWithRetry (worker/src/alerts.mjs) for tests, without importing
// the whole alerts module (it needs packages that may be absent in a reduced checkout). The function
// and the three constants it uses are cut out of the engine source text and evaluated next to the
// engine's real upstream_failure.mjs. If the engine text changes shape, the cut fails loudly and
// the tests fail.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { withTempDir } from "../../tools/lib/with_temp_dir.mjs";

export async function loadFetchSodaRowsWithRetry(appRoot) {
  const file = path.join(appRoot, "worker/src/alerts.mjs");
  const src = fs.readFileSync(file, "utf8");
  const sha = crypto.createHash("sha256").update(src).digest("hex");
  const start = src.indexOf("export async function fetchSodaRowsWithRetry(");
  if (start < 0) throw new Error("fetchSodaRowsWithRetry not found in alerts.mjs");
  const end = src.indexOf("\n}\n", start);
  if (end < 0) throw new Error("end of fetchSodaRowsWithRetry not found");
  const fn = src.slice(start, end + 3);
  const consts = [
    /const RETRYABLE_SODA_STATUSES = [^;]+;/,
    /const SODA_RETRY_DELAYS_MS = [^;]+;/,
    /const SODA_RETRY_BUDGET_MS = [^;]+;/,
  ].map((re) => {
    const m = re.exec(src);
    if (!m) throw new Error(`constant ${re} not found in alerts.mjs`);
    return m[0];
  });
  const upstream = pathToFileURL(path.join(appRoot, "worker/src/lib/upstream_failure.mjs")).href;
  const text = `import { markUpstreamFailure, TRANSIENT_UPSTREAM_STATUSES } from ${JSON.stringify(upstream)};\n${consts.join("\n")}\n${fn}\n`;
  return withTempDir("engine-soda", async (dir) => {
    const out = path.join(dir, "helper.mjs");
    fs.writeFileSync(out, text);
    const mod = await import(pathToFileURL(out).href);
    return { fetchSodaRowsWithRetry: mod.fetchSodaRowsWithRetry, alerts_sha256: sha, cut_bytes: fn.length };
  });
}

export const loadEngineSodaHelper = loadFetchSodaRowsWithRetry;
