#!/usr/bin/env node

/**
 * Portable writer fence for the Worker deployment path.
 *
 * GitHub Actions serializes the workflow across runs. This helper adds a
 * durable, per-run writer identity and a last-moment assertion so every
 * mutating command must still belong to the run that acquired the fence.
 * Local callers can use the same contract by supplying WORKER_DEPLOY_OWNER.
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export const WORKER_DEPLOY_FENCE_SCHEMA = "cityscroll.worker_deploy_fence.v2";
export const DEFAULT_FENCE_TTL_MS = 2 * 60 * 60 * 1000;
export const WORKER_DEPLOY_FENCE_REF = "refs/heads/deploy-fence";
export const WORKER_DEPLOY_FENCE_PATH = ".github/worker-deploy-fence.json";
export const WORKER_DEPLOY_FENCE_WORKFLOW = "deploy-worker.yml";
export const GITHUB_ACTIONS_API_BASE = "https://api.github.com";
export const LIVE_FENCE_RECEIPT_SCHEMA = "cityscroll.worker_deploy_live_fence_receipt.v1";
export const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_LIVE_DRAIN_MAX_PAGES = 10;
export const DEFAULT_LIVE_FENCE_BASE_REF = "refs/heads/main";

function fail(message) {
  throw new Error(`worker deploy fence: ${message}`);
}

function requireValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value.trim();
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") fail("a fetch implementation is required for the live fence");
  return fetchImpl;
}

function githubRepository(repository) {
  const value = requireValue(repository, "GITHUB_REPOSITORY");
  if (!/^[^/]+\/[^/]+$/.test(value)) fail("GITHUB_REPOSITORY must be OWNER/REPOSITORY");
  return value;
}

function githubApiUrl({ apiBase = GITHUB_ACTIONS_API_BASE, repository, path }) {
  const base = requireValue(apiBase, "GitHub API base").replace(/\/$/, "");
  return `${base}/repos/${githubRepository(repository)}${path}`;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${requireValue(token, "GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Keep the controller alive until the response body has been consumed. A
// headers-only timeout leaves a real fetch body/socket alive, which can keep a
// short-lived deploy process running after its caller has failed closed.
const responseContexts = new WeakMap();

async function raceWithTimeout(operation, timeout, timeoutMessage, onTimeout = null) {
  let timeoutTimer;
  const operationPromise = Promise.resolve().then(operation);
  // Test doubles may ignore AbortSignal or return a response whose body never
  // resolves. The bound therefore covers the operation, not just transport.
  operationPromise.catch(() => {});
  try {
    return await Promise.race([
      operationPromise,
      new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // The bounded error below is authoritative even if body cleanup
            // itself is already in progress.
          }
          reject(Object.assign(new Error(timeoutMessage), { name: "AbortError" }));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

function cancelResponse(response, context) {
  try {
    context?.controller?.abort();
  } catch {
    // The caller still receives the bounded timeout below.
  }
  try {
    const cancel = response?.body?.cancel;
    if (typeof cancel === "function") Promise.resolve(cancel.call(response.body)).catch(() => {});
  } catch {
    // A locked or already-closed body is still safe to forget.
  }
}

function releaseResponseContext(response, { abort = false } = {}) {
  if (!response || (typeof response !== "object" && typeof response !== "function")) return;
  const context = responseContexts.get(response);
  if (!context) return;
  if (abort) cancelResponse(response, context);
  clearTimeout(context.timer);
  responseContexts.delete(response);
}

async function jsonBody(response, requestTimeoutMs) {
  const timeout = positiveInteger(requestTimeoutMs, "live request timeout");
  const context = response && (typeof response === "object" || typeof response === "function")
    ? responseContexts.get(response)
    : null;
  const remaining = response && (typeof response === "object" || typeof response === "function")
    ? Math.min(timeout, (context?.deadline ?? (Date.now() + timeout)) - Date.now())
    : timeout;
  if (remaining <= 0) {
    releaseResponseContext(response, { abort: true });
    fail(`GitHub API response body timed out after ${timeout}ms`);
  }
  try {
    return await raceWithTimeout(
      () => response.json(),
      remaining,
      `response body timeout after ${timeout}ms`,
      () => cancelResponse(response, context),
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      releaseResponseContext(response, { abort: true });
      fail(`GitHub API response body timed out after ${timeout}ms`);
    }
    // Do not echo a provider body or arbitrary transport detail into logs.
    fail("GitHub API returned invalid JSON");
  } finally {
    releaseResponseContext(response);
  }
}

function validRefName(refName) {
  const value = requireValue(refName, "WORKER_DEPLOY_FENCE_REF");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    fail("WORKER_DEPLOY_FENCE_REF must be a safe refs/heads name");
  }
  return value;
}

function refApiPath(refName) {
  return `/git/ref/${validRefName(refName).slice("refs/".length).split("/").map(encodeURIComponent).join("/")}`;
}

function matchingRefApiPath(refName) {
  return `/git/matching-refs/heads/${validRefName(refName).slice("refs/heads/".length).split("/").map(encodeURIComponent).join("/")}`;
}

function fenceDocumentPath(fencePath) {
  const value = requireValue(fencePath, "WORKER_DEPLOY_FENCE_PATH");
  if (value.startsWith("/") || value.includes("..")) fail("WORKER_DEPLOY_FENCE_PATH must be a safe repository path");
  return `/contents/${value.split("/").map(encodeURIComponent).join("/")}`;
}

function fenceBranch(refName) {
  return validRefName(refName).slice("refs/heads/".length);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be positive`);
  return value;
}

async function boundedFetch(fetcher, url, options, requestTimeoutMs) {
  const timeout = positiveInteger(requestTimeoutMs, "live request timeout");
  const deadline = Date.now() + timeout;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let timeoutTimer;
  const request = Promise.resolve().then(() => fetcher(url, { ...options, signal: controller.signal }));
  // A test double may ignore AbortSignal; keep the safety bound independent of
  // whether the underlying transport honors cancellation.
  request.catch(() => {});
  try {
    const response = await Promise.race([
      request,
      new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => reject(Object.assign(new Error("request timeout"), { name: "AbortError" })), timeout);
      }),
    ]);
    if (response && (typeof response === "object" || typeof response === "function")) {
      responseContexts.set(response, { controller, deadline, timer });
    } else {
      clearTimeout(timer);
    }
    return response;
  } catch (error) {
    controller.abort();
    const detail = error?.name === "AbortError" ? `timed out after ${timeout}ms` : error.message;
    fail(`live fence request failed: ${detail}`);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function readMatchingFenceRef({ fetcher, apiBase, repository, token, refName, requestTimeoutMs }) {
  const normalizedRef = validRefName(refName);
  const response = await boundedFetch(
    fetcher,
    githubApiUrl({ apiBase, repository, path: matchingRefApiPath(normalizedRef) }),
    { method: "GET", headers: githubHeaders(token) },
    requestTimeoutMs,
  );
  if (!response?.ok) {
    releaseResponseContext(response, { abort: true });
    fail(`live fence ref absence is unknown: matching-ref read returned HTTP ${response?.status ?? "unknown"}`);
  }
  const body = await jsonBody(response, requestTimeoutMs);
  if (!Array.isArray(body)) fail("live fence ref absence is unknown: matching-ref response is malformed");
  for (const entry of body) {
    if (!entry || typeof entry !== "object" || typeof entry.ref !== "string") {
      fail("live fence ref absence is unknown: matching-ref entry is malformed");
    }
    if (typeof entry.object?.sha !== "string" || !/^[0-9a-f]{40}$/i.test(entry.object.sha)) {
      fail("live fence ref absence is unknown: matching-ref entry sha is malformed");
    }
  }
  const exact = body.find((entry) => entry.ref === normalizedRef);
  if (!exact) return { present: false, ref_name: normalizedRef };
  const refSha = exact.object?.sha;
  if (typeof refSha !== "string" || !/^[0-9a-f]{40}$/i.test(refSha)) {
    fail("live fence ref response omitted a valid commit sha");
  }
  return { present: true, ref_name: normalizedRef, ref_sha: refSha };
}

function parseFenceDocument(value, now) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("GitHub fence document is empty");
  }
  let parsed;
  try {
    parsed = JSON.parse(value.trim());
  } catch (error) {
    fail(`GitHub fence document is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("GitHub fence document is not an object");
  }
  if (parsed.schema !== "cityscroll.worker_deploy_live_fence.v1") {
    fail("GitHub fence document schema is invalid");
  }
  const windowId = requireValue(parsed.window_id, "GitHub fence window_id");
  const expiresAt = requireValue(parsed.expires_at, "GitHub fence expires_at");
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) fail("GitHub fence expires_at is invalid");
  const generation = parsed.generation;
  if (!Number.isInteger(generation) || generation < 1) fail("GitHub fence generation is invalid");
  const status = parsed.status;
  if (status !== "ACTIVE" && status !== "RELEASED") fail("GitHub fence status is invalid");
  if (status === "RELEASED") {
    const restoredAt = requireValue(parsed.restored_at, "GitHub fence restored_at");
    if (!Number.isFinite(Date.parse(restoredAt))) fail("GitHub fence restored_at is invalid");
    return {
      state: "RELEASED",
      // An explicit, proof-bound release opens ordinary deployment again. The
      // retired window id remains attached so that tuple cannot reauthorize.
      fenced: false,
      window_id: windowId,
      generation,
      expires_at: new Date(expiresMs).toISOString(),
      restored_at: new Date(Date.parse(restoredAt)).toISOString(),
      observed_at: now.toISOString(),
    };
  }
  const state = expiresMs <= now.getTime() ? "EXPIRED" : "PRESENT";
  return {
    state,
    // Expiry does not remove a fence. A stale/uncertain restoration must not
    // reopen the writer path merely because the timestamp passed.
    fenced: true,
    window_id: windowId,
    generation,
    expires_at: new Date(expiresMs).toISOString(),
    observed_at: now.toISOString(),
  };
}

async function readFenceDocumentAtRef({
  fetcher,
  apiBase,
  repository,
  token,
  refName,
  fencePath,
  refSha,
  now,
  requestTimeoutMs,
  allowMissing = false,
}) {
  const normalizedRef = validRefName(refName);
  const normalizedPath = requireValue(fencePath, "WORKER_DEPLOY_FENCE_PATH");
  const documentResponse = await boundedFetch(
    fetcher,
    `${githubApiUrl({ apiBase, repository, path: fenceDocumentPath(normalizedPath) })}?ref=${encodeURIComponent(refSha)}`,
    { method: "GET", headers: githubHeaders(token) },
    requestTimeoutMs,
  );
  if (documentResponse?.status === 404 && allowMissing) {
    releaseResponseContext(documentResponse);
    return { missing: true };
  }
  if (!documentResponse?.ok) {
    releaseResponseContext(documentResponse, { abort: true });
    fail(`live fence document read failed with HTTP ${documentResponse?.status ?? "unknown"}`);
  }
  const documentBody = await jsonBody(documentResponse, requestTimeoutMs);
  if (documentBody?.type !== "file" || documentBody?.encoding !== "base64" || typeof documentBody.content !== "string") {
    fail("live fence document response is malformed");
  }
  const encoded = documentBody.content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    fail("live fence document content is not valid base64");
  }
  if (typeof documentBody.sha !== "string" || !/^[0-9a-f]{40}$/i.test(documentBody.sha)) {
    fail("live fence document response omitted a valid file sha");
  }
  return {
    ...parseFenceDocument(Buffer.from(encoded, "base64").toString("utf8"), now),
    ref_name: normalizedRef,
    ref_sha: refSha,
    fence_path: normalizedPath,
    file_sha: documentBody.sha,
  };
}

/** Read the fixed fence ref and its document using only repository contents reads. */
export async function readLiveFenceState({
  token,
  repository,
  refName = WORKER_DEPLOY_FENCE_REF,
  fencePath = WORKER_DEPLOY_FENCE_PATH,
  apiBase = GITHUB_ACTIONS_API_BASE,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
} = {}) {
  const fetcher = requireFetch(fetchImpl);
  const normalizedRef = validRefName(refName);
  const normalizedPath = requireValue(fencePath, "WORKER_DEPLOY_FENCE_PATH");
  fenceDocumentPath(normalizedPath);
  const ref = await readMatchingFenceRef({
    fetcher, apiBase, repository, token, refName: normalizedRef, requestTimeoutMs,
  });
  if (!ref.present) {
    return {
      state: "ABSENT",
      fenced: false,
      absence_proven: true,
      ref_name: normalizedRef,
      fence_path: normalizedPath,
      observed_at: now.toISOString(),
    };
  }
  return readFenceDocumentAtRef({
    fetcher, apiBase, repository, token, refName: normalizedRef, fencePath: normalizedPath,
    refSha: ref.ref_sha, now, requestTimeoutMs,
  });
}

/**
 * Assert the writer's window against a fresh ref/document read.
 * Only a positively-proven absent ref or proof-bound RELEASED state is unfenced;
 * expired, malformed, inaccessible, uncertain, and retired-tuple state fails
 * closed.
 */
export async function assertLiveWriterWindow({
  token,
  repository,
  windowId,
  refName = WORKER_DEPLOY_FENCE_REF,
  fencePath = WORKER_DEPLOY_FENCE_PATH,
  apiBase = GITHUB_ACTIONS_API_BASE,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
} = {}) {
  const currentWindow = requireValue(windowId, "WORKER_DEPLOY_FENCE_WINDOW");
  const state = await readLiveFenceState({
    token,
    repository,
    refName,
    fencePath,
    apiBase,
    fetchImpl,
    now,
    requestTimeoutMs,
  });
  if (state.state === "RELEASED" && state.window_id === currentWindow) {
    fail("live fence blocks the retired window tuple");
  }
  if (!state.fenced) return { ...state, allowed: true };
  if (state.window_id !== currentWindow) {
    fail(`live fence blocks writer outside active window (${state.window_id})`);
  }
  if (state.state !== "PRESENT") {
    fail(`live fence blocks writer in ${state.state.toLowerCase()} state`);
  }
  return { ...state, allowed: true };
}

function normalizeExpiry(expiresAt, now = new Date()) {
  const parsedExpiry = Date.parse(requireValue(expiresAt, "expiresAt"));
  if (!Number.isFinite(parsedExpiry) || parsedExpiry <= now.getTime()) fail("expiresAt must be a finite future time");
  return new Date(parsedExpiry).toISOString();
}

async function writeFenceDocument({
  token,
  repository,
  refName,
  fencePath,
  state,
  apiBase,
  fetcher,
  requestTimeoutMs,
}) {
  const url = githubApiUrl({ apiBase, repository, path: fenceDocumentPath(fencePath) });
  const document = JSON.stringify({
    schema: "cityscroll.worker_deploy_live_fence.v1",
    status: state.status || "ACTIVE",
    window_id: state.window_id,
    generation: state.generation,
    expires_at: state.expires_at,
    ...(state.status === "RELEASED" ? { restored_at: state.restored_at } : {}),
  });
  const body = {
    message: `Update deploy fence window ${state.generation}`,
    content: Buffer.from(`${document}\n`, "utf8").toString("base64"),
    branch: fenceBranch(refName),
  };
  if (state.file_sha) body.sha = state.file_sha;
  const response = await boundedFetch(
    fetcher,
    url,
    {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    requestTimeoutMs,
  );
  if (!response?.ok) {
    releaseResponseContext(response, { abort: true });
    fail(`live fence arm failed with HTTP ${response?.status ?? "unknown"}`);
  }
  const acknowledgement = await jsonBody(response, requestTimeoutMs);
  if (!acknowledgement?.content?.sha) fail("live fence write acknowledgement is incomplete");
  return acknowledgement;
}

async function observeBootstrappedRef({ fetcher, apiBase, repository, token, refName, requestTimeoutMs }) {
  let observed;
  try {
    observed = await readMatchingFenceRef({ fetcher, apiBase, repository, token, refName, requestTimeoutMs });
  } catch {
    fail("live fence ref bootstrap acknowledgement is unknown");
  }
  if (!observed.present) fail("live fence ref bootstrap acknowledgement is unknown");
  return observed;
}

function bootstrapReceipt(observed, acknowledgement) {
  return {
    ...observed,
    bootstrap_post: "ATTEMPTED",
    bootstrap_acknowledgement: acknowledgement ? "CONFIRMED" : "UNKNOWN",
    // A matching ref proves namespace state only. It never identifies which
    // actor created it after a lost/non-successful POST response.
    bootstrap_creator: acknowledgement ? "CONFIRMED" : "UNKNOWN",
  };
}

async function recoverUnacknowledgedBootstrap({ fetcher, apiBase, repository, token, refName, requestTimeoutMs }) {
  return bootstrapReceipt(
    await observeBootstrappedRef({ fetcher, apiBase, repository, token, refName, requestTimeoutMs }),
    false,
  );
}

async function bootstrapFenceRef({
  token,
  repository,
  refName,
  baseRef,
  apiBase,
  fetcher,
  requestTimeoutMs,
}) {
  const normalizedRef = validRefName(refName);
  const normalizedBaseRef = validRefName(baseRef);
  const baseResponse = await boundedFetch(
    fetcher,
    githubApiUrl({ apiBase, repository, path: refApiPath(normalizedBaseRef) }),
    { method: "GET", headers: githubHeaders(token) },
    requestTimeoutMs,
  );
  if (!baseResponse?.ok) {
    releaseResponseContext(baseResponse, { abort: true });
    fail(`live fence bootstrap base ref read failed with HTTP ${baseResponse?.status ?? "unknown"}`);
  }
  const baseBody = await jsonBody(baseResponse, requestTimeoutMs);
  const baseSha = baseBody?.object?.sha;
  if (typeof baseSha !== "string" || !/^[0-9a-f]{40}$/i.test(baseSha)) {
    fail("live fence bootstrap base ref omitted a valid commit sha");
  }

  let response;
  try {
    response = await boundedFetch(
      fetcher,
      githubApiUrl({ apiBase, repository, path: "/git/refs" }),
      {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ ref: normalizedRef, sha: baseSha }),
      },
      requestTimeoutMs,
    );
  } catch {
    return recoverUnacknowledgedBootstrap({ fetcher, apiBase, repository, token, refName: normalizedRef, requestTimeoutMs });
  }
  if (!response?.ok) {
    // A concurrent creator may have won. Re-read once; never retry POST.
    releaseResponseContext(response, { abort: true });
    return recoverUnacknowledgedBootstrap({ fetcher, apiBase, repository, token, refName: normalizedRef, requestTimeoutMs });
  }
  let acknowledgement;
  try {
    acknowledgement = await jsonBody(response, requestTimeoutMs);
  } catch {
    return recoverUnacknowledgedBootstrap({ fetcher, apiBase, repository, token, refName: normalizedRef, requestTimeoutMs });
  }
  if (acknowledgement?.ref !== normalizedRef || typeof acknowledgement.object?.sha !== "string"
      || !/^[0-9a-f]{40}$/i.test(acknowledgement.object.sha)) {
    return recoverUnacknowledgedBootstrap({ fetcher, apiBase, repository, token, refName: normalizedRef, requestTimeoutMs });
  }
  const observed = await observeBootstrappedRef({
    fetcher, apiBase, repository, token, refName: normalizedRef, requestTimeoutMs,
  });
  if (observed.ref_sha !== acknowledgement.object.sha) {
    fail("live fence ref bootstrap readback did not prove the created ref");
  }
  return bootstrapReceipt(observed, true);
}

/** Future at-action only: arm the fixed ref/document with an owned compare. */
export async function setLiveFenceWindow({
  token,
  repository,
  windowId,
  expiresAt,
  refName = WORKER_DEPLOY_FENCE_REF,
  fencePath = WORKER_DEPLOY_FENCE_PATH,
  baseRef = DEFAULT_LIVE_FENCE_BASE_REF,
  apiBase = GITHUB_ACTIONS_API_BASE,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
} = {}) {
  const fetcher = requireFetch(fetchImpl);
  const normalizedWindow = requireValue(windowId, "windowId");
  const normalizedExpiresAt = normalizeExpiry(expiresAt, now);
  let bootstrap = null;
  let current = await readLiveFenceState({
    token,
    repository,
    refName,
    fencePath,
    apiBase,
    fetchImpl: fetcher,
    now,
    requestTimeoutMs,
  });
  if (current.state === "ABSENT") {
    const bootstrapped = await bootstrapFenceRef({
      token, repository, refName, baseRef, apiBase, fetcher, requestTimeoutMs,
    });
    bootstrap = {
      bootstrap_post: bootstrapped.bootstrap_post,
      bootstrap_acknowledgement: bootstrapped.bootstrap_acknowledgement,
      bootstrap_creator: bootstrapped.bootstrap_creator,
    };
    const document = await readFenceDocumentAtRef({
      fetcher, apiBase, repository, token, refName, fencePath,
      refSha: bootstrapped.ref_sha, now, requestTimeoutMs, allowMissing: true,
    });
    current = document.missing
      ? {
        state: "ABSENT",
        fenced: false,
        absence_proven: true,
        ref_name: bootstrapped.ref_name,
        ref_sha: bootstrapped.ref_sha,
        fence_path: fencePath,
        observed_at: now.toISOString(),
      }
      : document;
  }
  if (current.state === "RELEASED" && current.window_id === normalizedWindow) {
    fail("cannot re-authorize a retired fence window");
  }
  if (current.fenced && current.window_id !== normalizedWindow) {
    fail(`live fence arm refuses foreign window (${current.window_id})`);
  }
  if (current.state === "PRESENT" && current.window_id === normalizedWindow
      && current.expires_at === normalizedExpiresAt) {
    return { ...current, ...bootstrap, idempotent: true, write_acknowledged: false };
  }
  const next = {
    status: "ACTIVE",
    window_id: normalizedWindow,
    generation: current.generation ? current.generation + 1 : 1,
    expires_at: normalizedExpiresAt,
    file_sha: current.file_sha || undefined,
  };
  await writeFenceDocument({
    token,
    repository,
    refName,
    fencePath,
    state: next,
    apiBase,
    fetcher,
    requestTimeoutMs,
  });
  const observed = await readLiveFenceState({
    token,
    repository,
    refName,
    fencePath,
    apiBase,
    fetchImpl: fetcher,
    now,
    requestTimeoutMs,
  });
  if (observed.state !== "PRESENT" || observed.window_id !== normalizedWindow
      || observed.generation !== next.generation || observed.expires_at !== normalizedExpiresAt) {
    fail("live fence arm readback did not prove the owned window");
  }
  return {
    ...observed,
    ...bootstrap,
    write_acknowledged: true,
  };
}

/** Future at-action only: retire exactly the owned generation, never a foreign one. */
export async function releaseLiveFenceWindow({
  token,
  repository,
  windowId,
  generation,
  restoreProof,
  refName = WORKER_DEPLOY_FENCE_REF,
  fencePath = WORKER_DEPLOY_FENCE_PATH,
  apiBase = GITHUB_ACTIONS_API_BASE,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
} = {}) {
  const fetcher = requireFetch(fetchImpl);
  const current = await readLiveFenceState({
    token, repository, refName, fencePath, apiBase, fetchImpl: fetcher, now, requestTimeoutMs,
  });
  if (current.state !== "PRESENT" || current.window_id !== requireValue(windowId, "windowId")
      || current.generation !== generation) {
    fail("live fence release requires the exact active owned generation");
  }
  if (!restoreProof || restoreProof.restored !== true
      || restoreProof.window_id !== current.window_id
      || restoreProof.generation !== current.generation
      || typeof restoreProof.observed_at !== "string"
      || !Number.isFinite(Date.parse(restoreProof.observed_at))) {
    fail("live fence release requires a proof-bound restoration of the exact generation");
  }
  await writeFenceDocument({
    token, repository, refName, fencePath,
    state: {
      status: "RELEASED",
      window_id: current.window_id,
      generation: current.generation,
      expires_at: current.expires_at,
      restored_at: restoreProof.observed_at,
      file_sha: current.file_sha,
    },
    apiBase, fetcher, requestTimeoutMs,
  });
  const observed = await readLiveFenceState({
    token, repository, refName, fencePath, apiBase, fetchImpl: fetcher, now, requestTimeoutMs,
  });
  if (observed.state !== "RELEASED" || observed.window_id !== current.window_id || observed.generation !== current.generation) {
    fail("live fence release readback did not prove the retired generation");
  }
  return { ...observed, write_acknowledged: true };
}

function responseLink(response, relation) {
  const link = response?.headers?.get?.("link") || response?.headers?.get?.("Link") || "";
  const match = link.split(",").map((part) => part.trim()).find((part) => new RegExp(`rel="${relation}"`).test(part));
  return match?.match(/^<([^>]+)>/)?.[1] || null;
}

async function readRunsPage({ fetcher, url, token, requestTimeoutMs, status }) {
  const response = await boundedFetch(fetcher, url, { method: "GET", headers: githubHeaders(token) }, requestTimeoutMs);
  if (!response?.ok) {
    releaseResponseContext(response, { abort: true });
    fail(`deploy-run drain read failed with HTTP ${response?.status ?? "unknown"}`);
  }
  const body = await jsonBody(response, requestTimeoutMs);
  if (!Array.isArray(body?.workflow_runs)) fail("deploy-run drain response omitted workflow_runs");
  const runs = body.workflow_runs.map((run) => {
    if (!run || (typeof run.id !== "number" && typeof run.id !== "string")) {
      fail("deploy-run drain response contained an invalid run");
    }
    return { id: run.id, status: run.status || status, name: run.name || null, path: run.path || null };
  });
  return { runs, next: responseLink(response, "next") };
}

export async function listActiveDeployRuns({
  token,
  repository,
  workflow = WORKER_DEPLOY_FENCE_WORKFLOW,
  statuses = ["queued", "in_progress", "waiting", "requested", "pending"],
  apiBase = GITHUB_ACTIONS_API_BASE,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
  maxPages = DEFAULT_LIVE_DRAIN_MAX_PAGES,
} = {}) {
  const fetcher = requireFetch(fetchImpl);
  const workflowName = requireValue(workflow, "WORKER_DEPLOY_FENCE_WORKFLOW");
  positiveInteger(maxPages, "live drain max pages");
  const active = [];
  for (const status of statuses) {
    const normalizedStatus = requireValue(status, "workflow run status");
    let url = githubApiUrl({
      apiBase,
      repository,
      path: `/actions/workflows/${encodeURIComponent(workflowName)}/runs?status=${encodeURIComponent(normalizedStatus)}&per_page=100&page=1`,
    });
    let page = 0;
    while (url) {
      page += 1;
      if (page > maxPages) fail(`deploy-run drain pagination exceeded ${maxPages} pages`);
      const result = await readRunsPage({ fetcher, url, token, requestTimeoutMs, status: normalizedStatus });
      active.push(...result.runs);
      url = result.next || (result.runs.length === 100
        ? `${githubApiUrl({ apiBase, repository, path: `/actions/workflows/${encodeURIComponent(workflowName)}/runs?status=${encodeURIComponent(normalizedStatus)}&per_page=100&page=${page + 1}` })}`
        : null);
    }
  }
  const unique = new Map(active.map((run) => [String(run.id), run]));
  return [...unique.values()];
}

/**
 * Future at-action only: arm the fixed fence, drain every active/pending page,
 * and return a receipt bound to the final observed fence state. This function
 * is never called by the deploy workflow in this phase.
 */
export async function drainLiveWindow({
  token,
  repository,
  windowId,
  expiresAt,
  refName = WORKER_DEPLOY_FENCE_REF,
  fencePath = WORKER_DEPLOY_FENCE_PATH,
  workflow = WORKER_DEPLOY_FENCE_WORKFLOW,
  apiBase = GITHUB_ACTIONS_API_BASE,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  maxPolls = 30,
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  pollDelayMs = 1_000,
  receiptPath = null,
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
  maxPages = DEFAULT_LIVE_DRAIN_MAX_PAGES,
} = {}) {
  if (!Number.isInteger(maxPolls) || maxPolls < 1) fail("maxPolls must be positive");
  const arm = await setLiveFenceWindow({
    token, repository, windowId, expiresAt, refName, fencePath, apiBase, fetchImpl, now: now(), requestTimeoutMs,
  });
  let lastActive = [];
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    lastActive = await listActiveDeployRuns({
      token, repository, workflow, apiBase, fetchImpl, requestTimeoutMs, maxPages,
    });
    if (lastActive.length === 0) {
      const observed = await readLiveFenceState({
        token, repository, refName, fencePath, apiBase, fetchImpl, now: now(), requestTimeoutMs,
      });
      if (observed.state !== "PRESENT" || observed.window_id !== windowId || observed.generation !== arm.generation) {
        fail("cannot issue a drained receipt without a current active fence");
      }
      const receipt = {
        schema: LIVE_FENCE_RECEIPT_SCHEMA,
        outcome: "DRAINED",
        window_id: windowId,
        generation: observed.generation,
        expires_at: observed.expires_at,
        ref_name: observed.ref_name,
        ref_sha: observed.ref_sha,
        fence_path: observed.fence_path,
        file_sha: observed.file_sha,
        observed_at: observed.observed_at,
        polls: poll,
        active_runs: [],
        write_acknowledged: arm.write_acknowledged,
        bootstrap_post: arm.bootstrap_post || null,
        bootstrap_acknowledgement: arm.bootstrap_acknowledgement || null,
        bootstrap_creator: arm.bootstrap_creator || null,
      };
      if (receiptPath) writeDurableJson(receiptPath, receipt);
      return receipt;
    }
    if (poll < maxPolls) await sleep(pollDelayMs);
  }
  fail(`cannot issue drained receipt while deploy-worker runs remain active: ${lastActive.map((run) => `${run.id}:${run.status}`).join(",")}`);
}

export function fenceRoot(env = process.env) {
  const configured = env.WORKER_DEPLOY_FENCE_ROOT;
  if (typeof configured !== "string" || configured.trim() === "") {
    fail("WORKER_DEPLOY_FENCE_ROOT is required; refusing a per-process fallback");
  }
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function fenceWindow(env = process.env) {
  return requireValue(env.WORKER_DEPLOY_FENCE_WINDOW, "WORKER_DEPLOY_FENCE_WINDOW");
}

export function writerIdentity(env = process.env) {
  if (env.WORKER_DEPLOY_OWNER) return `local:${requireValue(env.WORKER_DEPLOY_OWNER, "WORKER_DEPLOY_OWNER")}`;
  const fields = [
    "GITHUB_REPOSITORY",
    "GITHUB_WORKFLOW",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
    "GITHUB_SHA",
  ];
  const values = fields.map((field) => requireValue(env[field], field));
  return `github:${values.join("/")}`;
}

function paths(root) {
  return {
    root,
    state: join(root, "state.json"),
    lock: join(root, "lock"),
  };
}

function readState(root) {
  const target = paths(root).state;
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    fail(`state is unreadable: ${error.message}`);
  }
}

function writeState(root, value) {
  const target = paths(root).state;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const next = `${target}.next`;
  const fd = openSync(next, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, target);
  const parentFd = openSync(dirname(target), "r");
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

function writeDurableJson(target, value) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const next = `${target}.next`;
  const fd = openSync(next, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, target);
  const parentFd = openSync(dirname(target), "r");
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

function lock(root, owner) {
  const target = paths(root).lock;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(target, { mode: 0o700 });
    const ownerPath = join(target, "owner");
    const ownerFd = openSync(ownerPath, "w", 0o600);
    try {
      writeFileSync(ownerFd, `${owner}\n`);
      fsyncSync(ownerFd);
    } finally {
      closeSync(ownerFd);
    }
    return target;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const prior = readState(root);
    fail(`another writer holds the fence${prior?.owner ? ` (${prior.owner})` : ""}`);
  }
}

function unlock(root, lockPath) {
  if (!lockPath) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // A failed cleanup is visible on the next fail-closed admission.
  }
}

function assertRecord(record, owner, windowId, now) {
  if (!record || record.schema !== WORKER_DEPLOY_FENCE_SCHEMA) fail("state schema is missing or invalid");
  if (record.active !== true) fail("fence is not active");
  if (record.owner !== owner) fail("current writer does not own the fence");
  if (record.window_id !== windowId) fail("current writer is outside the fence window");
  if (!Number.isInteger(record.generation) || record.generation < 1) fail("generation is invalid");
  const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(expires) || now.getTime() >= expires) fail("fence has expired");
  return record;
}

export function acquire({
  root = fenceRoot(),
  env = process.env,
  now = new Date(),
  ttlMs = Number(env.WORKER_DEPLOY_FENCE_TTL_MS || DEFAULT_FENCE_TTL_MS),
} = {}) {
  const owner = writerIdentity(env);
  const windowId = fenceWindow(env);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail("WORKER_DEPLOY_FENCE_TTL_MS must be positive");
  const prior = readState(root);
  if (prior?.active === true) {
    assertRecord(prior, owner, windowId, now);
    return { ...prior, idempotent: true };
  }
  if (prior?.draining === true && prior.window_id === windowId) {
    fail("fence window is draining; refusing a new writer");
  }
  const lockPath = lock(root, owner);
  try {
    const current = readState(root);
    if (current?.active === true) {
      assertRecord(current, owner, windowId, now);
      return { ...current, idempotent: true };
    }
    if (current?.draining === true && current.window_id === windowId) {
      fail("fence window is draining; refusing a new writer");
    }
    const record = {
      schema: WORKER_DEPLOY_FENCE_SCHEMA,
      active: true,
      draining: false,
      window_id: windowId,
      owner,
      generation: Number.isInteger(current?.generation) ? current.generation + 1 : 1,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    };
    writeState(root, record);
    return record;
  } finally {
    unlock(root, lockPath);
  }
}

export function assertCurrentWriter({ root = fenceRoot(), env = process.env, now = new Date() } = {}) {
  const owner = writerIdentity(env);
  return assertRecord(readState(root), owner, fenceWindow(env), now);
}

export function release({ root = fenceRoot(), env = process.env, now = new Date() } = {}) {
  const owner = writerIdentity(env);
  const windowId = fenceWindow(env);
  const lockPath = lock(root, owner);
  try {
    const record = assertRecord(readState(root), owner, windowId, now);
    const released = {
      ...record,
      active: false,
      released_at: now.toISOString(),
    };
    writeState(root, released);
    return released;
  } finally {
    unlock(root, lockPath);
  }
}

/** Mark the current window draining without revoking an admitted writer. */
export function drain({ root = fenceRoot(), env = process.env, now = new Date() } = {}) {
  const owner = writerIdentity(env);
  const windowId = fenceWindow(env);
  const lockPath = lock(root, owner);
  try {
    const record = readState(root);
    if (!record || record.schema !== WORKER_DEPLOY_FENCE_SCHEMA) fail("state schema is missing or invalid");
    if (record.window_id !== windowId) fail("drain window does not match current state");
    const next = {
      ...record,
      draining: true,
      drain_requested_at: record.drain_requested_at || now.toISOString(),
      drain_requested_by: owner,
    };
    writeState(root, next);
    return next;
  } finally {
    unlock(root, lockPath);
  }
}

export async function run({
  command,
  args = [],
  root = fenceRoot(),
  env = process.env,
} = {}) {
  requireValue(command, "command");
  acquire({ root, env });
  assertCurrentWriter({ root, env });
  try {
    return await new Promise((resolveResult, reject) => {
      const child = spawn(command, args, { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveResult({ code: code ?? 1, signal }));
    });
  } finally {
    release({ root, env });
  }
}

function parseCommand(argv) {
  const command = argv[2];
  if (["acquire", "assert", "release", "drain", "live-assert", "live-drain"].includes(command)) {
    return { command };
  }
  if (command === "run" && argv[3] === "--" && argv[4]) {
    return { command, executable: argv[4], args: argv.slice(5) };
  }
  fail("usage: worker_deploy_fence.mjs <acquire|assert|release|drain|live-assert|live-drain|run -- command [args...]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const parsed = parseCommand(process.argv);
    const env = process.env;
    if (parsed.command === "live-assert") {
      await assertLiveWriterWindow({
        token: env.GITHUB_TOKEN,
        repository: env.GITHUB_REPOSITORY,
        windowId: fenceWindow(env),
        refName: env.WORKER_DEPLOY_FENCE_REF || WORKER_DEPLOY_FENCE_REF,
        fencePath: env.WORKER_DEPLOY_FENCE_PATH || WORKER_DEPLOY_FENCE_PATH,
      });
    } else if (parsed.command === "live-drain") {
      await drainLiveWindow({
        token: env.GITHUB_TOKEN,
        repository: env.GITHUB_REPOSITORY,
        windowId: fenceWindow(env),
        expiresAt: requireValue(env.WORKER_DEPLOY_FENCE_EXPIRES_AT, "WORKER_DEPLOY_FENCE_EXPIRES_AT"),
        refName: env.WORKER_DEPLOY_FENCE_REF || WORKER_DEPLOY_FENCE_REF,
        fencePath: env.WORKER_DEPLOY_FENCE_PATH || WORKER_DEPLOY_FENCE_PATH,
        workflow: env.WORKER_DEPLOY_FENCE_WORKFLOW || WORKER_DEPLOY_FENCE_WORKFLOW,
        receiptPath: env.WORKER_DEPLOY_FENCE_RECEIPT || null,
      });
    } else {
      const options = { root: fenceRoot(), env };
      if (parsed.command === "acquire") acquire(options);
      else if (parsed.command === "assert") assertCurrentWriter(options);
      else if (parsed.command === "release") release(options);
      else if (parsed.command === "drain") drain(options);
      else {
        const result = await run({ ...options, command: parsed.executable, args: parsed.args });
        process.exitCode = result.code;
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
