import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { compareMandates, assertReferencePathOutsideRepo } from "./compare_mandates.mjs";
import { extractMandatesForLaw, EXTRACTION_PROMPT_VERSION } from "./extract_mandates.mjs";
import { fetchEnactedLaws, repairCachedLawTexts } from "./fetch_enacted_laws.mjs";

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
const EXTRACTION_ADAPTER_VERSION = "codex-stdin-v1";

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
    quarantine: resolve(args.quarantine || join(DEFAULT_OUTPUT_DIR, "quarantine.json")),
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
    const child = spawn("codex", ["exec", "-m", model, "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "-C", repoRoot, "-"], {
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
    matter_file: law.matter_file,
    file_number: law.matter_file,
    extraction: { model, prompt_version: EXTRACTION_PROMPT_VERSION, adapter_version: EXTRACTION_ADAPTER_VERSION, extracted_at: stamp() },
    quote_receipts: quoteReceipts,
  };
  await atomicWrite(join(outputDir, "laws", `${law.matter_id}.json`), payload);
}

async function buildOurPayload(outputDir, manifest, model, railReceipt, quarantineIds = new Set()) {
  const laws = [];
  for (const matterId of manifest.matter_ids) {
    if (quarantineIds.has(matterId)) continue;
    const row = await readJson(join(outputDir, "laws", `${matterId}.json`));
    if (row) laws.push(row);
  }
  const mandates = laws.flatMap((law) => (law.mandates || []).map((row) => ({
    ...row,
    matter_file: row.matter_file || law.matter_file,
    file_number: row.file_number || law.file_number || law.matter_file,
  })));
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

async function ensureSubstantiveText(options, manifest, context) {
  const receiptPath = join(options.outputDir, "text_repair_receipt.json");
  const existing = await readJson(receiptPath);
  if (existing?.law_count === manifest.law_count && existing?.failed_count === 0) return existing;
  context.phase = "repair-text";
  context.total = manifest.law_count;
  context.completed = 0;
  context.failed = 0;
  console.log(`phase: repairing enacted-law source text from primary attachments (${manifest.law_count} laws)`);
  const repaired = await repairCachedLawTexts({
    cacheDir: options.cacheDir,
    onProgress: async ({ index, total, matter_id: matterId, status }) => {
      context.total = total;
      context.completed = index;
      context.last = `${matterId || "unknown"}:${status}`;
      if (Date.now() - context.lastHeartbeat >= HEARTBEAT_MS) {
        context.lastHeartbeat = Date.now();
        logHeartbeat(context);
      }
    },
  });
  const receipt = { ...repaired, completed_at: stamp() };
  await atomicWrite(receiptPath, receipt);
  await journalBatch({
    script: options.journalScript,
    what: `repaired enacted-law text cache (${receipt.repaired} laws)`,
    why: "replace metadata-only fields with primary law attachment text",
    undo: `restore ${options.cacheDir}/laws from the prior cache snapshot`,
  });
  if (receipt.law_count !== manifest.law_count || receipt.failed_count) {
    throw new Error(`text_repair_incomplete:laws=${receipt.law_count}/${manifest.law_count},failed=${receipt.failed_count}`);
  }
  return receipt;
}

function quarantineEntry(row) {
  return { matter_id: String(row.matter_id), error: String(row.error || "bounded_attempts_exhausted"), attempts: row.attempts || null, failed_at: row.failed_at || null };
}

async function appendQuarantine(options, rows, why) {
  const existing = await readJson(options.quarantine, { schema_version: "mandate-backfill-quarantine-v1", entries: [] });
  const entriesById = new Map((existing.entries || []).map((row) => [String(row.matter_id), row]));
  const added = [];
  for (const row of rows) {
    const entry = quarantineEntry(row);
    if (!entriesById.has(entry.matter_id)) {
      entriesById.set(entry.matter_id, entry);
      added.push(entry);
    }
  }
  if (!added.length) return existing;
  const quarantine = {
    ...existing,
    schema_version: "mandate-backfill-quarantine-v1",
    status: "quarantined_for_separate_retry",
    card: existing.card || "obligations-backfill-retry-3laws",
    filed_at: existing.filed_at || stamp(),
    updated_at: stamp(),
    entries: [...entriesById.values()].sort((left, right) => String(left.matter_id).localeCompare(String(right.matter_id))),
  };
  await atomicWrite(options.quarantine, quarantine);
  await journalBatch({
    script: options.journalScript,
    what: `quarantined exhausted mandate laws (${added.length} new laws)`,
    why,
    undo: `remove ${options.quarantine}`,
  });
  return quarantine;
}

async function ensureQuarantine(options) {
  const state = await readJson(join(options.outputDir, "state.json"), { failed: [] });
  return appendQuarantine(options, state.failed || [], "continue the corpus while separately tracking laws that exhausted bounded extraction attempts");
}

async function runExtraction(options, manifest, railReceipt, context, quarantineIds = new Set()) {
  const statePath = join(options.outputDir, "state.json");
  const state = { schema_version: "cityscroll-mandates-state-v1", started_at: stamp(), completed_ids: [], failed: [], attempts: {}, ...(await readJson(statePath) || {}) };
  state.completed_ids ||= [];
  state.failed ||= [];
  state.attempts ||= {};
  const complete = new Set(state.completed_ids || []);
  for (const matterId of quarantineIds) complete.delete(matterId);
  const failedById = new Map((state.failed || []).map((row) => [row.matter_id, row]));
  const pending = [];
  for (const matterId of manifest.matter_ids) {
    if (quarantineIds.has(matterId)) continue;
    const existing = await readJson(join(options.outputDir, "laws", `${matterId}.json`));
    if (complete.has(matterId) && existing?.extraction?.model === options.model && existing?.extraction?.adapter_version === EXTRACTION_ADAPTER_VERSION) continue;
    pending.push(matterId);
  }
  context.total = manifest.matter_ids.length;
  context.completed = complete.size + quarantineIds.size;
  context.failed = failedById.size;
  for (let offset = 0; offset < pending.length; offset += options.batchSize) {
    const batch = pending.slice(offset, offset + options.batchSize);
    for (const matterId of batch) {
      complete.delete(matterId);
      failedById.delete(matterId);
    }
    let batchSucceeded = false;
    for (let batchAttempt = 1; batchAttempt <= options.maxAttempts && !batchSucceeded; batchAttempt += 1) {
      state.current_batch = { matter_ids: batch, attempt: batchAttempt, started_at: stamp() };
      await atomicWrite(statePath, state);
      try {
        const toExtract = [];
        for (const matterId of batch) {
          const outputPath = join(options.outputDir, "laws", `${matterId}.json`);
          const existing = await readJson(outputPath);
          if (existing?.extraction?.model === options.model && existing?.extraction?.adapter_version === EXTRACTION_ADAPTER_VERSION) { complete.add(matterId); continue; }
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
            context.completed = complete.size + quarantineIds.size;
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
    if (!batchSucceeded) {
      const batchFailures = [...failedById.values()].filter((row) => batch.includes(String(row.matter_id)));
      await appendQuarantine(options, batchFailures, "advance to the next law batch after bounded extraction attempts were exhausted");
      for (const row of batchFailures) quarantineIds.add(String(row.matter_id));
      context.completed = complete.size + quarantineIds.size;
      console.log(`batch-quarantined: offset=${offset + batch.length} total=${pending.length} quarantined=${batchFailures.length} completed=${complete.size} failed=${failedById.size}`);
    } else {
      console.log(`batch-complete: offset=${offset + batch.length} total=${pending.length} completed=${complete.size} failed=${failedById.size}`);
    }
  }
  const our = await buildOurPayload(options.outputDir, manifest, options.model, railReceipt, quarantineIds);
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
    const railReceipt = options.railReceipt || await probeRail({ endpoint: options.endpoint, model: options.model, rail: options.rail, repoRoot: options.repoRoot });
    options.modelOptions = { endpoint: options.endpoint, model: options.model, rail: options.rail, repoRoot: options.repoRoot };
    await atomicWrite(join(options.outputDir, "rail_receipt.json"), railReceipt);
    const manifest = await ensureManifest(options, context);
    await ensureSubstantiveText(options, manifest, context);
    const quarantine = await ensureQuarantine(options);
    const quarantineIds = new Set((quarantine.entries || []).map((row) => String(row.matter_id)));
    context.phase = "extract";
    const extraction = await runExtraction(options, manifest, railReceipt, context, quarantineIds);
    const unexpectedFailures = (extraction.state.failed || []).filter((row) => !quarantineIds.has(String(row.matter_id)));
    const expectedLawCount = manifest.law_count - quarantineIds.size;
    if (extraction.our.laws.length !== expectedLawCount || unexpectedFailures.length) throw new Error(`incomplete_extraction:laws=${extraction.our.laws.length}/${expectedLawCount},failed=${unexpectedFailures.length}`);
    context.phase = "compare";
    const comparison = await runComparator(options, manifest, extraction.our);
    const receipt = { schema_version: "cityscroll-mandates-backfill-receipt-v1", completed_at: stamp(), source: { law_count: manifest.law_count, skipped_count: manifest.skipped_count }, quarantine: { count: quarantineIds.size, path: options.quarantine }, extraction: extraction.our.receipt, model: railReceipt, comparison: comparison.filed.receipt };
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
