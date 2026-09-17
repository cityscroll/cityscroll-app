#!/usr/bin/env node
/**
 * Deterministic contract-shaped document for the typography browser harness.
 * Uses the same civic document token sheets as production procurement routes.
 */
import { writeFileSync } from "node:fs";
import { renderCivicDocumentAssets, renderCivicDocumentMast } from "../../site/civic_document_chrome.mjs";

const CONTRACT_ID = "procurement:contract:CT107120258801626";
const title = "City Sanctuary Facility for Families with Children, Comfort Inn Sheepsheads Bay";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · CityScroll</title>
<link rel="canonical" href="https://cityscroll.org/procurements/${encodeURIComponent(CONTRACT_ID)}">
${renderCivicDocumentAssets("/")}
<script type="module" src="/report_issue.mjs"></script>
</head>
<body data-procurement-id="${CONTRACT_ID}">
<a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "browse", siteBase: "/", surfaceClass: "procurement-document-mast" })}
<main id="main" class="node-document" tabindex="-1">
  <header class="node-head">
    <p class="node-kicker">Registered contract</p>
    <h1>${title}</h1>
    <p class="guide-help">Contract
      <code class="pin" data-typography-role="identifier">CT107120258801626</code>
      keeps an identifier role beside reading copy.
    </p>
  </header>
  <section class="node-section" data-typography-role="body">
    <h2>Contract facts</h2>
    <p>Equivalent controls on this detail page share the reading family with homepage search.</p>
    <form class="node-actions" action="#" method="get">
      <label data-typography-role="label" for="typography-contract-query">Search facts</label>
      <input data-typography-role="input" id="typography-contract-query" type="text" name="q" value="BHRAGS">
      <button data-typography-role="button" type="submit">Search</button>
    </form>
  </section>
</main>
</body>
</html>
`;

const out = process.argv[2];
if (out) writeFileSync(out, html);
else process.stdout.write(html);
