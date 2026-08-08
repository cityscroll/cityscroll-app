/**
 * Shared static document chrome for CityScroll node pages.
 *
 * Notice detail (SPA shell) is the visual standard; standalone exam / parcel /
 * pack / digest / agency documents inherit the same layout grammar through
 * these helpers + civic-documents.css node-* rules.
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

export function renderCivicDocumentMast({ current, siteBase = "", surfaceClass = "" } = {}) {
  const base = String(siteBase || "").replace(/\/$/, "");
  const home = base || "/";
  const links = [
    ["now", "Now"],
    ["near-you", "Near you"],
    ["following", "Following"],
    ["browse", "Browse"],
  ].map(([route, label]) => `<a${current === route ? ' aria-current="page"' : ""} href="${esc(`${base}/${route}/`)}">${label}</a>`).join("");
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
    return `<button class="${esc(classes)}" type="button"${attrPairs}>${esc(item.label)}</button>`;
  }).join("");
  const exportAttr = exportClass ? ` data-export-class="${esc(exportClass)}"` : "";
  return `<nav class="${esc(classNames("node-actions", extraClass))}" aria-label="${esc(ariaLabel)}"${exportAttr}>${buttons}</nav>`;
}

/** Shared footer line for static node documents. */
export function renderNodeFooter({ text = "CityScroll is an unofficial reading aid.", aboutHref = "/about.html", extraClass = "" } = {}) {
  return `<footer class="${esc(classNames("node-footer", extraClass))}">${esc(text)} <a href="${esc(aboutHref)}">About the data</a>.</footer>`;
}
