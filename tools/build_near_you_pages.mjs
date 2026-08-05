#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildNearYouViewModel, renderNearYouDocument } from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import {
  commonNearYouPath,
  nearYouUrlFromScope,
  NEAR_YOU_COMMON_BOROUGHS as BOROUGHS,
  NEAR_YOU_COMMON_LENSES as LENSES,
  scopeWithPlace,
} from "../site/near_you_scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const EDGE_BASE = "https://api.cityscroll.org/near-you";

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
  return commonScopes().map((scope) => {
    const publicPath = commonNearYouPath(scope);
    const urlForScope = (next) => commonNearYouPath(next)
      || nearYouUrlFromScope(next, { base: EDGE_BASE });
    const view = buildNearYouViewModel(scope, activity, boundaries, {
      canonicalBase: EDGE_BASE,
      urlForScope,
    });
    return {
      path: outputPath(publicPath),
      html: renderNearYouDocument(view, { assetPrefix: "/" }),
    };
  });
}

const check = process.argv.includes("--check");
let changed = 0;
for (const document of buildDocuments()) {
  const current = existsSync(document.path) ? readFileSync(document.path, "utf8") : null;
  if (current === document.html) continue;
  changed += 1;
  if (!check) {
    mkdirSync(dirname(document.path), { recursive: true });
    writeFileSync(document.path, document.html);
    console.log("wrote", document.path);
  }
}
if (check && changed) {
  console.error(`${changed} Near-you build documents are stale`);
  process.exit(1);
}
console.log(check ? "near-you pages ok" : `near-you pages built (${changed} changed)`);
