#!/usr/bin/env node
/**
 * Build the public guide documents from their tracked Markdown sources.
 *
 * Sources:   site/guide/_home.md, site/guide/_articles/*.md
 * Outputs:   site/guide/index.html, site/guide/<section>/<slug>/index.html
 *
 * The outputs are tracked, the same way the Following document is, so a reviewer
 * sees the rendered result of a prose change in the diff. `--check` fails when a
 * tracked document no longer matches its source.
 *
 * Nothing here reads a clock. Every date on a guide page comes from a
 * `last_reviewed` field an editor wrote after checking the article against the
 * live site, so rebuilding unchanged sources rewrites nothing.
 *
 *   node tools/build_guide_documents.mjs
 *   node tools/build_guide_documents.mjs --check
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseGuideArticle, parseGuideHome, GuideSourceError } from "../site/guide_article_source.mjs";
import { renderGuideArticle, renderGuideHome, GUIDE_HOME_URL } from "../site/guide_view.mjs";
import { ROUTE_INVENTORY } from "./pages_route_parity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const GUIDE = join(SITE, "guide");
const HOME_SOURCE = join(GUIDE, "_home.md");
const ARTICLE_DIR = join(GUIDE, "_articles");

/**
 * Routes another owner serves. The public route inventory covers the routes the
 * deploy parity sweep probes; a tracked or already-materialized document under
 * site/ covers the rest (the search document, for one, is a real route that is
 * deliberately absent from the sitemap the inventory mirrors).
 */
const SERVED_ROUTES = new Set(ROUTE_INVENTORY.map((route) => route.path));

function servedFromSiteTree(path) {
  const relative = path.replace(/^\/+/, "");
  if (!relative) return true;
  return existsSync(join(SITE, relative)) || existsSync(join(SITE, relative, "index.html"));
}

function outputPathFor(url) {
  return join(SITE, `${url.replace(/^\/+|\/+$/g, "")}/index.html`);
}

export function loadGuide() {
  const home = parseGuideHome("site/guide/_home.md", readFileSync(HOME_SOURCE, "utf8"));
  const articles = readdirSync(ARTICLE_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseGuideArticle(`site/guide/_articles/${name}`, readFileSync(join(ARTICLE_DIR, name), "utf8")));

  const seen = new Map();
  for (const article of articles) {
    for (const key of [article.id, article.url]) {
      if (seen.has(key)) throw new GuideSourceError(`two guide articles share ${JSON.stringify(key)}`);
      seen.set(key, article);
    }
  }
  return { home, articles };
}

/**
 * Every internal link on a guide page must resolve: to another guide page this
 * build writes, or to a route the site's own inventory says is served. An article
 * that links somewhere else is a broken promise to a reader, so it fails the build.
 */
export function internalLinkFailures(documents, articles) {
  const guideRoutes = new Set([GUIDE_HOME_URL, ...articles.map((article) => article.url)]);
  const failures = [];
  for (const [name, html] of documents) {
    for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const href = match[1];
      if (!href.startsWith("/")) continue;
      const path = href.split(/[?#]/)[0];
      if (guideRoutes.has(path) || SERVED_ROUTES.has(path) || servedFromSiteTree(path)) continue;
      failures.push(`${name}: link ${href} does not resolve to a guide page or a served route`);
    }
  }
  return failures;
}

export function renderGuideDocuments() {
  const { home, articles } = loadGuide();
  const documents = new Map();
  documents.set(join(SITE, "guide/index.html"), renderGuideHome(home, articles));
  for (const article of articles) {
    documents.set(outputPathFor(article.url), renderGuideArticle(article));
  }
  const failures = internalLinkFailures(
    [...documents].map(([path, html]) => [path.slice(ROOT.length + 1), html]),
    articles,
  );
  if (failures.length) throw new GuideSourceError(failures.join("\n"));
  return documents;
}

function main(argv) {
  const check = argv.includes("--check");
  let documents;
  try {
    documents = renderGuideDocuments();
  } catch (error) {
    if (!(error instanceof GuideSourceError)) throw error;
    console.error(error.message);
    return 1;
  }

  const stale = [];
  for (const [path, html] of documents) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === html) continue;
    stale.push(path.slice(ROOT.length + 1));
    if (check) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }

  if (check) {
    if (stale.length) {
      console.error(`Guide documents are stale: ${stale.join(", ")}`);
      console.error("Run: node tools/build_guide_documents.mjs");
      return 1;
    }
    console.log(`Guide documents ok (${documents.size} pages)`);
    return 0;
  }
  console.log(stale.length ? `wrote ${stale.join(", ")}` : `Guide documents unchanged (${documents.size} pages)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
