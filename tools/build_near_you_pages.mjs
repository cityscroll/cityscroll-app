#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";
import {
  commonNearYouPath,
  nearYouUrlFromScope,
  NEAR_YOU_COMMON_BOROUGHS as BOROUGHS,
  NEAR_YOU_COMMON_LENSES as LENSES,
  scopeFromLensState,
} from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const CANONICAL_BASE = "https://cityscroll.org/near-you";

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function commonScopes() {
  const entries = [];
  for (const lens of LENSES) {
    const base = scopeFromLensState(lens, {});
    entries.push(base);
    for (const borough of BOROUGHS) {
      const placed = scopeWithPlace(base, { borough });
      placed.place.viewport = {
        level: "community_district",
        id: null,
        parent: borough,
        basis: "performance",
        view_box: null,
      };
      entries.push(placed);
    }
  }
  return entries;
}

function outputPath(publicPath) {
  return join(SITE, publicPath.replace(/^\/+/, ""), "index.html");
}

function buildDocuments() {
  const activity = json(join(SITE, "data/district_activity.json"));
  const boundaries = json(join(SITE, "data/district_boundaries.json"));
  const communityGeography = json(join(SITE, "data/community_board_geography_lookup.json"));
  return commonScopes().map((scope) => {
    const publicPath = commonNearYouPath(scope);
    const urlForScope = (next) => commonNearYouPath(next)
      || nearYouUrlFromScope(next, { base: CANONICAL_BASE });
    const view = buildNearYouViewModel(scope, activity, boundaries, {
      canonicalBase: CANONICAL_BASE,
      urlForScope,
      communityGeography,
    });
    const deferredParts = renderNearYouDeferredParts(view);
    return {
      path: outputPath(publicPath),
      deferredPath: join(SITE, publicPath.replace(/^\/+/, ""), "deferred.json"),
      html: renderNearYouDocument(view, {
        assetPrefix: "/",
        deferredDataHref: `${publicPath}deferred.json`,
      }),
      deferred: `${JSON.stringify({
        schema: "cityscroll.near_you_deferred.v1",
        href: `${publicPath}deferred.json`,
        results_html: deferredParts.resultsHtml,
        bags_html: deferredParts.bagsHtml,
      })}\n`,
    };
  });
}

const check = process.argv.includes("--check");
let changed = 0;
for (const document of buildDocuments()) {
  const current = existsSync(document.path) ? readFileSync(document.path, "utf8") : null;
  const currentDeferred = existsSync(document.deferredPath)
    ? readFileSync(document.deferredPath, "utf8")
    : null;
  if (current === document.html && currentDeferred === document.deferred) continue;
  changed += 1;
  if (!check) {
    mkdirSync(dirname(document.path), { recursive: true });
    writeFileSync(document.path, document.html);
    writeFileSync(document.deferredPath, document.deferred);
    console.log("wrote", document.path);
  }
}
if (check && changed) {
  console.error(`${changed} Near-you build documents are stale`);
  process.exit(1);
}
console.log(check ? "near-you pages ok" : `near-you pages built (${changed} changed)`);
