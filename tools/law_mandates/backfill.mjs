import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { compareMandates, assertReferencePathOutsideRepo } from "./compare_mandates.mjs";
import { extractMandatesForLaw, EXTRACTION_PROMPT_VERSION } from "./extract_mandates.mjs";
import { fetchEnactedLaws } from "./fetch_enacted_laws.mjs";

const DEFAULT_OUTPUT_DIR = "tools/law_mandates/output";
const DEFAULT_CACHE_DIR = "tools/law_mandates/cache";
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_RAIL = "codex";
const DEFAULT_ENDPOINT = "http://127.0.0.1:4000/v1/chat/completions";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 180_000;
const JOURNAL_SCRIPT = "/Users/james/dev/fiduciary-heartbeat/tools/autonomy_journal.py";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${key}`);
    args[key.slice(2).replaceAll("-", "_")] = next;
    index += 1;
  }
  return {
    repoRoot: resolve(args.repo_root || process.cwd()),
    cacheDir: resolve(args.cache_dir || DEFAULT_CACHE_DIR),
    outputDir: resolve(args.output_dir || DEFAULT_OUTPUT_DIR),
    reference: args.reference ? resolve(args.reference) : null,
    startYear: Number(args.start_year || 2014),
    endYear: Number(args.end_year || new Date().getUTCFullYear()),
    batchSize: Math.max(1, Number(args.batch_size || DEFAULT_BATCH_SIZE)),
    concurrency: Math.max(1, Number(args.concurrency || DEFAULT_CONCURRENCY)),
    maxAttempts: Math.max(1, Number(args.max_attempts || DEFAULT_MAX_ATTEMPTS)),
    model: args.model || DEFAULT_MODEL,
    rail: args.rail || DEFAULT_RAIL,
    endpoint: args.endpoint || DEFAULT_ENDPOINT,
    journalScript: args.journal_script || JOURNAL_SCRIPT,
  };
}

function stamp() { return new Date().toISOString(); }

async function atomicWrite(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function acquireLock(path) {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: stamp() })}\n`, "utf8");
    return async () => { await handle.close(); await unlink(path).catch(() => {}); };
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`backfill lock exists: ${path}`);
    throw error;
  }
}

function logHeartbeat(context) {
  console.log(`heartbeat: phase=${context.phase} completed=${context.completed} failed=${context.failed} total=${context.total} model=${context.model} at=${stamp()}`);
}

function safeModelError(error) {
  const message = String(error?.message || error || "model failure").replace(/[\r\n]+/gu, " ");
  return message.slice(0, 240).replace(/(?:sk-|token|authorization|api[_-]?key)[^ ]*/giu, "[redacted]");
}

async function journalBatch({ script, what, why, undo }) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [script, "add", "--actor", "crol-list-obligations-backfill", "--action-class", "batch-mutation", "--what", what, "--why", why, "--undo", undo, "--no-regen"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`autonomy journal failed (${code}): ${stderr.slice(0, 200)}`)));
  });
}

async function postHttpModel({ endpoint, model, prompt }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 4096, response_format: { type: "json_object" } }),
  });
  if (!response.ok) throw new Error(`model_http_${response.status}`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("model_empty_content");
  return content;
}

async function postCodexModel({ model, prompt, repoRoot }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("codex", ["exec", "-m", model, "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "-C", repoRoot], {
      cwd: repoRoot,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "LEGISTAR_API_TOKEN" && key !== "KIMI_API_KEY")),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const messages = stdout.split("\n").flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }).filter((event) => event?.type === "item.completed" && event?.item?.type === "agent_message").map((event) => event.item.text).filter(Boolean);
      if (code === 0 && messages.length) return resolvePromise(messages.at(-1));
      reject(new Error(`codex_${signal || `exit_${code}`}${stderr ? `:${stderr.trim().slice(0, 160)}` : ""}`));
    });
    child.stdin.end(prompt, "utf8");
  });
}

async function postModel(options, prompt) {
  return options.rail === "codex"
    ? postCodexModel({ model: options.model, prompt, repoRoot: options.repoRoot })
    : postHttpModel({ endpoint: options.endpoint, model: options.model, prompt });
}

async function settledConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function probeRail(options) {
  const content = await postModel(options, "Return only the JSON object {\"rail_ok\":true} and do not inspect or modify files.");
  const parsed = JSON.parse(String(content).replace(/^```json\s*/iu, "").replace(/\s*```$/u, ""));
  if (parsed?.rail_ok !== true) throw new Error("model_probe_invalid_json");
  return { model: options.model, rail: options.rail, endpoint: options.rail === "codex" ? "codex-cli" : options.endpoint, checked_at: stamp(), content_nonempty: true };
}

async function loadLaw(cacheDir, matterId) {
  return readJson(join(cacheDir, "laws", `${matterId}.json`));
}

async function writeLawOutput(outputDir, law, envelope, model) {
  const quoteReceipts = envelope.mandates.map((row) => ({
    mandate_id: row.mandate_id,
    matter_id: row.matter_id,
    quote_verified: row.quote_verified,
    reason: row.quote_verification_reason,
  }));
  const payload = {
    ...envelope,
    extraction: { model, prompt_version: EXTRACTION_PROMPT_VERSION, extracted_at: stamp() },
    quote_receipts: quoteReceipts,
  };
  await atomicWrite(join(outputDir, "laws", `${law.matter_id}.json`), payload);
}

async function buildOurPayload(outputDir, manifest, model, railReceipt) {
  const laws = [];
  for (const matterId of manifest.matter_ids) {
    const row = await readJson(join(outputDir, "laws", `${matterId}.json`));
    if (row) laws.push(row);
  }
  const mandates = laws.flatMap((law) => law.mandates || []);
  const quoteReceipts = laws.flatMap((law) => law.quote_receipts || []);
  return {
    schema_version: "cityscroll-mandates-backfill-v1",
    generated_at: stamp(),
    model,
    prompt_version: EXTRACTION_PROMPT_VERSION,
    rail: railReceipt,
    laws,
    mandates,
    quote_receipts: quoteReceipts,
    receipt: {
      law_count: laws.length,
      mandate_count: mandates.length,
      verified_count: mandates.filter((row) => row.quote_verified).length,
      candidate_count: mandates.filter((row) => row.status === "candidate").length,
      quote_receipt_count: quoteReceipts.length,
    },
  };
}

async function ensureManifest(options, context) {
  const manifestPath = join(options.outputDir, "manifest.json");
  const existing = await readJson(manifestPath);
  if (existing?.matter_ids?.length) return existing;
  console.log(`phase: fetching enacted laws ${options.startYear}-${options.endYear}`);
  const result = await fetchEnactedLaws({
    token: process.env.LEGISTAR_API_TOKEN,
    startYear: options.startYear,
    endYear: options.endYear,
    cacheDir: options.cacheDir,
    onProgress: async ({ index, total, matter_id: matterId, status }) => {
      context.phase = "fetch";
      context.total = total;
      context.completed = index;
      context.last = `${matterId || "unknown"}:${status}`;
      if (Date.now() - context.lastHeartbeat >= HEARTBEAT_MS) {
        context.lastHeartbeat = Date.now();
        logHeartbeat(context);
      }
    },
  });
  const manifest = {
    schema_version: "cityscroll-mandates-manifest-v1",
    created_at: stamp(),
    source: result.source,
    start_year: options.startYear,
    end_year: options.endYear,
    matter_ids: result.laws.map((law) => law.matter_id),
    skipped: result.skipped,
    law_count: result.laws.length,
    skipped_count: result.skipped.length,
  };
  await atomicWrite(manifestPath, manifest);
  await atomicWrite(join(options.outputDir, "fetch_receipt.json"), { ...manifest, text_cache_sha256_present: true });
  await journalBatch({ script: options.journalScript, what: `cached enacted-law source batch (${manifest.law_count} laws)`, why: "prepare resumable mandate extraction", undo: `remove ${options.cacheDir} and ${options.outputDir}/manifest.json` });
  return manifest;
}

async function runExtraction(options, manifest, railReceipt, context) {
  const statePath = join(options.outputDir, "state.json");
  const state = { schema_version: "cityscroll-mandates-state-v1", started_at: stamp(), completed_ids: [], failed: [], attempts: {}, ...(await readJson(statePath) || {}) };
  state.completed_ids ||= [];
  state.failed ||= [];
  state.attempts ||= {};
  const complete = new Set(state.completed_ids || []);
  const failedById = new Map((state.failed || []).map((row) => [row.matter_id, row]));
  const pending = manifest.matter_ids.filter((matterId) => !complete.has(matterId));
  context.total = manifest.matter_ids.length;
  context.completed = complete.size;
  context.failed = failedById.size;
  for (let offset = 0; offset < pending.length; offset += options.batchSize) {
    const batch = pending.slice(offset, offset + options.batchSize);
    let batchSucceeded = false;
    for (let batchAttempt = 1; batchAttempt <= options.maxAttempts && !batchSucceeded; batchAttempt += 1) {
      state.current_batch = { matter_ids: batch, attempt: batchAttempt, started_at: stamp() };
      await atomicWrite(statePath, state);
      try {
        const toExtract = [];
        for (const matterId of batch) {
          const outputPath = join(options.outputDir, "laws", `${matterId}.json`);
          if (await readJson(outputPath)) { complete.add(matterId); continue; }
          const law = await loadLaw(options.cacheDir, matterId);
          if (!law?.text) throw new Error(`missing_cached_text:${matterId}`);
          state.attempts[matterId] = (state.attempts[matterId] || 0) + 1;
          toExtract.push({ law, matterId });
        }
        const settled = await settledConcurrent(toExtract, options.concurrency, ({ law }) => extractMandatesForLaw(law, { model: options.model, invokeModel: ({ prompt }) => postModel(options.modelOptions, prompt), fetchedAt: law.provenance?.fetched_at }));
        for (let index = 0; index < settled.length; index += 1) {
          const result = settled[index];
          const { law, matterId } = toExtract[index];
          if (result.status === "fulfilled") {
            await writeLawOutput(options.outputDir, law, result.value, options.model);
            complete.add(matterId);
            failedById.delete(matterId);
            context.completed = complete.size;
            context.failed = failedById.size;
          }
        }
        const rejected = settled.filter((result) => result.status === "rejected");
        if (rejected.length) throw rejected[0].reason;
        if (Date.now() - context.lastHeartbeat >= HEARTBEAT_MS) { context.lastHeartbeat = Date.now(); logHeartbeat(context); }
        batchSucceeded = true;
      } catch (error) {
        const message = safeModelError(error);
        console.log(`batch-retry: attempt=${batchAttempt} size=${batch.length} error=${message}`);
        if (batchAttempt === options.maxAttempts) {
          const failed = batch.filter((matterId) => !complete.has(matterId)).map((matterId) => ({ matter_id: matterId, error: message, attempts: state.attempts[matterId] || 0, failed_at: stamp() }));
          for (const row of failed) failedById.set(row.matter_id, row);
          context.failed = failedById.size;
        }
      }
    }
    state.completed_ids = [...complete].sort((a, b) => Number(a) - Number(b));
    state.failed = [...failedById.values()].sort((a, b) => String(a.matter_id).localeCompare(String(b.matter_id)));
    state.current_batch = null;
    state.updated_at = stamp();
    await atomicWrite(statePath, state);
    await journalBatch({ script: options.journalScript, what: `extracted mandate batch (${batch.length} laws)`, why: `resumable extraction checkpoint; completed=${complete.size}`, undo: `remove ${options.outputDir}/laws for this batch and restore ${statePath}` });
    console.log(`batch-complete: offset=${offset + batch.length} total=${pending.length} completed=${complete.size} failed=${failedById.size}`);
  }
  const our = await buildOurPayload(options.outputDir, manifest, options.model, railReceipt);
  await atomicWrite(join(options.outputDir, "our.json"), our);
  return { state, our };
}

async function runComparator(options, manifest, our) {
  if (!options.reference) throw new Error("private oracle reference is required");
  const referencePath = assertReferencePathOutsideRepo(options.reference, options.repoRoot);
  const reference = await readJson(referencePath);
  const review = compareMandates(our, reference, { generatedAt: stamp() });
  const disagreements = review.queue.filter((item) => item.state === "needs_review");
  const filed = { schema_version: "mandate-clerk-review-queue-v1", filed_at: stamp(), status: "filed_for_clerk_review", receipt: { disagreement_count: disagreements.length, agreement_count: review.receipt.agreement_count, matter_count: review.receipt.matter_count }, queue: disagreements };
  await atomicWrite(join(options.outputDir, "review_queue.json"), review);
  await atomicWrite(join(options.outputDir, "clerk_review_queue.json"), filed);
  await journalBatch({ script: options.journalScript, what: `filed clerk review queue (${disagreements.length} disagreements)`, why: "differential comparison against private oracle", undo: `remove ${options.outputDir}/review_queue.json and clerk_review_queue.json` });
  return { review, filed };
}

export async function runBackfill(rawOptions = {}) {
  const options = { ...parseArgs(["node", "backfill.mjs"]), ...rawOptions };
  if (!process.env.LEGISTAR_API_TOKEN) throw new Error("LEGISTAR_API_TOKEN is required");
  await mkdir(join(options.outputDir, "laws"), { recursive: true });
  await mkdir(join(options.cacheDir, "laws"), { recursive: true });
  const release = await acquireLock(join(options.outputDir, ".backfill.lock"));
  const context = { phase: "startup", completed: 0, failed: 0, total: 0, model: options.model, lastHeartbeat: Date.now() };
  const heartbeatTimer = setInterval(() => { context.lastHeartbeat = Date.now(); logHeartbeat(context); }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  try {
    const railReceipt = options.railReceipt || await probeRail({ endpoint: options.endpoint, model: options.model });
    options.modelOptions = { endpoint: options.endpoint, model: options.model, rail: options.rail, repoRoot: options.repoRoot };
    await atomicWrite(join(options.outputDir, "rail_receipt.json"), railReceipt);
    const manifest = await ensureManifest(options, context);
    context.phase = "extract";
    const extraction = await runExtraction(options, manifest, railReceipt, context);
    if (extraction.our.laws.length !== manifest.law_count || extraction.state.failed?.length) throw new Error(`incomplete_extraction:laws=${extraction.our.laws.length}/${manifest.law_count},failed=${extraction.state.failed?.length || 0}`);
    context.phase = "compare";
    const comparison = await runComparator(options, manifest, extraction.our);
    const receipt = { schema_version: "cityscroll-mandates-backfill-receipt-v1", completed_at: stamp(), source: { law_count: manifest.law_count, skipped_count: manifest.skipped_count }, extraction: extraction.our.receipt, model: railReceipt, comparison: comparison.filed.receipt };
    await atomicWrite(join(options.outputDir, "run_receipt.json"), receipt);
    console.log(`complete: laws=${receipt.extraction.law_count} mandates=${receipt.extraction.mandate_count} verified=${receipt.extraction.verified_count} candidates=${receipt.extraction.candidate_count} disagreements=${receipt.comparison.disagreement_count}`);
    return receipt;
  } finally {
    clearInterval(heartbeatTimer);
    await release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackfill(parseArgs(process.argv)).catch((error) => { console.error(`failed: ${safeModelError(error)}`); process.exitCode = 1; });
}
