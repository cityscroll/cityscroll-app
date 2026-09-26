#!/usr/bin/env node
/**
 * Local Following document server for the signed-out Land geography preview
 * browser journey. Dependency-free for retained browser CI: builds the preview
 * from the public place-membership index and Land catalog (same browse path the
 * Worker Following handler uses for Land geography scopes), then renders the
 * Following document with site modules only.
 *
 * Optional env:
 *   LAND_PLACE_MEMBERSHIP_PATH — JSON file overriding the public membership index
 *   (used by the emptied-source converse control).
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFollowingViewModel,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { landNtaWatchMatchingIds } from "../site/land_nta_watch_scope.mjs";
import { landProjectRowsFromPayload } from "../site/land_project_catalog.mjs";
import { feedItems } from "../worker/src/lib/feed.mjs";
import { normalizeGeographyKey } from "../site/scope_v0.mjs";
import suggestedTemplates from "../site/data/following_procurement_suggestions.json" with { type: "json" };
import defaultMembership from "../site/data/land_place_membership.json" with { type: "json" };
import catalogPayload from "../site/data/land_project_catalog.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "site");
const PORT = Number(process.env.PORT || 0);
const TODAY = process.env.FOLLOWING_TODAY_ISO || "2026-09-26";
const catalogRows = landProjectRowsFromPayload(catalogPayload);

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

const placeMembership = loadMembershipOverride() ?? defaultMembership;

function landGeographyKeys(filter = {}) {
  return [...new Set(
    (Array.isArray(filter.geographies) ? filter.geographies : [filter.geography])
      .map(normalizeGeographyKey)
      .filter(Boolean),
  )];
}

function previewLandGeography(watch) {
  const match = landNtaWatchMatchingIds({
    filter: watch.filter || {},
    catalogRows,
    placeMembership,
    source: "browse",
    today: TODAY,
  });
  if (match.status === "unavailable") {
    return {
      items: [],
      count: null,
      error: "The public data source is unavailable right now. The saved criteria are still shown.",
      status: "unavailable",
    };
  }
  if (match.status !== "ready") {
    return {
      items: [],
      count: null,
      error: "This scope cannot be previewed yet. You can still manage existing watches below.",
      status: null,
    };
  }
  const byId = new Map(catalogRows.map((row) => [row.project_id, row]));
  const rows = match.ids.map((id) => byId.get(id)).filter(Boolean);
  return {
    items: feedItems("rezone", rows).slice(0, 5),
    count: rows.length,
    error: null,
    status: "complete",
  };
}

function renderFollowing(url) {
  const parsed = watchFromFollowingParams(url.searchParams);
  let preview = { items: [], count: null, error: null, status: null };
  if (parsed.requested && parsed.scopeStatus !== "unrecognized_scope") {
    const watch = { lens: parsed.lens, filter: parsed.filter };
    if (watch.lens === "land" && landGeographyKeys(watch.filter).length) {
      preview = previewLandGeography(watch);
    }
  }
  const view = buildFollowingViewModel({
    ...parsed,
    matchCount: parsed.matchCount ?? preview.count,
    previewItems: preview.items,
    previewError: preview.error,
    previewStatus: preview.status || null,
  }, suggestedTemplates);
  return renderFollowingDocument(view, {
    assetPrefix: "/",
    siteBase: "",
  });
}

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
      let body = renderFollowing(url);
      const origin = `http://${host}`;
      body = body
        .replaceAll("https://cityscroll.org/", `${origin}/`)
        .replaceAll("https://cityscroll.org", origin)
        .replaceAll("https://api.cityscroll.org", origin);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    if (url.pathname === "/following/personal") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end('<div data-session-recognized="false" data-personal-state="unrecognized"><p>Open a CityScroll email to see your watches.</p><p class="following-personal-recovery"><a href="#create" data-following-create-recovery>Create a watch</a></p></div>');
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
