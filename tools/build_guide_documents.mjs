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

import { entityPivotRouteStatus } from "../site/edge_summary.mjs";
import { parseGuideArticle, parseGuideHome, GuideSourceError } from "../site/guide_article_source.mjs";
import {
  GUIDE_SOURCE_COVERAGE_INCLUDE,
  GuideSourceCoverageError,
  guideSourceCoverageTable,
} from "../site/guide_source_coverage.mjs";
import { renderGuideArticle, renderGuideHome, GUIDE_HOME_URL } from "../site/guide_view.mjs";
import { ROUTE_INVENTORY } from "./pages_route_parity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const GUIDE = join(SITE, "guide");
const HOME_SOURCE = join(GUIDE, "_home.md");
const ARTICLE_DIR = join(GUIDE, "_articles");
const SOURCE_CONTRACTS = join(SITE, "data", "source_contracts.json");

/**
 * Tables an owner generates, which an article places with a `::: <name>` line.
 * Reading the registry here keeps `site/guide_source_coverage.mjs` a pure function
 * of it, and keeps the reference page from carrying a second copy of the inventory.
 */
function generatedTables() {
  return {
    [GUIDE_SOURCE_COVERAGE_INCLUDE]: guideSourceCoverageTable(
      JSON.parse(readFileSync(SOURCE_CONTRACTS, "utf8")),
    ),
  };
}

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

/**
 * A link to one civic record — a notice, an organisation, an exam — cannot be
 * checked against the tree, because those documents are materialized at deploy
 * time from rolling publisher data rather than tracked here. Requiring one to be
 * present would either fail every worked example or make the build depend on a
 * record still being in the publisher's window, which the repository's own
 * invariant forbids.
 *
 * So the shape is checked instead, against the closed route inventory the edge
 * surfaces already use: a mistyped family still fails the build, and that a
 * particular record is live is proved where it belongs, by loading it — see
 * docs/evidence/public-user-guide/.
 */
function servedAsRecordDocument(href) {
  return entityPivotRouteStatus(href).verified;
}

function outputPathFor(url) {
  return join(SITE, `${url.replace(/^\/+|\/+$/g, "")}/index.html`);
}

/**
 * Reading order inside a section, which is the order the article ids give: the
 * explanation of what a record is comes before the one about how records connect.
 * Sorting by file name would order a section alphabetically, which is no order at
 * all to a reader. An id the pattern does not recognise sorts after the ones it
 * does, by its own text, rather than silently jumping the queue.
 */
function byReadingOrder(left, right) {
  const parse = (id) => /^([A-Z]+)(\d+)$/.exec(id);
  const [a, b] = [parse(left.id), parse(right.id)];
  if (a && b) return a[1].localeCompare(b[1]) || Number(a[2]) - Number(b[2]);
  if (a) return -1;
  if (b) return 1;
  return left.id.localeCompare(right.id);
}

export function loadGuide() {
  const home = parseGuideHome("site/guide/_home.md", readFileSync(HOME_SOURCE, "utf8"));
  const includes = generatedTables();
  const articles = readdirSync(ARTICLE_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseGuideArticle(`site/guide/_articles/${name}`, readFileSync(join(ARTICLE_DIR, name), "utf8"), includes))
    .sort(byReadingOrder);

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
 * build writes, to a route the site's own inventory says is served, or to a
 * published record document whose family the closed route inventory recognizes.
 * An article that links somewhere else is a broken promise to a reader, so it
 * fails the build.
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
      if (servedAsRecordDocument(href)) continue;
      failures.push(`${name}: link ${href} does not resolve to a guide page, a served route, or a published record document`);
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
    if (!(error instanceof GuideSourceError) && !(error instanceof GuideSourceCoverageError)) throw error;
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
