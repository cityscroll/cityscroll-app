#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  PROJECT_CONNECTION_GROUPS,
  PROJECT_CONNECTIONS_SCHEMA_VERSION,
} from "../site/project_connections.mjs";

export const DEFAULT_PROJECT_ID = "2022M0258";
export const DEFAULT_URL = `https://api.cityscroll.org/zap-outcomes?id=${DEFAULT_PROJECT_ID}`;
export const DEFAULT_TIMEOUT_MS = 720_000;
export const DEFAULT_INTERVAL_MS = 20_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export function classifyProjectConnectionsResponse(body, projectId = DEFAULT_PROJECT_ID) {
  const section = body?.sections?.project_connections;
  if (section?.schema_version === PROJECT_CONNECTIONS_SCHEMA_VERSION
      && section?.status === "unavailable"
      && section?.reason) {
    return { ok: true, state: "unavailable" };
  }

  const evidence = body?.record?.project_connections;
  const groupIds = new Set((evidence?.groups || []).map((group) => group?.id));
  if (body?.ok !== false
      && evidence?.schema_version === PROJECT_CONNECTIONS_SCHEMA_VERSION
      && evidence?.status === "bounded"
      && evidence?.project_ref === `project:${projectId}`
      && PROJECT_CONNECTION_GROUPS.every(({ id }) => groupIds.has(id))) {
    return { ok: true, state: "available" };
  }

  return {
    ok: false,
    reason: "successful-but-incomplete 200: project_connections is neither complete nor explicitly unavailable",
  };
}

async function probe({ url, projectId, fetchImpl, requestTimeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetchImpl(`${url}${separator}_smoke=${Date.now()}`, {
      headers: { "Cache-Control": "no-cache", "User-Agent": "cityscroll-project-connections-smoke/1.0" },
      signal: controller.signal,
    });
    if (response.status !== 200) return { ok: false, reason: `HTTP ${response.status}` };
    let body;
    try { body = await response.json(); }
    catch (_error) { return { ok: false, reason: "response is not JSON" }; }
    return classifyProjectConnectionsResponse(body, projectId);
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "request timeout" : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runProjectConnectionsSmoke({
  url = DEFAULT_URL,
  projectId = DEFAULT_PROJECT_ID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const started = now();
  let attempts = 0;
  let last = { ok: false, reason: "not attempted" };
  do {
    attempts += 1;
    last = await probe({ url, projectId, fetchImpl, requestTimeoutMs });
    if (last.ok) return { ...last, attempts, url };
    if (now() - started >= timeoutMs) break;
    await sleep(intervalMs);
  } while (now() - started <= timeoutMs);
  return { ...last, attempts, url };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") opts.url = argv[++i];
    else if (argv[i] === "--project-id") opts.projectId = argv[++i];
    else if (argv[i] === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (argv[i] === "--interval-ms") opts.intervalMs = Number(argv[++i]);
    else if (argv[i] === "--request-timeout-ms") opts.requestTimeoutMs = Number(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("Usage: node tools/project_connections_smoke.mjs [--url URL] [--project-id ID] [--timeout-ms N] [--interval-ms N]");
    return 0;
  }
  const result = await runProjectConnectionsSmoke(opts);
  if (!result.ok) {
    console.error(`project-connections smoke FAILED after ${result.attempts} attempt(s): ${result.reason}`);
    return 1;
  }
  console.log(`project-connections smoke OK state=${result.state} attempts=${result.attempts}`);
  return 0;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
