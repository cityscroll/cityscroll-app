#!/usr/bin/env node

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverClientModuleGraph } from "./client_module_graph.mjs";

const JAVASCRIPT_CONTENT_TYPE = /(?:^|\/)javascript(?:;|$)/i;

function parseArgs(argv) {
  const options = { siteDir: "_site", origin: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--site-dir" || argument === "--origin") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      const key = argument === "--site-dir" ? "siteDir" : "origin";
      options[key] = value;
    } else if (argument === "--help") {
      console.log("Usage: node tools/check_client_module_assets.mjs [--site-dir DIR] [--origin URL]");
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  return options;
}

function localContentType(urlPath) {
  if (/\.m?js$/i.test(urlPath)) return "application/javascript; charset=utf-8";
  if (/\.html?$/i.test(urlPath)) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function startArtifactServer(siteDir) {
  const root = resolve(siteDir);
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(root, `.${requestPath}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(400);
      response.end("invalid path");
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": localContentType(requestPath) });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Not found</title>");
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function checkModule(url, origin) {
  const response = await fetch(new URL(url, `${origin}/`));
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !JAVASCRIPT_CONTENT_TYPE.test(contentType)) {
    throw new Error(`${url}: HTTP ${response.status}, content-type=${contentType || "<missing>"}`);
  }
  await response.arrayBuffer();
}

export async function checkClientModuleAssets({ siteDir = "_site", origin = null } = {}) {
  const graph = discoverClientModuleGraph({ rootDir: resolve(siteDir) });
  if (graph.missing.length) {
    throw new Error(`Client module graph has missing assets: ${graph.missing.join(", ")}`);
  }

  let server = null;
  let checkOrigin = origin;
  if (!checkOrigin) {
    ({ server, origin: checkOrigin } = await startArtifactServer(siteDir));
  }
  try {
    for (const url of graph.modules.keys()) await checkModule(url, checkOrigin);
  } finally {
    if (server) await new Promise((resolveServer) => server.close(resolveServer));
  }
  return { moduleCount: graph.modules.size, roots: graph.roots.length, origin: checkOrigin };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2));
  checkClientModuleAssets(options)
    .then(({ moduleCount, roots, origin }) => {
      console.log(`client module assets ok: ${moduleCount} modules from ${roots} HTML entrypoints via ${origin}`);
    })
    .catch((error) => {
      console.error(`client module assets failed: ${error.message}`);
      process.exitCode = 1;
    });
}
