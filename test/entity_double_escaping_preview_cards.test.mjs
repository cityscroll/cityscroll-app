// Characterization: entity double-escaping on preview cards (notice 20220525018 class).
//
// Field case: full notice view shows typographic quotes for &ldquo;Agency&rdquo;; the
// meetings preview card used to show the literal string "&ldquo;Agency&rdquo;" because
// plainText left entities encoded and escUiHtml re-escaped the ampersand.
//
// Doctrine: one owner (site/text_clean.mjs) — decode → truncate on plain text → escape once.
// Covers every common named/numeric entity and every excerpt surface wired through excerptHtml.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  cleanNoticeText,
  decodeHtmlEntities,
  excerptHtml,
  excerptPlain,
  plainText,
} from "../site/text_clean.mjs";
import { snippet } from "../worker/src/lib/notices.mjs";
import { matchEvidence as workerMatchEvidence } from "../worker/src/lib/digest.mjs";
import { loadSite } from "./contract/site_extract.mjs";

const require = createRequire(import.meta.url);
const { normalizeHearingRow } = require("../site/hearing_location.js");

const { cleanText, excerptHtml: siteExcerptHtml, digTitleHTML, digEvidenceHTML, matchEvidence } =
  loadSite(
    ["cleanText", "excerptHtml", "enTitle", "locateAnyTerm", "matchEvidence", "digTitleHTML", "digEvidenceHTML"],
    {
      extra: `
        const t = (k, vars) => {
          if (k === "untitled") return "Untitled";
          if (k === "digest_match_snippet_html") return "Matched: “" + (vars && vars.snippet || "") + "”";
          if (k === "digest_match_unknown_html") return "Matched: " + (vars && vars.term || "");
          return k;
        };
      `,
    }
  );

// ---- Before-behavior (pinned for the symptom) --------------------------------
// Pre-fix card path: entity string survives plainText, then escUiHtml turns & into &amp;.
// We assert the FIXED path no longer produces that class of output.

const FIELD_CASE =
  'The New York City Industrial Development Agency (the &ldquo;Agency&rdquo;) is empowered';

test("field case 20220525018: owner decodes curly quotes to plain Unicode", () => {
  const plain = cleanNoticeText(FIELD_CASE);
  assert.match(plain, /\u201CAgency\u201D/);
  assert.doesNotMatch(plain, /&ldquo;|&rdquo;/);
  assert.equal(plainText(FIELD_CASE), plain);
  assert.equal(cleanText(FIELD_CASE), plain);
});

test("field case: hearing card excerpt escapes once (no literal &amp;ldquo;)", () => {
  const rec = normalizeHearingRow({
    request_id: "20220525018",
    short_title: "NYCIDA SUPPLEMENTAL NOTICE OF PUBLIC HEARING - JUNE 9, 2022",
    additional_description_1: `<p>${FIELD_CASE}</p>`,
    section_name: "Public Hearings and Meetings",
    agency_name: "New York City Industrial Development Agency",
    event_date: "2022-06-09T00:00:00.000",
  });
  // description is fully decoded plain text after normalize
  assert.match(rec.description, /\u201CAgency\u201D/);
  assert.doesNotMatch(rec.description, /&ldquo;/);

  const html = excerptHtml(rec.description, 260);
  assert.match(html, /\u201CAgency\u201D/);
  assert.doesNotMatch(html, /&amp;ldquo;|&amp;rdquo;|&ldquo;|&rdquo;/);
  // site excerptHtml agrees with the module owner
  assert.equal(siteExcerptHtml(rec.description, 260), html);
});

// ---- Entity variants ---------------------------------------------------------

const ENTITY_VARIANTS = [
  { name: "ldquo/rdquo", raw: "the &ldquo;Agency&rdquo;", expect: /\u201CAgency\u201D/ },
  { name: "rsquo", raw: "building&rsquo;s tenants", expect: /building\u2019s tenants/ },
  { name: "amp", raw: "A &amp; B", expect: /A & B/ },
  { name: "sect", raw: "see &sect; 695", expect: /see \u00A7 695/ },
  { name: "nbsp", raw: "word&nbsp;gap", expect: /word\u00A0gap|word gap/ },
  { name: "numeric decimal", raw: "the &#8220;City&#8221;", expect: /\u201CCity\u201D/ },
  { name: "numeric hex", raw: "the &#x201C;State&#x201D;", expect: /\u201CState\u201D/ },
  { name: "double-encoded", raw: "the &amp;ldquo;Agency&amp;rdquo;", expect: /\u201CAgency\u201D/ },
  { name: "quot", raw: "(&quot;HPD&quot;)", expect: /\("HPD"\)/ },
];

for (const { name, raw, expect } of ENTITY_VARIANTS) {
  test(`entity variant: ${name}`, () => {
    const plain = cleanNoticeText(`<p>${raw}</p>`);
    assert.match(plain, expect, `decoded: ${JSON.stringify(plain)}`);
    const html = excerptHtml(`<p>${raw}</p>`, 200);
    assert.doesNotMatch(html, /&amp;ldquo;|&amp;rdquo;|&amp;rsquo;|&amp;sect;|&amp;nbsp;/);
    // after escape, plain ampersand becomes &amp; once when the decoded text has &
    if (name === "amp") assert.match(html, /A &amp; B/);
  });
}

// ---- Truncation safety -------------------------------------------------------

test("truncation never cuts inside an entity sequence", () => {
  // If we truncated the raw entity form at a short length, &ldquo; would break mid-token.
  const raw = "AAA &ldquo;Agency&rdquo; BBB";
  // maxLen lands where an entity-aware cut matters
  const plain = excerptPlain(raw, 8); // "AAA “Age" or similar on decoded form
  assert.doesNotMatch(plain, /&l|ldquo|#$/);
  assert.ok(!plain.includes("&") || plain.endsWith("…") || /&/.test(cleanNoticeText(raw)));
  // Explicit: decoded length, not entity-string length
  const decoded = cleanNoticeText(raw);
  assert.equal(excerptPlain(raw, 5), decoded.slice(0, 5) + "…");
});

// ---- XSS discipline on every touched surface ---------------------------------

const XSS_RAW =
  'Friendly lead &ldquo;Title&rdquo; then &lt;script&gt;alert(1)&lt;/script&gt; and <img src=x onerror=alert(1)> trail';

test("XSS: script-bearing notice stays inert on excerptHtml / dig surfaces / worker match", () => {
  const plain = cleanNoticeText(XSS_RAW);
  assert.match(plain, /<script>alert\(1\)<\/script>/); // decoded for matching
  assert.doesNotMatch(plain, /<img/); // tags stripped before decode of remaining entities

  const html = excerptHtml(XSS_RAW, 400);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /onerror=/i);
  assert.match(html, /\u201CTitle\u201D/);

  const title = cleanText("Watch &ldquo;us&rdquo; &lt;b&gt;bold&lt;/b&gt;");
  const ev = matchEvidence(title, cleanText(XSS_RAW), ["script"]);
  assert.equal(ev?.field, "description");
  const digEv = digEvidenceHTML(ev);
  // match may split the token with <mark>, but angle brackets stay escaped
  assert.match(digEv, /&lt;/);
  assert.match(digEv, /&gt;/);
  assert.doesNotMatch(digEv, /<script>alert/i);
  assert.doesNotMatch(digEv, /&lt;<script/i);

  const digTitle = digTitleHTML(title, matchEvidence(title, "", ["us"]));
  assert.match(digTitle, /&lt;b&gt;|&lt;\/b&gt;|\u201Cus\u201D/);
  assert.doesNotMatch(digTitle, /<b>bold<\/b>/);

  // feed/hearing card surface (excerptHtml) and full-notice surface share the owner
  const cardHtml = siteExcerptHtml(XSS_RAW, 400);
  const noticeHtml = siteExcerptHtml(XSS_RAW, 900);
  for (const surface of [html, cardHtml, noticeHtml, digEv, digTitle]) {
    assert.doesNotMatch(surface, /<script>/i, "surface must not contain raw script tags");
    assert.doesNotMatch(surface, /onerror=/i);
  }

  // Worker match evidence also fully decodes before slicing
  const wEv = workerMatchEvidence("title", XSS_RAW, ["script"]);
  assert.equal(wEv?.field, "description");
  assert.match(`${wEv.before}${wEv.hit}${wEv.after}`, /<script>alert\(1\)<\/script>/);
});

// ---- Shared owner agreement across surfaces ----------------------------------

test("snippet (API/MCP) and excerptPlain share decode+truncate discipline", () => {
  const raw = FIELD_CASE + " " + "x".repeat(300);
  const a = excerptPlain(raw, 80);
  const b = snippet(raw, 80);
  assert.equal(a, b);
  assert.match(a, /\u201CAgency\u201D/);
  assert.ok(a.endsWith("…"));
});

test("site cleanText / excerptHtml stay aligned with text_clean owner", () => {
  for (const { raw } of ENTITY_VARIANTS) {
    assert.equal(cleanText(raw), cleanNoticeText(raw));
    assert.equal(siteExcerptHtml(raw, 40), excerptHtml(raw, 40));
  }
});

test("decodeHtmlEntities is exported and handles the field-case named pair", () => {
  assert.equal(decodeHtmlEntities("&ldquo;Agency&rdquo;"), "\u201CAgency\u201D");
});
