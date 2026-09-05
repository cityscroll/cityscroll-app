// PHC-05 — the formal public-record consequence of a rulemaking comment,
// stated inside the existing rulemaking participation guide (site/app/rules.mjs),
// below the channel/deadline and above the phase spine. Confined to Agency
// Rules objects; carries the card's A1-A7 and its negative rule.
//
//   node --test test/rule_comment_consequence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SITE_SOURCE } from "./helpers/site_source.mjs";
import {
  buildRulesParticipationPath,
  buildRuleCommentConsequence,
} from "../site/rules_participation.mjs";

const src = SITE_SOURCE;
const i18nSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "site", "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in site source`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);
const escUiHtml = (s) => String(s == null ? "" : s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", "\"": "&quot;" }[c]));

const env = new Function(
  "t", "escUiHtml", "EXT_ATTRS", "extSR", "window",
  extractFn("ruleDateLabel") +
  extractFn("ruleHearingSeparateHTML") +
  extractFn("ruleParticipationHTML") +
  extractFn("ruleClosedConsequenceHTML") +
  "return { ruleDateLabel, ruleHearingSeparateHTML, ruleParticipationHTML, ruleClosedConsequenceHTML };"
)(t, escUiHtml, 'target="_blank" rel="noopener noreferrer"', () => '<span class="sr-only"> (opens in new tab)</span>', windowStub);

const NOW = "2026-07-01";

// ---------------------------------------------------------------------------
// A1 [boundary] — confined to a rulemaking object, never a generic hearing.
// ---------------------------------------------------------------------------

test("A1: the participation guide and closed consequence are only wired from the Agency-Rules-gated lifecycle loader", () => {
  const loaderStart = src.indexOf("async function loadRuleLifecycle(");
  assert.notEqual(loaderStart, -1, "loadRuleLifecycle not found");
  const guardIdx = src.indexOf('r.section_name!=="Agency Rules"', loaderStart);
  assert.notEqual(guardIdx, -1, "Agency Rules guard not found in loadRuleLifecycle");
  const partHtmlCallIdx = src.indexOf("ruleParticipationHTML(participationPath)", loaderStart);
  const closedCallIdx = src.indexOf("ruleClosedConsequenceHTML(closedConsequence)", loaderStart);
  assert.ok(partHtmlCallIdx > guardIdx, "ruleParticipationHTML call must be reached only after the Agency Rules guard");
  assert.ok(closedCallIdx > guardIdx, "ruleClosedConsequenceHTML call must be reached only after the Agency Rules guard");
  // Only the function's own definition and the one call site above use these
  // names with a paren — no other call site invokes these renderers, so the
  // consequence copy never reaches a general meeting/hearing surface.
  const partHtmlCalls = [...src.matchAll(/\bruleParticipationHTML\(/g)];
  const closedCalls = [...src.matchAll(/\bruleClosedConsequenceHTML\(/g)];
  assert.equal(partHtmlCalls.length, 2, "expected exactly the definition and the one Agency-Rules-gated call");
  assert.equal(closedCalls.length, 2, "expected exactly the definition and the one Agency-Rules-gated call");
});

test("A1: buildRuleCommentConsequence returns null for a record with no comment-period evidence at all (never fabricated for a plain hearing)", () => {
  assert.equal(buildRuleCommentConsequence({ stage: "unknown" }, null, { now: NOW }), null);
  assert.equal(buildRuleCommentConsequence({}, null, { now: NOW }), null);
});

// ---------------------------------------------------------------------------
// A2/A3 [outcome] — open window keeps commenting primary; hearing and
// deadline stay distinct actions with distinct dates.
// ---------------------------------------------------------------------------

test("A2: while open, the primary action stays the comment CTA by the stated date", () => {
  const rec = {
    stage: "comment-open",
    agency: "Health and Mental Hygiene",
    title: "Food service grade posting rules",
    nyc_rules: { comment_by_date: "2026-08-15", comment_url: "https://rules.cityofnewyork.us/dohmh-food#comment" },
  };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  assert.equal(consequence.open, true);
  const html = env.ruleParticipationHTML(consequence);
  assert.match(html, /class="act primary"/);
  assert.match(html, /https:\/\/rules\.cityofnewyork\.us\/dohmh-food#comment/);
  assert.match(html, /Open comment form/);
});

test("A3: a future hearing and the written deadline render as two distinct lines with distinct dates (open window)", () => {
  const rec = {
    stage: "comment-open",
    nyc_rules: {
      comment_by_date: "2026-08-15",
      comment_url: "https://rules.cityofnewyork.us/x#comment",
      hearing_date: "2026-08-05",
    },
  };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  assert.equal(consequence.comment_by_date, "2026-08-15");
  assert.equal(consequence.hearing_date, "2026-08-05");
  assert.notEqual(consequence.comment_by_date, consequence.hearing_date);
  const html = env.ruleParticipationHTML(consequence);
  assert.match(html, /August 15, 2026/, "deadline line carries its own date");
  assert.match(html, /August 5, 2026/, "hearing note carries its own, different date");
  assert.match(html, /class="rule-part-hearing-note"/);
  // The hearing note sits in its own paragraph, not folded into the deadline sentence.
  const deadlineParagraph = html.match(/<p><b>[^<]*<\/b>[^<]*<\/p>/)[0];
  assert.doesNotMatch(deadlineParagraph, /August 5, 2026/);
});

test("A3: no hearing note renders when a rule has no published hearing date (never a fabricated hearing)", () => {
  const rec = { stage: "comment-open", nyc_rules: { comment_by_date: "2026-08-15", comment_url: "https://rules.cityofnewyork.us/x" } };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  assert.equal(consequence.hearing_date, null);
  const html = env.ruleParticipationHTML(consequence);
  assert.doesNotMatch(html, /rule-part-hearing-note/);
});

// ---------------------------------------------------------------------------
// A4 [boundary] — closed state removes the submission control but keeps the
// public-record explanation (the phase spine renders separately, unaffected).
// ---------------------------------------------------------------------------

test("A4: a closed window keeps the buildRulesParticipationPath null contract (no submission control returned there)", () => {
  const rec = { stage: "comment-open", nyc_rules: { comment_by_date: "2026-06-01" } };
  assert.equal(buildRulesParticipationPath(rec, null, { now: NOW }), null);
});

test("A4: a closed window still carries the public-record consequence, with the submission control removed", () => {
  const rec = {
    stage: "comment-open",
    agency: "Department of Transportation",
    title: "City-owned bicycle racks",
    nyc_rules: { comment_by_date: "2026-06-01", comment_url: "https://rules.cityofnewyork.us/dot-bikes#comment", hearing_date: "2026-05-20" },
  };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  assert.equal(consequence.open, false);
  assert.equal(consequence.submit_url, null);
  assert.equal(consequence.comment_by_date, "2026-06-01");
  const openHtml = env.ruleParticipationHTML(consequence);
  assert.equal(openHtml, "", "the open-window guide never renders once closed");
  const closedHtml = env.ruleClosedConsequenceHTML(consequence);
  assert.notEqual(closedHtml, "");
  assert.doesNotMatch(closedHtml, /class="act primary"/, "no submission control once closed");
  assert.doesNotMatch(closedHtml, /rules\.cityofnewyork\.us\/dot-bikes#comment/, "the comment channel URL is not offered once closed");
  assert.match(closedHtml, /June 1, 2026/, "the closed deadline date is retained");
  assert.match(closedHtml, /May 20, 2026/, "the hearing date is retained, distinct from the deadline");
});

test("A4: ruleClosedConsequenceHTML renders nothing when the window is still open or there is no dated deadline on record", () => {
  assert.equal(env.ruleClosedConsequenceHTML(null), "");
  assert.equal(env.ruleClosedConsequenceHTML({ open: true, comment_by_date: "2026-08-15" }), "");
  assert.equal(env.ruleClosedConsequenceHTML({ open: false, comment_by_date: null }), "");
});

// ---------------------------------------------------------------------------
// A5/A6 — never turn a materials/rule link into a join link; never fabricate
// a channel, deadline, hearing, or closed-window state for sparse records.
// ---------------------------------------------------------------------------

test("A5/A6: sparse case — a comment_url with no date or open-stage evidence never becomes a fabricated closed state", () => {
  // No comment_by_date, no stage_comment_open: we cannot know whether this window
  // is open, closed, or never existed, so nothing renders rather than guessing.
  const rec = { stage: "unknown", nyc_rules: { comment_url: "https://rules.cityofnewyork.us/x" } };
  assert.equal(buildRuleCommentConsequence(rec, null, { now: NOW }), null);
});

test("A5/A6: an adopted rule with no historical comment evidence renders no consequence receipt and no fabricated hearing/adopted relation", () => {
  const rec = { stage: "effective", agency: "Department of Buildings", title: "Elevator inspection cycle", nyc_rules: { effective_date: "2026-08-01" } };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  assert.equal(consequence, null);
});

test("A6: dense case (channel + deadline + hearing + agency) renders every fact once, with no invented field", () => {
  const rec = {
    stage: "comment-open",
    agency: "Taxi and Limousine Commission",
    title: "Driver relief penalty reduction",
    nyc_rules: {
      comment_by_date: "2026-07-25",
      comment_url: "https://rules.cityofnewyork.us/tlc-relief#comment",
      hearing_date: "2026-07-10",
    },
  };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  const html = env.ruleParticipationHTML(consequence);
  assert.match(html, /rule-part-consequence/);
  assert.match(html, /rule-part-hearing-note/);
  assert.match(html, /tlc-relief#comment/);
});

test("A6: partial case (deadline only, no hearing, no explicit agency/title) renders the receipt without a fabricated hearing note", () => {
  const rec = { stage: "comment-open", nyc_rules: { comment_by_date: "2026-07-25", comment_url: "https://rules.cityofnewyork.us/x#comment" } };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  const html = env.ruleParticipationHTML(consequence);
  assert.match(html, /rule-part-consequence/);
  assert.doesNotMatch(html, /rule-part-hearing-note/);
});

// ---------------------------------------------------------------------------
// A7 [outcome] — the receipt sits inside the guide, below channel/deadline
// and above the phase spine (rendered separately, after this guide, in
// loadRuleLifecycle's el.innerHTML composition).
// ---------------------------------------------------------------------------

test("A7: the consequence receipt sits below the channel/deadline block and above the comment-count guidance, inside the same guide", () => {
  const rec = { stage: "comment-open", nyc_rules: { comment_by_date: "2026-08-15", comment_url: "https://rules.cityofnewyork.us/x#comment" } };
  const consequence = buildRuleCommentConsequence(rec, null, { now: NOW });
  const html = env.ruleParticipationHTML(consequence);
  const channelIdx = html.indexOf('class="act primary"');
  const deadlineIdx = html.indexOf("rule_part_channel_heading") !== -1 ? html.indexOf("rule_part_channel_heading") : html.indexOf("Where comments go");
  const consequenceIdx = html.indexOf("rule-part-consequence");
  const countsIdx = html.indexOf("rule_part_counts_heading") !== -1 ? html.indexOf("rule_part_counts_heading") : html.indexOf("What makes a comment count");
  assert.ok(deadlineIdx !== -1 && channelIdx !== -1 && consequenceIdx !== -1 && countsIdx !== -1, "all four markers must be present");
  assert.ok(deadlineIdx < consequenceIdx, "consequence must render below the channel/deadline heading");
  assert.ok(channelIdx < consequenceIdx, "consequence must render below the channel CTA");
  assert.ok(consequenceIdx < countsIdx, "consequence must render above the counts/scaffold portion of the guide");
});

test("A7: the participation guide (and its closed-state replacement) compose ahead of the phase spine in the lifecycle loader", () => {
  const loaderBody = src.slice(src.indexOf("async function loadRuleLifecycle("), src.indexOf("async function loadSectionAgencies("));
  const partAssignIdx = loaderBody.indexOf("const partHtml=");
  const innerHtmlIdx = loaderBody.indexOf("el.innerHTML=");
  assert.ok(partAssignIdx !== -1 && innerHtmlIdx !== -1);
  const innerHtmlLine = loaderBody.slice(innerHtmlIdx, loaderBody.indexOf(";", innerHtmlIdx) + 1);
  assert.match(innerHtmlLine, /\$\{partHtml\}.*\$\{spine\}/s, "partHtml (guide or its closed-state replacement) must precede spine in the composed markup");
});

// ---------------------------------------------------------------------------
// Negative rule — never promise a response or a published report; never
// convert a materials link into a participation channel.
// ---------------------------------------------------------------------------

test("negative rule: the consequence copy makes no promise of a response or a published report", () => {
  const receiptText = t("rule_part_consequence_receipt");
  const forbidden = [/will be answered/i, /will publish/i, /guarantee/i, /report will be/i, /response guaranteed/i];
  for (const pattern of forbidden) {
    assert.doesNotMatch(receiptText, pattern, `consequence copy must not match ${pattern}`);
  }
  assert.match(receiptText, /may be revised/i, "the final-rule effect is stated as conditional, not promised");
});

test("negative rule: the closed-state guide never re-offers the comment channel or rule-page fallback link as a join/participation control", () => {
  const consequence = { open: false, comment_by_date: "2026-06-01", hearing_date: null, submit_url: null };
  const html = env.ruleClosedConsequenceHTML(consequence);
  assert.doesNotMatch(html, /<a /, "closed guide carries no links at all — only explanatory text");
});
