#!/usr/bin/env node
/**
 * PHC-05 evidence helper: render the rulemaking participation guide's formal
 * public-record consequence receipt (site/app/rules.mjs's ruleParticipationHTML()
 * / ruleClosedConsequenceHTML(), built from site/rules_participation.mjs's
 * buildRuleCommentConsequence()) for the dense/partial/sparse/closed states
 * named in the card. Writes each rendered fragment, wrapped in a minimal
 * document using the real /brand.css and the .rule-participation rules from
 * site/index.html's inline stylesheet, under site/.phc05-capture-tmp/ so
 * tools/capture_phc05_rulemaking_comment_consequence.py can serve it locally
 * and run axe-core against it. Prints the case manifest (id, path, assertion)
 * as JSON to stdout.
 *
 *   node tools/capture_phc05_rulemaking_comment_consequence.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildRuleCommentConsequence } from "../site/rules_participation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "site/.phc05-capture-tmp");
const NOW = "2026-07-01";

// --- Extract the real render functions from site/app/rules.mjs (no reimplementation). ---
const rulesSrc = readFileSync(path.join(ROOT, "site/app/rules.mjs"), "utf8");
const i18nSrc = readFileSync(path.join(ROOT, "site/i18n.js"), "utf8");

function extractFn(name) {
  const start = rulesSrc.indexOf("function " + name + "(");
  if (start === -1) throw new Error(`function ${name} not found in site/app/rules.mjs`);
  let depth = 0, seen = false;
  for (let j = rulesSrc.indexOf("{", start); j < rulesSrc.length; j++) {
    if (rulesSrc[j] === "{") { depth++; seen = true; }
    else if (rulesSrc[j] === "}" && --depth === 0 && seen) return rulesSrc.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);
const escUiHtml = (s) => String(s == null ? "" : s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", "\"": "&quot;" }[c]));

const render = new Function(
  "t", "escUiHtml", "EXT_ATTRS", "extSR", "window",
  extractFn("ruleDateLabel") +
  extractFn("ruleHearingSeparateHTML") +
  extractFn("ruleParticipationHTML") +
  extractFn("ruleClosedConsequenceHTML") +
  "return { ruleParticipationHTML, ruleClosedConsequenceHTML };"
)(t, escUiHtml, 'target="_blank" rel="noopener noreferrer"', () => '<span class="sr-only"> (opens in new tab)</span>', windowStub);

// --- The real .rule-participation styling lives inline in site/index.html. ---
const indexHtml = readFileSync(path.join(ROOT, "site/index.html"), "utf8");
const styleMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("could not find <style> block in site/index.html");
const inlineStyle = styleMatch[1];

function wrapDocument(title, fragment) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/brand.css">
<style>${inlineStyle}</style>
</head>
<body>
<main id="main">
<div id="drules" data-export-class="rule_lifecycle">${fragment}</div>
</main>
</body>
</html>`;
}

const CASES = [
  {
    id: "open_dense",
    assertion:
      "A2/A3/A6/A7: an open comment window with a channel, deadline, and a distinct future " +
      "hearing renders the primary comment action, the consequence receipt below the " +
      "channel/deadline, and a separate hearing note with its own date.",
    rec: {
      stage: "comment-open",
      agency: "Taxi and Limousine Commission",
      title: "Driver relief penalty reduction",
      nyc_rules: {
        comment_by_date: "2026-08-15",
        comment_url: "https://rules.cityofnewyork.us/tlc-relief#comment",
        hearing_date: "2026-08-05",
      },
    },
  },
  {
    id: "open_partial",
    assertion:
      "A6: an open comment window with only a deadline (no published hearing) renders the " +
      "consequence receipt with no fabricated hearing note.",
    rec: {
      stage: "comment-open",
      nyc_rules: { comment_by_date: "2026-08-15", comment_url: "https://rules.cityofnewyork.us/x#comment" },
    },
  },
  {
    id: "closed_dense",
    assertion:
      "A4: a comment window with a published deadline now in the past removes the submission " +
      "control but keeps the public-record consequence explanation and the distinct hearing " +
      "date that preceded it.",
    rec: {
      stage: "comment-open",
      agency: "Department of Transportation",
      title: "City-owned bicycle racks",
      nyc_rules: {
        comment_by_date: "2026-06-01",
        comment_url: "https://rules.cityofnewyork.us/dot-bikes#comment",
        hearing_date: "2026-05-20",
      },
    },
  },
  {
    id: "closed_partial",
    assertion:
      "A4/A6: a closed window with no published hearing keeps the consequence explanation with " +
      "no fabricated hearing note.",
    rec: { stage: "comment-open", nyc_rules: { comment_by_date: "2026-05-01" } },
  },
  {
    id: "sparse_no_evidence",
    assertion:
      "A1/A6: a rulemaking record with no comment-period evidence at all (e.g. adopted with no " +
      "retained comment history) renders no consequence receipt and no fabricated closed state.",
    rec: { stage: "effective", agency: "Department of Buildings", title: "Elevator inspection cycle", nyc_rules: { effective_date: "2026-08-01" } },
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const manifestCases = CASES.map(({ id, assertion, rec }) => {
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  const fragment = consequence
    ? (consequence.open ? render.ruleParticipationHTML(consequence) : render.ruleClosedConsequenceHTML(consequence))
    : "";
  const html = wrapDocument(id, fragment);
  const file = path.join(OUT_DIR, `${id}.html`);
  writeFileSync(file, html, "utf8");
  return {
    id,
    assertion,
    path: `/.phc05-capture-tmp/${id}.html`,
    consequence_present: !!consequence,
    consequence_open: consequence ? consequence.open : null,
  };
});

process.stdout.write(JSON.stringify(manifestCases, null, 2));
