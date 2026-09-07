#!/usr/bin/env node
/**
 * The board decisions section rendered in every shipping language.
 *
 * The board documents are built in English, so the translated copy is read from
 * the module that produces the section rather than from a served page. What is
 * recorded is what a reviewer needs to see: that no key leaked through
 * unresolved, that the language and direction are declared, that the copy is
 * actually different from the English string, and that the publisher's own
 * words -- the case number, the authority, the quoted passage -- stayed in the
 * language they were published in and kept their own direction inside an
 * otherwise right-to-left page.
 *
 * Written to stdout for `tools/capture_community_board_decisions_evidence.py`.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import {
  communityBoardResolutionViewForBoard,
  renderCommunityBoardDecisionsSection,
} from "../site/community_board_resolution_pilot.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;
const RTL = new Set(["ar", "ur"]);

const pilot = JSON.parse(readFileSync(
  new URL("../site/data/community_board_resolution_pilot.json", import.meta.url), "utf8"));
const textOf = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const escape = (value) => String(value).replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

/**
 * A publisher value is isolated when the element that holds it declares English
 * and a left-to-right direction, so an Arabic or Urdu page does not reorder a
 * case number or an address the source printed one way.
 */
function isolated(html, value) {
  const needle = escape(value);
  let from = 0;
  let seen = 0;
  for (;;) {
    const at = html.indexOf(needle, from);
    if (at === -1) return seen > 0;
    // Walk out through the open elements above the value. A declaration on an
    // ancestor governs the value by inheritance, so a quoted passage inside a
    // <p> within an isolated <blockquote> is isolated.
    const before = html.slice(0, at);
    const opens = [...before.matchAll(/<([a-z]+)\b([^>]*)>/g)];
    const closes = new Map();
    for (const close of before.matchAll(/<\/([a-z]+)>/g)) {
      closes.set(close[1], (closes.get(close[1]) || 0) + 1);
    }
    const stack = [];
    for (const open of opens) {
      const name = open[1];
      const closed = closes.get(name) || 0;
      stack.push({ name, attrs: open[2], closed });
    }
    const governing = stack.slice(-4).some((tag) => tag.attrs.includes('lang="en" dir="ltr"'));
    if (!governing) return false;
    seen += 1;
    from = at + needle.length;
  }
}

const rows = [];
for (const boardId of Object.keys(pilot.by_board)) {
  const view = communityBoardResolutionViewForBoard(pilot, boardId);
  const english = textOf(renderCommunityBoardDecisionsSection(view, { lang: "en" }));
  // The values that must survive translation untouched: the board's own title
  // for the item, the reviewing authority, the case number, and the operative
  // passage. The title-role passage is the document's own heading line, which
  // the section does not render, so it is not among them.
  const publisherValues = view.decisions.flatMap((decision) => [
    decision.title,
    decision.authority?.authority_name,
    decision.authority?.case_number,
    ...decision.passages.filter((passage) => passage.role !== "title").map((passage) => passage.text),
  ].filter(Boolean));
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const html = renderCommunityBoardDecisionsSection(view, { lang });
    const text = textOf(html);
    rows.push({
      board_id: boardId,
      lang,
      direction: RTL.has(lang) ? "rtl" : "ltr",
      declares_language: lang === "en" || html.includes(`lang="${lang}"`),
      declares_direction: lang === "en" || html.includes(`dir="${RTL.has(lang) ? "rtl" : "ltr"}"`),
      differs_from_english: lang === "en" || text !== english,
      unresolved_keys: (text.match(/\bcbrp_[a-z_]+\b/g) || []),
      publisher_text_kept: publisherValues.every((value) => html.includes(escape(value))),
      publisher_text_isolated: publisherValues.every((value) => isolated(html, value)),
      source_reachable: view.decisions.every((decision) => html.includes(decision.document.document_url)),
      render_content_sha256: createHash("sha256").update(html).digest("hex"),
      bytes: Buffer.byteLength(html),
    });
  }
}

process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
