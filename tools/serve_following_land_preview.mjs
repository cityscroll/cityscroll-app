#!/usr/bin/env node
/**
 * Local Following document server for the signed-out Land geography preview
 * browser journey. Serves Worker-rendered /following plus site static assets.
 *
 * Optional env:
 *   LAND_PLACE_MEMBERSHIP_PATH — JSON file overriding the public membership index
 *   (used by the emptied-source converse control).
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleFollowing } from "../worker/src/following.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "site");
const PORT = Number(process.env.PORT || 0);

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".html": "text/html; charset=utf-8",
};

function loadMembershipOverride() {
  const path = process.env.LAND_PLACE_MEMBERSHIP_PATH;
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

const placeMembership = loadMembershipOverride();

function safeSitePath(urlPath) {
  const clean = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const relative = clean.replace(/^\/+/, "");
  const full = normalize(join(SITE, relative));
  if (!full.startsWith(SITE)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${server.address().port}`;
    const url = new URL(req.url || "/", `http://${host}`);
    if (url.pathname === "/following" || url.pathname === "/following/") {
      const request = new Request(`https://cityscroll.org${url.pathname}${url.search}`, {
        method: req.method || "GET",
        headers: { accept: "text/html" },
      });
      const options = {
        todayISO: process.env.FOLLOWING_TODAY_ISO || "2026-09-26",
        fetchImpl: async () => new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      };
      if (placeMembership !== undefined) options.placeMembership = placeMembership;
      const response = await handleFollowing(request, {}, {}, options);
      let body = await response.text();
      const origin = `http://${host}`;
      body = body
        .replaceAll("https://cityscroll.org/", `${origin}/`)
        .replaceAll("https://cityscroll.org", origin);
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      };
      res.writeHead(response.status || 200, headers);
      res.end(body);
      return;
    }
    if (url.pathname === "/following/personal") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end('<div data-session-recognized="false" data-personal-state="unrecognized"><p>Open a CityScroll email to see your watches.</p></div>');
      return;
    }
    const filePath = safeSitePath(url.pathname === "/" ? "/index.html" : url.pathname);
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const body = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(error && error.stack || error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`http://127.0.0.1:${port}\n`);
});
