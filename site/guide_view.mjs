/**
 * Documents for the public guide at /guide/.
 *
 * The guide home and every guide article are plain static documents: prose,
 * headings, source links and ordinary navigation, with no script of their own.
 * A reader with JavaScript switched off gets the whole article, and an article
 * says at the step itself when the product surface it sends them to needs
 * script to work.
 *
 * Layout comes from the shared civic-document chrome and the node-* rules in
 * civic-documents.css, so the guide inherits the site's design system instead
 * of introducing a second one; guide.css adds only the few rules that have no
 * equivalent there.
 */

import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeFooter,
} from "./civic_document_chrome.mjs";
import { GUIDE_GROUPS, escapeHtml as esc } from "./guide_article_source.mjs";

export const GUIDE_HOME_URL = "/guide/";
const TYPE_LABELS = Object.freeze({
  tutorial: "Tutorial",
  "how-to": "How-to guide",
  explanation: "Explanation",
  reference: "Reference",
});

/**
 * Written where an article would otherwise be listed. A reader is told the
 * section is real and still filling up, which is true, rather than being shown
 * an empty heading that reads like something failed to load.
 */
const EMPTY_GROUP_NOTE = "Articles for this section are being written. Each one is listed here once an editor has checked it against the live site.";

function linkHtml({ label, href }) {
  const external = /^https?:/i.test(href);
  const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${esc(href)}"${attrs}>${esc(label)}</a>`;
}

function head({ title, description, canonical }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">${renderCivicDocumentAssets("/")}
<link rel="stylesheet" href="/guide.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "guide", surfaceClass: "guide-mast" })}`;
}

function foot() {
  return `${renderNodeFooter({ text: "CityScroll is an unofficial reading aid. Check each record at its official source.", extraClass: "guide-footer" })}
</body></html>`;
}

function reviewLine(date) {
  return `<p class="node-meta guide-reviewed">Last reviewed ${esc(date)}</p>`;
}

function articleListItem(article) {
  return `<li class="guide-article-item">
      <a class="guide-article-link" href="${esc(article.url)}">${esc(article.title)}</a>
      <span class="guide-article-question">${esc(article.reader_question)}</span>
      <span class="guide-article-meta">${esc(TYPE_LABELS[article.type])} · Last reviewed ${esc(article.last_reviewed)}</span>
    </li>`;
}

function groupSection(group, articles, description) {
  // Sources are loaded in filename order, which is not the order a reader should
  // meet them in. A section lists its articles by their own id, so "follow a
  // search" precedes "follow a Community Board" the way the section was written.
  const published = articles
    .filter((article) => article.type === group.type)
    .sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
  const body = published.length
    ? `<ul class="guide-article-list">\n${published.map(articleListItem).join("\n")}\n    </ul>`
    : `<p class="guide-group-empty">${esc(EMPTY_GROUP_NOTE)}</p>`;
  return `<section class="node-section guide-group" aria-labelledby="group-${esc(group.id)}">
    <h2 id="group-${esc(group.id)}">${esc(group.label)}</h2>
    ${description}
    ${body}
  </section>`;
}

/** The guide home: an orientation and the four reader-facing sections. */
export function renderGuideHome(home, articles) {
  const sections = home.sections;
  const groups = GUIDE_GROUPS
    .map((group) => groupSection(group, articles, sections.get(group.label)))
    .join("\n  ");
  return `${head({
    title: home.page_title,
    description: home.description,
    canonical: "https://cityscroll.org/guide/",
  })}
<main class="node-document guide-document" id="main">
  <header class="node-hero guide-hero">
    <p class="node-kicker">Guide</p>
    <h1>${esc(home.title)}</h1>
    <p class="node-lede">${esc(home.purpose)}</p>
    ${reviewLine(home.last_reviewed)}
  </header>
  <section class="node-section guide-orientation" aria-labelledby="guide-orientation">
    <h2 id="guide-orientation">Where to start</h2>
    ${sections.get("Orientation")}
  </section>
  ${groups}
  <section class="node-section guide-language" aria-labelledby="guide-language">
    <h2 id="guide-language">About this guide</h2>
    ${sections.get("About this guide") || ""}
  </section>
</main>
${foot()}`;
}

/**
 * Two notices an editor can attach to an article, and the only review metadata a
 * reader is ever shown.
 *
 * A correction is written when an article is known to be misleading: it says what
 * changed, in place, instead of the article being pulled. A historical note is
 * written when an article teaches with a dated example whose opportunity has
 * closed: it stops the example inviting an action the reader can no longer take,
 * while the method it teaches stays on the page. Neither is generated, and neither
 * appears unless an editor wrote it.
 */
function noticeSection(article) {
  const notices = [];
  if (article.correction) {
    notices.push(`<p class="guide-notice guide-correction"><strong>Correction:</strong> ${esc(article.correction)}</p>`);
  }
  if (article.historical_note) {
    notices.push(`<p class="guide-notice guide-historical"><strong>About this example:</strong> ${esc(article.historical_note)}</p>`);
  }
  if (!notices.length) return "";
  return `
  <aside class="guide-notices" aria-label="Notices about this article">
    ${notices.join("\n    ")}
  </aside>`;
}

function relatedSection(article) {
  if (!article.related.length) return "";
  return `<section class="node-section guide-related" aria-labelledby="guide-related">
    <h2 id="guide-related">Related pages</h2>
    <ul>${article.related.map((item) => `<li>${linkHtml(item)}</li>`).join("")}</ul>
  </section>`;
}

function sourcesSection(article) {
  if (!article.sources.length) return "";
  return `<section class="node-section guide-sources" aria-labelledby="guide-sources">
    <h2 id="guide-sources">Sources used in this article</h2>
    <ul>${article.sources.map((item) => `<li>${linkHtml(item)}</li>`).join("")}</ul>
  </section>`;
}

/**
 * The section a reader found the article in, and what kind of article it is. For
 * Reference those are the same word, and a reader gains nothing from being told it
 * twice, so it is said once.
 */
function articleKicker(article) {
  const section = article.group.label;
  const type = TYPE_LABELS[article.type];
  return section === type ? section : `${section} · ${type}`;
}

/** One guide article. */
export function renderGuideArticle(article) {
  return `${head({
    title: article.page_title || `${article.title} · CityScroll`,
    description: article.description,
    canonical: `https://cityscroll.org${article.url}`,
  })}
<main class="node-document guide-document guide-article" id="main">
  <p class="node-back"><a href="${esc(GUIDE_HOME_URL)}">Back to the guide</a></p>
  <header class="node-hero guide-hero">
    <p class="node-kicker">${esc(articleKicker(article))}</p>
    <h1>${esc(article.title)}</h1>
    <p class="node-lede">${esc(article.purpose)}</p>
    <p class="guide-question">${esc(article.reader_question)}</p>
    ${reviewLine(article.last_reviewed)}
  </header>${noticeSection(article)}
  <div class="guide-body">
${article.bodyHtml}
  </div>
  ${relatedSection(article)}
  ${sourcesSection(article)}
  <p class="guide-return">${linkHtml(article.return_to_task)}</p>
</main>
${foot()}`;
}
