#!/usr/bin/env node
/**
 * Deterministic notice-shaped document for the typography browser harness.
 * Uses the same civic document token sheets as production notice routes.
 */
import { writeFileSync } from "node:fs";
import { renderCivicDocumentAssets, renderCivicDocumentMast } from "../../site/civic_document_chrome.mjs";

const NOTICE_ID = "20240829105";
const title = "City Sanctuary Facility for Families with Children";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · CityScroll</title>
<link rel="canonical" href="https://cityscroll.org/notices/${NOTICE_ID}/">
${renderCivicDocumentAssets("/")}
<script type="module" src="/report_issue.mjs"></script>
</head>
<body data-notice-id="${NOTICE_ID}">
<a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "browse", siteBase: "/", surfaceClass: "notice-document-mast" })}
<main id="main" class="node-document notice-route" tabindex="-1">
  <header class="node-head">
    <p class="node-kicker">Award notice</p>
    <h1>${title}</h1>
    <p class="guide-help">Agency Homeless Services published this award. Contract identifier
      <code class="pin" data-typography-role="identifier">CT107120258801626</code> stays monospace.
    </p>
  </header>
  <section class="node-section" data-typography-role="body">
    <h2>Essential facts</h2>
    <p>Readers move from homepage search into this notice and its contract without changing reading family.</p>
    <form class="node-actions" action="#" method="get">
      <label data-typography-role="label" for="typography-notice-query">Filter facts</label>
      <input data-typography-role="input" id="typography-notice-query" type="text" name="q" value="sanctuary">
      <button data-typography-role="button" type="submit">Apply</button>
    </form>
  </section>
</main>
</body>
</html>
`;

const out = process.argv[2];
if (out) writeFileSync(out, html);
else process.stdout.write(html);
