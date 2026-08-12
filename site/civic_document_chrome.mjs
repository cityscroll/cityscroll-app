/**
 * Shared static document chrome for CityScroll node pages.
 *
 * Notice detail (SPA shell) is the visual standard; standalone exam / parcel /
 * pack / digest / agency documents inherit the same layout grammar through
 * these helpers + civic-documents.css node-* rules.
 *
 * Reader-surface rules (same shape as `sub_outreach.mjs` / property commercial
 * sale-gate): show a section only when it has reader-usable content; never
 * announce our own data gaps ("not yet shown", "not available"); never print
 * internal pipeline keys or subject-reference ids. Keep plain-English source
 * attribution and world-fact limits (e.g. individual scores are not public).
 */

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function prefixFor(assetPrefix) {
  const value = String(assetPrefix || "/");
  return value.endsWith("/") ? value : `${value}/`;
}

function classNames(...parts) {
  return parts.flatMap((part) => String(part || "").split(/\s+/)).filter(Boolean).join(" ");
}

import { officialSourceLink } from "./affordance_grammar.mjs";
import { appendPlaceContextToHref, placeContextFromScope } from "./place_context.mjs";

export function renderCivicDocumentAssets(assetPrefix = "/") {
  const prefix = prefixFor(assetPrefix);
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${esc(`${prefix}brand.css`)}">
<link rel="stylesheet" href="${esc(`${prefix}civic-documents.css`)}">`;
}

function brandMark() {
  return `<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M14 5h29l8 8v42a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M43 5v10h8M20 23h22M20 31h22M20 49v-9h7v9h5V36h7v13h5v-6h7" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function renderCivicDocumentMast({ current, siteBase = "", surfaceClass = "", scope = null } = {}) {
  const base = String(siteBase || "").replace(/\/$/, "");
  const home = base || "/";
  const context = placeContextFromScope(scope);
  const links = [
    ["now", "Now"],
    ["near-you", "Near you"],
    ["following", "Following"],
    ["browse", "Browse"],
  ].map(([route, label]) => {
    const href = appendPlaceContextToHref(`${base}/${route}/`, context);
    return `<a${current === route ? ' aria-current="page"' : ""} href="${esc(href)}">${label}</a>`;
  }).join("");
  const classes = classNames("document-mast", surfaceClass);
  return `<header class="${esc(classes)}"><div class="document-mast-inner">
    <a class="document-brand brand-lockup home" href="${esc(home)}">${brandMark()}<span>CityScroll</span></a>
    <nav class="document-nav" aria-label="Primary">${links}</nav>
  </div></header>`;
}

/** Shared back-link row above a node-document hero. */
export function renderNodeBack({ href, label, extraClass = "" } = {}) {
  if (!href || !label) return "";
  return `<p class="${esc(classNames("node-back", extraClass))}"><a href="${esc(href)}">${esc(label)}</a></p>`;
}

/**
 * Shared document actions (Watch / Copy / Print / Download).
 * `items` is an array of { kind: "link"|"button", label, href?, primary?, attrs? }.
 */
export function renderNodeActions(items = [], { ariaLabel = "Document actions", exportClass = "", extraClass = "" } = {}) {
  const buttons = (Array.isArray(items) ? items : []).map((item) => {
    const classes = classNames("node-action", item.primary ? "primary" : "", item.className || "");
    const attrPairs = Object.entries(item.attrs || {})
      .filter(([, value]) => value != null && value !== false)
      .map(([key, value]) => value === true ? ` ${esc(key)}` : ` ${esc(key)}="${esc(value)}"`)
      .join("");
    if (item.kind === "link") {
      return `<a class="${esc(classes)}" href="${esc(item.href || "#")}"${item.external ? ' target="_blank" rel="noopener noreferrer"' : ""}${attrPairs}>${esc(item.label)}</a>`;
    }
    if (item.kind === "source") {
      return officialSourceLink({ href: item.href || "#", label: item.label, className: classes, attributes: item.attrs || {}, escape: esc });
    }
    return `<button class="${esc(classes)}" type="button"${attrPairs}>${esc(item.label)}</button>`;
  }).join("");
  const exportAttr = exportClass ? ` data-export-class="${esc(exportClass)}"` : "";
  return `<nav class="${esc(classNames("node-actions", extraClass))}" aria-label="${esc(ariaLabel)}"${exportAttr}>${buttons}</nav>`;
}

/** Shared footer line for static node documents. */
export function renderNodeFooter({ text = "CityScroll is an unofficial reading aid.", aboutHref = "/about.html", extraClass = "" } = {}) {
  return `<footer class="${esc(classNames("node-footer", extraClass))}">${esc(text)} <a href="${esc(aboutHref)}">About the data</a>.</footer>`;
}

/**
 * Render a node-document section only when body markup is non-empty.
 * Empty / whitespace-only body → "" (omit the whole section, including heading).
 * Mirrors sub-outreach and property-commercial "paint nothing when absent".
 */
export function renderNodeSection({
  heading,
  body,
  headingId = "",
  exportClass = "",
  extraClass = "",
  attrs = {},
} = {}) {
  const content = String(body ?? "").trim();
  if (!content) return "";
  const h2 = heading
    ? (headingId
      ? `<h2 id="${esc(headingId)}">${esc(heading)}</h2>`
      : `<h2>${esc(heading)}</h2>`)
    : "";
  const exportAttr = exportClass ? ` data-export-class="${esc(exportClass)}"` : "";
  const labelled = headingId ? ` aria-labelledby="${esc(headingId)}"` : "";
  const attrPairs = Object.entries(attrs || {})
    .filter(([, value]) => value != null && value !== false && value !== "")
    .map(([key, value]) => value === true ? ` ${esc(key)}` : ` ${esc(key)}="${esc(value)}"`)
    .join("");
  return `<section class="${esc(classNames("node-section", extraClass))}"${labelled}${exportAttr}${attrPairs}>${h2}${content}</section>`;
}

/** Reader-facing source links and context, when a document needs them. */
export function renderNodeProvenance({
  note,
  sourceItems = [],
  heading = "",
  headingId = "",
  exportClass = "object_provenance",
  extraClass = "",
} = {}) {
  const prose = String(note ?? "").trim();
  const items = (Array.isArray(sourceItems) ? sourceItems : [])
    .map((item) => {
      if (item == null) return "";
      if (typeof item === "string") {
        const text = item.trim();
        return text ? `<li>${text}</li>` : "";
      }
      const label = String(item.label || item.html || "").trim();
      if (!label) return "";
      // `html` is trusted pre-escaped markup from the caller (e.g. an <a>).
      if (item.html) return `<li>${item.html}</li>`;
      if (item.href) {
        return `<li>${officialSourceLink({ href: item.href, label, className: "node-source-link", escape: esc })}</li>`;
      }
      return `<li>${esc(label)}</li>`;
    })
    .filter(Boolean);
  if (!prose && !items.length) return "";
  const list = items.length ? `<ul>${items.join("")}</ul>` : "";
  const body = `${prose ? `<p>${prose.includes("<") ? prose : esc(prose)}</p>` : ""}${list}`;
  return renderNodeSection({
    heading,
    body,
    headingId,
    exportClass,
    extraClass,
  });
}

/**
 * Phrases that announce our own data gaps on node pages. Used by tests and
 * surface-load sampling — not for silent auto-rewrites of free text.
 */
export const NODE_PAGE_ABSENCE_PHRASES = Object.freeze([
  "not published",
  "sources and limits",
  "unpublished values remain unlinked",
  "not yet shown",
  "not yet shown here",
  "not available yet",
  "not available in this",
  "no data",
  "none in this materialization",
  "are not yet shown",
  "post-cycle aggregates are not yet",
  "snapshot source keys",
  "subject reference:",
  "materialization methods:",
]);

/** Detect reader-facing absence / internal-id cruft in rendered node HTML. */
export function detectNodePageCruft(html) {
  const text = String(html || "").toLowerCase();
  return NODE_PAGE_ABSENCE_PHRASES.filter((phrase) => text.includes(phrase));
}

/** Fail closed at the final node-document render boundary. */
export function gateNodePageRender(html) {
  const cruft = detectNodePageCruft(html);
  if (cruft.length) {
    throw new Error(`Node page contains reader-facing cruft: ${cruft.join(", ")}`);
  }
  return html;
}
