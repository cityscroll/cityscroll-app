#!/usr/bin/env node

/**
 * RU-03 — the rendered resident-copy boundary gate.
 *
 * The existing plain-language scan (test/standards/no_disclaimer_slop.py) reads
 * source text: HTML visible text and JavaScript string literals, matched against
 * a small set of calibrated phrases. That is the right shape for the regression
 * it was built for, and it stays exactly as it is. It cannot, however, see the
 * thing a resident actually meets, because two of the worst failures carry no
 * banned phrase at all:
 *
 *   - An entire diagnostic SECTION renders in the resident default. Every
 *     sentence inside it may be individually blameless; the failure is that the
 *     section exists, and that it is hundreds of rows long.
 *   - A dynamic label falls back to its raw machine value — an unresolved
 *     translation key, an enum constant, `undefined` — so the offending string
 *     never appears in any source file to be matched.
 *
 * So this gate reads RENDERED state instead of source text, and asserts
 * structure rather than vocabulary. It takes bounded fixtures produced by the
 * real renderers in three shapes each — sparse, partial, and error — and checks
 * the resulting markup across every channel a resident can reach it through:
 * visible text, accessible names, and translated dynamic labels under a
 * non-English locale and under locale fallback.
 *
 * What it deliberately does NOT do:
 *
 *   - It is not a wider phrase blacklist. Every rule below keys on structure
 *     (what kind of element, how many rows, which channel) or on the code's own
 *     exported enum vocabulary. Adding a word to a list is never the fix.
 *   - It has no allowlist. A gate whose escape hatch is one line in a text file
 *     gets one line added to a text file. A finding here means the renderer
 *     changes, or the rule was wrong and the rule changes.
 *   - It does not treat `<details>` as a hiding place. Wrapping a debug dump in
 *     a disclosure is the failure wearing a hat, so a diagnostic projection
 *     inside a disclosure fails exactly as it does outside one. Bounded
 *     provenance in a disclosure — a few source rows, a coverage note — is the
 *     legitimate pattern and stays legal.
 *   - It never asks a renderer to delete legitimate uncertainty. Real failures,
 *     honest zeros, incompatible fiscal scopes, affiliation and privacy copy and
 *     an explicitly requested outcome that could not be located are all carried
 *     as positive controls: the corpus fails if they stop being rendered.
 *
 * Every finding names the fixture, the owning source file, and the owning
 * render function, because "some copy somewhere regressed" is not actionable.
 *
 * Run: node tools/resident_copy_boundary.mjs --check
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ABSENCE_REASONS, renderEdgeSummaryRail } from "../site/edge_summary.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import {
  buildCommunityBoardMoneyCardView,
  buildCommunityBoardMoneyReadModel,
  renderCommunityBoardMoneyCard,
} from "../site/community_board_money.mjs";
import { OUTCOME_STATES, renderOutcomeState } from "../site/outcome_not_located_state.mjs";
import { followingPersonalIslandHtml } from "../site/following_personal_state.mjs";
import { renderNodeFooter } from "../site/civic_document_chrome.mjs";

/**
 * The resident bound on a rendered record projection, taken from the renderer
 * that established it (COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT). A list longer
 * than this is the shape of a dump regardless of how its heading reads.
 */
export const RESIDENT_RECORD_PROJECTION_BOUND = 20;

/**
 * Words that name the ENGINEERING register itself, not uncertainty. This is a
 * register check on section headings, which is why it can stay this short and
 * must not grow into a copy blacklist: "unavailable", "unknown", "not" and
 * every other honest word about the world remain entirely legal copy.
 */
const DIAGNOSTIC_REGISTER = Object.freeze([
  "diagnostic", "diagnostics", "debug", "unjoined", "raw", "dump", "trace",
  "internal", "reconciliation", "adapter", "payload", "join key", "pipeline",
  "backfill", "ingest", "ingested",
]);

/** Elements whose content is machine payload or verbatim source, never resident copy. */
const OPAQUE_TAGS = new Set(["script", "style", "template", "code", "pre"]);

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Attributes that carry an accessible name a screen reader announces. */
const ACCESSIBLE_NAME_ATTRIBUTES = Object.freeze(["aria-label", "alt", "title"]);

/**
 * Attributes marking an element that carries a resident-consequential state.
 * These are the elements whose meaning must reach BOTH channels; they are also
 * the machine channel itself, so their VALUES are exempt from the raw-token
 * rules below. RU-02 deliberately keeps the reason in a non-visible attribute
 * while the visible copy stays in plain language, and that must keep working.
 */
const RESIDENT_STATE_ATTRIBUTES = Object.freeze([
  "data-edge-state",
  "data-edge-availability",
  "data-money-state",
  "data-outcome-state",
  "data-minutes-freshness",
  "data-source-absence-reason",
]);

/** Class and attribute markers identifying one rendered record inside a projection. */
const RECORD_ITEM_MARKERS = Object.freeze(["node-record", "edge-summary-item"]);
const RECORD_ITEM_ATTRIBUTES = Object.freeze(["data-source-record-kind"]);

/**
 * Machine identifiers that must never surface as resident copy. Values come from
 * the modules' own exported enums, so the vocabulary cannot drift away from the
 * code; single-word values are excluded on purpose, because a lone lowercase
 * English word ("unavailable", "unsearched") is indistinguishable from prose and
 * is legitimately rendered as prose today.
 */
function machineIdentifierVocabulary() {
  const values = [
    ...Object.values(ABSENCE_REASONS),
    ...Object.values(OUTCOME_STATES),
    // Money card states (site/community_board_money.mjs CARD_STATES) and the
    // source coverage states the board view tags rows with. Neither set is
    // exported; both are asserted against the renderers in the paired test.
    "both_sources", "separate_fiscal_years", "budget_only", "spending_only",
    "unmatched_identity", "empty_source_result", "stale_source",
    "identity_unobserved", "posted_through_source_vintage",
    "not_yet_ingested", "no_action",
  ];
  return new Set(values.filter((value) => typeof value === "string" && value.includes("_")));
}

const MACHINE_IDENTIFIERS = machineIdentifierVocabulary();

/** A bare unresolved translation key: three or more underscore-joined segments. */
const TRANSLATION_KEY_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/;
/** A raw enum still wearing its constant casing. */
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** Values a template produced by interpolating something that was not there. */
const NULLISH_TOKENS = new Set(["undefined", "null", "NaN"]);
const NULLISH_PHRASE_RE = /\[object [A-Za-z]+\]|\bInvalid Date\b/;

export const RESIDENT_COPY_BOUNDARY_RULES = Object.freeze([
  Object.freeze({
    id: "diagnostic_section_exposed",
    name: "diagnostic section in a resident projection",
    guidance: "Project the useful records for the reader's task and keep the reconciliation record in the owning data model. A disclosure is not a hiding place.",
  }),
  Object.freeze({
    id: "unbounded_record_projection",
    name: "unbounded record projection",
    guidance: `Bound the rendered list to ${RESIDENT_RECORD_PROJECTION_BOUND} records and say plainly how many remain on file.`,
  }),
  Object.freeze({
    id: "raw_dynamic_fallback",
    name: "raw dynamic value in resident copy",
    guidance: "Give the dynamic label a resident sentence for this state. Keep the machine value in a data attribute, never in rendered text.",
  }),
  Object.freeze({
    id: "accessible_name_leakage",
    name: "raw dynamic value in an accessible name",
    guidance: "An accessible name is resident copy read aloud. Hold it to the same words as the visible label.",
  }),
  Object.freeze({
    id: "single_channel_state",
    name: "consequential state reaching only one channel",
    guidance: "A state a reader acts on must reach both the visible and the assistive channel. Do not satisfy this gate by hiding copy from one of them.",
  }),
  Object.freeze({
    id: "untranslated_dynamic_label",
    name: "unresolved translation key in rendered copy",
    guidance: "Add the key to this renderer's dictionary. Falling back to the English string is fine; falling back to the key is not.",
  }),
]);

const RULES_BY_ID = new Map(RESIDENT_COPY_BOUNDARY_RULES.map((rule) => [rule.id, rule]));

// --- minimal structural scanner -------------------------------------------
// The repository ships no runtime dependencies, so this walks the markup
// directly. It needs element identity, attributes, ancestry and text position —
// not a spec-complete DOM.

const ENTITIES = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
});

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

function normalizeText(value) {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match = pattern.exec(source);
  while (match) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    attributes[name.toLowerCase()] = decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? "");
    match = pattern.exec(source);
  }
  return attributes;
}

/**
 * Walk the markup once, producing a flat element list where each element knows
 * its own subtree. Positions are byte offsets into the source so a parent can
 * ask what text and which descendants fall inside it.
 */
function scanDocument(html) {
  const source = String(html ?? "");
  const elements = [];
  const texts = [];
  const stack = [];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let cursor = 0;
  let match = pattern.exec(source);

  const pushText = (raw, start, end) => {
    const value = normalizeText(raw);
    if (!value) return;
    const opaque = stack.some((entry) => OPAQUE_TAGS.has(entry.tag));
    texts.push({ value, start, end, opaque, ancestors: stack.map((entry) => entry.index) });
  };

  while (match) {
    const [whole, closing, rawTag, rawAttrs, selfClosing] = match;
    pushText(source.slice(cursor, match.index), cursor, match.index);
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) {
          for (let unwind = stack.length - 1; unwind >= index; unwind -= 1) {
            elements[stack[unwind].index].end = match.index;
            elements[stack[unwind].index].innerEnd = match.index;
          }
          stack.length = index;
          break;
        }
      }
    } else {
      const element = {
        index: elements.length,
        tag,
        attributes: parseAttributes(rawAttrs || ""),
        start: match.index,
        innerStart: match.index + whole.length,
        innerEnd: source.length,
        end: source.length,
        ancestors: stack.map((entry) => entry.index),
      };
      elements.push(element);
      if (!selfClosing && !VOID_TAGS.has(tag)) stack.push({ tag, index: element.index });
    }
    cursor = match.index + whole.length;
    match = pattern.exec(source);
  }
  pushText(source.slice(cursor), cursor, source.length);

  for (const element of elements) {
    element.classes = new Set(String(element.attributes.class || "").split(/\s+/).filter(Boolean));
  }
  return { source, elements, texts };
}

/** Visible text of one element: its own text nodes, minus machine payloads. */
function elementText(document, element) {
  return document.texts
    .filter((text) => !text.opaque && text.start >= element.innerStart && text.end <= element.innerEnd)
    .map((text) => text.value)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function documentVisibleText(document) {
  return document.texts.filter((text) => !text.opaque).map((text) => text.value).join(" ");
}

function isRecordItem(element) {
  if (element.tag !== "li") return false;
  if (RECORD_ITEM_ATTRIBUTES.some((name) => Object.hasOwn(element.attributes, name))) return true;
  return RECORD_ITEM_MARKERS.some((marker) => element.classes.has(marker));
}

function residentStateOf(element) {
  for (const name of RESIDENT_STATE_ATTRIBUTES) {
    if (Object.hasOwn(element.attributes, name)) return { name, value: element.attributes[name] };
  }
  return null;
}

function hiddenFromAssistiveTechnology(document, element) {
  const chain = [...element.ancestors, element.index];
  return chain.some((index) => document.elements[index].attributes["aria-hidden"] === "true");
}

/** Raw machine tokens inside one already-normalized string. */
function machineTokensIn(value) {
  const found = [];
  const phrase = NULLISH_PHRASE_RE.exec(value);
  if (phrase) found.push(phrase[0]);
  for (const token of value.split(/[\s,;:·—–()[\]"']+/).filter(Boolean)) {
    if (NULLISH_TOKENS.has(token)) found.push(token);
    else if (MACHINE_IDENTIFIERS.has(token)) found.push(token);
    else if (SCREAMING_SNAKE_RE.test(token)) found.push(token);
  }
  return found;
}

/** Unresolved translation keys inside one already-normalized string. */
function translationKeysIn(value) {
  return value
    .split(/[\s,;:·—–()[\]"']+/)
    .filter((token) => Boolean(token) && !token.includes(".") && !token.includes("/"))
    .filter((token) => TRANSLATION_KEY_RE.test(token) && !MACHINE_IDENTIFIERS.has(token));
}

// --- rules -----------------------------------------------------------------

function finding(rule, context, detail, evidence) {
  return Object.freeze({
    rule,
    rule_name: RULES_BY_ID.get(rule)?.name || rule,
    guidance: RULES_BY_ID.get(rule)?.guidance || "",
    fixture: context.fixture || "(unnamed fixture)",
    file: context.file || "(unresolved file)",
    renderer: context.renderer || "(unresolved renderer)",
    state: context.state || null,
    locale: context.locale || null,
    detail,
    evidence: String(evidence ?? "").slice(0, 200),
  });
}

function checkDiagnosticSections(document, context, findings) {
  for (const element of document.elements) {
    const isSectionLike = element.tag === "section" || element.tag === "details" || element.tag === "aside";
    if (!isSectionLike) continue;
    const headings = document.elements.filter((candidate) =>
      /^(?:h[1-6]|summary)$/.test(candidate.tag)
      && candidate.start >= element.innerStart
      && candidate.end <= element.innerEnd);
    for (const heading of headings) {
      const text = elementText(document, heading).toLowerCase();
      const marker = DIAGNOSTIC_REGISTER.find((word) => new RegExp(`\\b${word}\\b`).test(text));
      if (!marker) continue;
      findings.push(finding(
        "diagnostic_section_exposed",
        context,
        `a <${element.tag}> rendered to residents is headed in the engineering register (“${marker}”)`,
        elementText(document, heading),
      ));
      break;
    }
  }
}

function checkUnboundedProjections(document, context, findings) {
  for (const element of document.elements) {
    if (element.tag !== "ul" && element.tag !== "ol") continue;
    const items = document.elements.filter((candidate) =>
      candidate.start >= element.innerStart
      && candidate.end <= element.innerEnd
      && isRecordItem(candidate));
    if (items.length <= RESIDENT_RECORD_PROJECTION_BOUND) continue;
    findings.push(finding(
      "unbounded_record_projection",
      context,
      `${items.length} records render in one list; the resident bound is ${RESIDENT_RECORD_PROJECTION_BOUND}`,
      elementText(document, items[0]),
    ));
  }
}

function checkVisibleCopy(document, context, findings) {
  for (const text of document.texts) {
    if (text.opaque) continue;
    for (const token of machineTokensIn(text.value)) {
      findings.push(finding("raw_dynamic_fallback", context, `rendered text carries the machine value “${token}”`, text.value));
    }
    for (const key of translationKeysIn(text.value)) {
      findings.push(finding(
        "untranslated_dynamic_label",
        context,
        `rendered text is the translation key “${key}” rather than a translated or English-fallback string`,
        text.value,
      ));
    }
  }
}

function checkAccessibleNames(document, context, findings) {
  for (const element of document.elements) {
    for (const attribute of ACCESSIBLE_NAME_ATTRIBUTES) {
      const raw = element.attributes[attribute];
      if (!raw) continue;
      const value = normalizeText(raw);
      for (const token of machineTokensIn(value)) {
        findings.push(finding(
          "accessible_name_leakage",
          context,
          `<${element.tag} ${attribute}> announces the machine value “${token}”`,
          value,
        ));
      }
      for (const key of translationKeysIn(value)) {
        findings.push(finding(
          "untranslated_dynamic_label",
          context,
          `<${element.tag} ${attribute}> announces the translation key “${key}”`,
          value,
        ));
      }
    }
  }
}

/**
 * Neither channel may be the sole carrier of a consequential state. Hiding the
 * copy from screen readers and hiding it from the page are the same failure
 * facing opposite directions, so both are one rule.
 */
function checkChannelParity(document, context, findings) {
  const visible = documentVisibleText(document).toLowerCase();
  for (const element of document.elements) {
    const state = residentStateOf(element);
    if (!state) continue;
    const text = elementText(document, element);

    if (text && hiddenFromAssistiveTechnology(document, element)) {
      findings.push(finding(
        "single_channel_state",
        context,
        `the ${state.name}="${state.value}" element is aria-hidden, so its copy reaches sighted readers only`,
        text,
      ));
      continue;
    }

    const announced = normalizeText(element.attributes["aria-label"] || "");
    if (!announced) continue;
    const announcedOnly = announced
      .split(/[;·]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 3 && !visible.includes(part.toLowerCase()));
    if (!announcedOnly.length) continue;
    findings.push(finding(
      "single_channel_state",
      context,
      `the ${state.name}="${state.value}" element announces copy that appears nowhere on the page, so it reaches assistive technology only`,
      announcedOnly[0],
    ));
  }
}

/**
 * Inspect one rendered resident projection.
 *
 * @param {string} html rendered markup
 * @param {{fixture?: string, file?: string, renderer?: string, state?: string, locale?: string}} context
 */
export function inspectResidentCopyBoundary(html, context = {}) {
  const document = scanDocument(html);
  const findings = [];
  checkDiagnosticSections(document, context, findings);
  checkUnboundedProjections(document, context, findings);
  checkVisibleCopy(document, context, findings);
  checkAccessibleNames(document, context, findings);
  checkChannelParity(document, context, findings);
  return findings;
}

/** One actionable line: what broke, where it is rendered, and who renders it. */
export function formatFinding(item) {
  const scope = [item.state && `state=${item.state}`, item.locale && `locale=${item.locale}`].filter(Boolean).join(" ");
  return [
    `${item.file} [${item.rule}] ${item.rule_name}`,
    `    fixture: ${item.fixture}${scope ? ` (${scope})` : ""}`,
    `    renderer: ${item.renderer}()`,
    `    problem: ${item.detail}`,
    `    rendered: ${JSON.stringify(item.evidence)}`,
    `    fix: ${item.guidance}`,
  ].join("\n");
}

// --- bounded rendered-state fixtures ---------------------------------------
// Sparse, partial and error shapes for each resident projection this card
// covers. Fixtures are small and literal so a failure points at a renderer
// rather than at the state of the warehouse.

const here = (relative) => new URL(relative, import.meta.url);
const readJSON = (relative) => JSON.parse(readFileSync(here(relative), "utf8"));

function boardSources() {
  return {
    sourceRegistry: readJSON("../site/data/non_council_outcome_sources/source_registry.json"),
    sourceInventory: readJSON("../site/data/non_council_outcome_sources/board_source_inventory.json"),
    scorecard: readJSON("../site/data/community_board_minutes_scorecard.json"),
    geography: readJSON("../site/data/community_board_geography_lookup.json"),
  };
}

const MONEY_BUDGET = Object.freeze({
  schema: "cityscroll.community_board_adopted_budget.v1",
  generated_at: "2026-08-27T00:00:00Z",
  source: { source_system: "expense_budget", pinned_slice: { fiscal_year: 2026 } },
  coverage: { accepted_board_facts: 1 },
  rows: [{ board_id: "fiscal-scope-board", fiscal_year: 2027, adopted_amount: 100000 }],
});

const MONEY_PAYMENTS = Object.freeze({
  schema: "cityscroll.community_board_payment_actuals.v1",
  generated_at: "2026-08-27T00:00:00Z",
  source: { source_system: "checkbook_payment_population", endpoint: "https://www.checkbooknyc.com/api" },
  fiscal_years: [2026],
  rows: [
    { board_id: "fiscal-scope-board", fiscal_year: 2026, posted_payment_amount: 5000, payment_count: 2, distinct_payee_count: 1, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "posted_through_source_vintage" },
    { board_id: "valid-zero-board", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "empty_source_result" },
    { board_id: "unresolved-identity-board", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "identity_unobserved" },
  ],
});

function moneyCard(boardId, { adoptedBudget = null, paymentActuals = MONEY_PAYMENTS } = {}) {
  const model = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: boardId }],
    adoptedBudget,
    paymentActuals,
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  return renderCommunityBoardMoneyCard(buildCommunityBoardMoneyCardView(model, boardId));
}

/** A notice with no matched outcome row: the requested-but-not-located shape. */
const OUTCOME_PAYLOAD = Object.freeze({
  schema: "cityscroll.non_council_outcome_lookup.v1",
  generated_at: "2026-08-27T00:00:00Z",
  coverage: { scope: "community board and borough president records" },
  rows: [],
});

const OUTCOME_NOTICE = Object.freeze({
  request_id: "ru03-fixture-request",
  event_date: "2026-05-14",
  start_date: "2026-05-01",
  // A resolvable body, so the not-located state renders its follow-up action
  // rather than the no-follow-up branch.
  body_id: "manhattan-cb-03",
});

/**
 * Build the bounded corpus. Each entry declares the file and render function
 * that owns it, so a finding can name them.
 */
export function buildResidentCopyBoundaryCorpus() {
  const sources = boardSources();
  const fixtures = [];

  const add = (entry) => fixtures.push(Object.freeze(entry));

  // Community Board document — a real board, rendered whole. The error and
  // sparse shapes below exercise the same renderer with thinner inputs.
  for (const [boardId, state] of [["manhattan-cb-03", "partial"], ["brooklyn-cb-02", "sparse"], ["manhattan-cb-06", "sparse"]]) {
    add({
      id: `community-board-document:${boardId}`,
      state,
      file: "site/community_board_constellation.mjs",
      renderer: "renderCommunityBoardConstellationDocument",
      html: renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView(boardId, sources)),
    });
  }

  // Edge-summary rail — matched, honest empty, and unevaluated.
  add({
    id: "edge-summary-rail:matched",
    state: "partial",
    file: "site/edge_summary.mjs",
    renderer: "renderEdgeSummaryRail",
    html: renderEdgeSummaryRail([
      { edge_type: "hosts_meeting", target_kind: "meeting", state: "matched", count: 3, canonical_href: "/meetings/full-board", target_name: "Full Board" },
      { edge_type: "published_board_source", target_kind: "record", state: "empty", absence_reason: ABSENCE_REASONS.RECORDED_NEGATIVE },
    ], { heading: "Connected records" }),
  });
  add({
    id: "edge-summary-rail:retrieval-failure",
    state: "error",
    file: "site/edge_summary.mjs",
    renderer: "renderEdgeSummaryRail",
    html: renderEdgeSummaryRail([
      { edge_type: "hosts_meeting", target_kind: "meeting", state: "unknown", absence_reason: ABSENCE_REASONS.RETRIEVAL_FAILURE },
      { edge_type: "covers", target_kind: "record", state: "unknown", absence_reason: ABSENCE_REASONS.UNSEARCHED },
    ], { heading: "Connected records" }),
  });

  // Money card — incompatible fiscal years, a sourced zero, an unresolved
  // identity, and a total retrieval failure.
  add({ id: "money-card:separate-fiscal-years", state: "partial", file: "site/community_board_money.mjs", renderer: "renderCommunityBoardMoneyCard", html: moneyCard("fiscal-scope-board", { adoptedBudget: MONEY_BUDGET }) });
  add({ id: "money-card:valid-zero", state: "sparse", file: "site/community_board_money.mjs", renderer: "renderCommunityBoardMoneyCard", html: moneyCard("valid-zero-board") });
  add({ id: "money-card:unresolved-identity", state: "sparse", file: "site/community_board_money.mjs", renderer: "renderCommunityBoardMoneyCard", html: moneyCard("unresolved-identity-board") });
  add({ id: "money-card:unavailable", state: "error", file: "site/community_board_money.mjs", renderer: "renderCommunityBoardMoneyCard", html: moneyCard("no-such-board", { paymentActuals: null }) });

  // Requested outcome that could not be located, across a translated locale, a
  // locale with no dictionary of its own (English fallback), and English.
  for (const locale of ["en", "fr", "zh-Hans"]) {
    add({
      id: `outcome-not-located:${locale}`,
      state: "sparse",
      locale,
      file: "site/outcome_not_located_state.mjs",
      renderer: "renderOutcomeState",
      html: renderOutcomeState(OUTCOME_PAYLOAD, OUTCOME_NOTICE.request_id, OUTCOME_NOTICE, { lang: locale }),
    });
  }

  // A failed personal read that keeps an actionable recovery.
  for (const [state, shape] of [["unavailable", "error"], ["error", "error"], ["empty", "sparse"]]) {
    add({
      id: `following-personal-island:${state}`,
      state: shape,
      file: "site/following_personal_state.mjs",
      renderer: "followingPersonalIslandHtml",
      html: followingPersonalIslandHtml(state),
    });
  }

  // Affiliation copy, which the gate must never pressure a renderer to delete.
  add({
    id: "document-footer:affiliation",
    state: "sparse",
    file: "site/civic_document_chrome.mjs",
    renderer: "renderNodeFooter",
    html: renderNodeFooter(),
  });

  return fixtures;
}

/** Run the corpus and return every finding across it. */
export function checkResidentCopyBoundary(fixtures = buildResidentCopyBoundaryCorpus()) {
  return fixtures.flatMap((fixture) => inspectResidentCopyBoundary(fixture.html, {
    fixture: fixture.id,
    file: fixture.file,
    renderer: fixture.renderer,
    state: fixture.state,
    locale: fixture.locale,
  }));
}

function main(argv) {
  if (!argv.includes("--check")) {
    console.error("usage: node tools/resident_copy_boundary.mjs --check");
    return 2;
  }
  const fixtures = buildResidentCopyBoundaryCorpus();
  const findings = checkResidentCopyBoundary(fixtures);
  if (!findings.length) {
    console.log(`resident-copy-boundary: passed — ${fixtures.length} rendered fixture(s), ${RESIDENT_COPY_BOUNDARY_RULES.length} structural rule(s)`);
    return 0;
  }
  console.error(`resident-copy-boundary: BLOCK — ${findings.length} finding(s) across ${fixtures.length} rendered fixture(s)`);
  for (const item of findings) console.error(`\n${formatFinding(item)}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
