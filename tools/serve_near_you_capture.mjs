import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { buildNearYou } from "./build_worker_route_read_models.mjs";
import { primaryDocumentOutputs } from "./build_primary_documents.mjs";
import edgeWorker from "../site/pages_edge.mjs";
import { BROWSE_FACETS } from "../site/browse_view.mjs";

const root = join(process.cwd(), "site");
// Exercise the same retained membership slices as the deployed route, not its
// tiny no-binding floor fixture (which cannot prove neighborhood relevance).
const activity = JSON.parse(await readFile(join(root, "data/district_activity.json"), "utf8"));
const geography = JSON.parse(await readFile(join(root, "data/community_board_geography_lookup.json"), "utf8"));
const materialized = buildNearYou(activity, geography, "capture");
const values = new Map(materialized.entries.map(({key, value}) => [key, value]));
values.set("route-read-model:near-you:manifest:v1", JSON.stringify(materialized.manifest));
const env = { ALERT_STATE: { get: async (key) => values.get(key) ?? null } };

// Offline fault controls for browser journeys: a request may name route slices
// whose KV read fails, as `x-near-you-fixture-fail: citywide:meetings=reject`
// (controls: reject, timeout, corrupt, missing). The Worker handler and loader
// run unchanged over a request-scoped store, so nothing is cached across
// requests and the served data is never altered.
export const FIXTURE_FAIL_HEADER = "x-near-you-fixture-fail";
const FAULT_READ_TIMEOUT_MS = 200;
function faultedEnv(header) {
  const controls = new Map();
  for (const part of String(header || "").split(",")) {
    const [sliceId, control] = part.trim().split("=");
    const key = materialized.manifest.slices[sliceId];
    if (key && ["reject", "timeout", "corrupt", "missing"].includes(control)) controls.set(key, control);
  }
  if (!controls.size) return env;
  return {
    NEAR_YOU_READ_MODEL_TIMEOUT_MS: FAULT_READ_TIMEOUT_MS,
    ALERT_STATE: {
      async get(key) {
        const control = controls.get(key);
        if (control === "reject") throw new Error("fixture read failure");
        if (control === "timeout") return new Promise(() => {});
        if (control === "corrupt") return "{not-json";
        if (control === "missing") return null;
        return values.get(key) ?? null;
      },
    },
  };
}

// Links out of Near You (Browse collections, record search and the record
// pages they open) go through the Pages edge handler, as in production. Its
// static assets are this checkout's site/ tree plus the Browse documents,
// which are build output: they are rendered in memory on first use, never
// written into the working tree.
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".pbf": "application/x-protobuf",
  ".svg": "image/svg+xml",
});
const EDGE_ROUTE = /^\/(?:browse(?:\/[^/]+)?\/?|search\/?|meetings\/[^/]+\/?|exams\/\d+\/?|notices\/[^/]+\/?)$/;
const NOTICE_READ_MODEL_PATH = "/__fixture/notice";
// The published tree places capabilities/ (and the site/ modules they import)
// beside the site root; serve both from the checkout.
const REPOSITORY_MODULE_PREFIXES = Object.freeze(["capabilities/", "site/"]);
let builtDocuments = null;

function contentType(pathname) {
  const match = pathname.match(/\.[a-z0-9]+$/i);
  return CONTENT_TYPES[match?.[0]?.toLowerCase()] || "text/html; charset=utf-8";
}

function safeRelative(pathname) {
  return normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "").replace(/^([.][.][/\\])+/, "");
}

function browseDocuments() {
  if (builtDocuments) return builtDocuments;
  const priorWarn = console.warn;
  // The builder reports retained-meeting coverage on the console; this
  // server's output carries only its base URL.
  console.warn = () => {};
  try {
    builtDocuments = new Map(primaryDocumentOutputs().map(([path, content]) => [
      `/${relative(root, path).replaceAll("\\", "/")}`,
      content,
    ]));
  } finally {
    console.warn = priorWarn;
  }
  return builtDocuments;
}

async function assetBody(pathname) {
  const route = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const built = browseDocuments();
  for (const candidate of [route, `${route}/index.html`]) {
    if (built.has(candidate)) return { body: built.get(candidate), path: candidate };
  }
  const relativePath = safeRelative(route);
  const base = REPOSITORY_MODULE_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ? process.cwd() : root;
  for (const candidate of [relativePath, join(relativePath, "index.html")]) {
    try {
      return { body: await readFile(join(base, candidate)), path: candidate };
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

/** Pages static-asset binding over site/ plus the in-memory Browse documents. */
export const ASSETS = {
  async fetch(input) {
    const url = new URL(input.url || input);
    const asset = await assetBody(url.pathname === "/" ? "/index.html" : url.pathname);
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(asset.body, { status: 200, headers: { "content-type": contentType(asset.path) } });
  },
};

let contractRows = null;
export async function noticeReadModel(url) {
  // The Worker notice read model, answered from the same open-contracts
  // snapshot the Contracts collection lists. An id outside it is absent.
  contractRows ??= new Map(
    JSON.parse(await readFile(join(root, BROWSE_FACETS.contracts.dataPath), "utf8"))[BROWSE_FACETS.contracts.rowsKey]
      .map((row) => [String(row.request_id), row]),
  );
  const row = contractRows.get(String(url.searchParams.get("id") || ""));
  return row
    ? Response.json({ row, civic_time: null })
    : Response.json({ row: null }, { status: 404 });
}

async function send(response, upstream, method, rewrite = null) {
  let body = method === "HEAD" ? "" : Buffer.from(await upstream.arrayBuffer());
  if (rewrite && body.length) body = rewrite(body.toString("utf8"));
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const base = `http://${request.headers.host}`;
  // Bare `/` is the Near You root, as on the Worker-routed apex.
  if (url.pathname === "/near-you" || url.pathname === "/near-you/" || url.pathname === "/near-you/deferred.json"
    || (url.pathname === "/" && !url.search)) {
    const upstream = await handleNearYou(
      new Request(url, { method: request.method }),
      faultedEnv(request.headers[FIXTURE_FAIL_HEADER]),
    );
    await send(response, upstream, request.method, (body) => body.replaceAll("https://cityscroll.org", base));
    return;
  }
  if (url.pathname === NOTICE_READ_MODEL_PATH) {
    await send(response, await noticeReadModel(url), request.method);
    return;
  }
  const repositoryModule = REPOSITORY_MODULE_PREFIXES.some((prefix) => url.pathname.startsWith(`/${prefix}`));
  if (EDGE_ROUTE.test(url.pathname) || repositoryModule) {
    const upstream = repositoryModule
      ? await ASSETS.fetch(new Request(url))
      : await edgeWorker.fetch(new Request(url, { method: request.method }), {
        ASSETS,
        NOTICE_READ_MODEL: `${base}${NOTICE_READ_MODEL_PATH}`,
      });
    await send(response, upstream, request.method);
    return;
  }
  const relativePath = safeRelative(url.pathname);
  try {
    const body = await readFile(join(root, relativePath === "/" ? "index.html" : relativePath));
    const contentType = /\.(mjs|js)$/.test(url.pathname)
      ? "text/javascript"
      : url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".json")
          ? "application/json"
          : url.pathname.endsWith(".pbf") ? "application/x-protobuf" : "text/html";
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    console.log(`http://127.0.0.1:${address.port}`);
  });
}
