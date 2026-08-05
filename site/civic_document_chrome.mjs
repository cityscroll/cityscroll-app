function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function prefixFor(assetPrefix) {
  const value = String(assetPrefix || "/");
  return value.endsWith("/") ? value : `${value}/`;
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
  const classes = ["document-mast", surfaceClass].filter(Boolean).join(" ");
  return `<header class="${esc(classes)}"><div class="document-mast-inner">
    <a class="document-brand brand-lockup home" href="${esc(home)}">${brandMark()}<span>CityScroll</span></a>
    <nav class="document-nav" aria-label="Primary">${links}</nav>
  </div></header>`;
}
