#!/usr/bin/env node
/**
 * Measure the reader-visible City Record prose on the Property lens.
 *
 * The script deliberately reuses the repository's established reading-level tool:
 * readable-or-else with its nycsg7 preset (Flesch-Kincaid grade). Pattern assignment
 * and signal detection are deterministic regular-expression classifiers; no model or
 * external interpretation service is involved.
 *
 * Examples:
 *   node tools/property_a11y_census.mjs --as-of 2026-08-04
 *   node tools/property_a11y_census.mjs --input corpus.json --format markdown
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cleanNoticeText } from "../site/text_clean.mjs";
import { extractPropertyCommercial } from "../site/property_commercial.mjs";
import { classifyDispositionStage } from "../site/property_disposition_stage.mjs";
import { extractPropertyTimedEvents } from "../site/property_timed_events.mjs";
import {
  PROPERTY_PATTERN_LABELS,
  classifyPropertyPattern,
} from "../site/property_notice_patterns.mjs";
import { extractPropertyReaderActions } from "../site/property_reader_actions.mjs";

export { classifyPropertyPattern };

export const PROPERTY_SECTION = "Property Disposition";
export const DETAIL_BODY_LIMIT = 6000;
export const SEARCH_EXCERPT_RADIUS = 70;
export const DEFAULT_LIMIT = 300;
export const SOURCE_DATASET = "dg92-zbpx";
export const SOURCE_URL = `https://data.cityofnewyork.us/resource/${SOURCE_DATASET}.json`;

export const SOURCE_FIELDS = Object.freeze([
  "request_id", "start_date", "agency_name", "type_of_notice_description",
  "section_name", "short_title", "event_date", "building_name",
  "street_address_1", "street_address_2", "city", "state", "zip_code",
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
]);

export const PATTERN_LABELS = PROPERTY_PATTERN_LABELS;

export const JARGON_LABELS = Object.freeze({
  pursuant_to: "pursuant to",
  notice_hereby_given: "notice is hereby given",
  disposition_area: "Disposition Area",
  conveyance: "conveyance",
  shall: "shall",
  legal_cross_references: "section/article citations",
  calendar_boilerplate: "as soon thereafter as the matter may be reached on the calendar",
  public_examination: "available for public examination",
  udaap: "UDAAP / Urban Development Action Area Project",
  easement: "easement",
  fee_simple: "fee simple",
  condemnation: "condemnation / eminent domain",
  upset_price: "upset price",
  sealed_bid: "sealed bid",
  forfeiture: "forfeiture",
  unauthorized_products: "Unauthorized Products",
  claimants: "claimants",
  stumpage: "stumpage",
  board_feet: "board feet",
  cordwood: "cordwood",
});

const BODY_FIELDS = Object.freeze([
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
]);

function joinedRenderedText(row) {
  return [row.short_title, row.additional_description_1]
    .map(cleanNoticeText)
    .filter(Boolean)
    .join(" ");
}

/**
 * Exact stable notice surfaces from the current renderer.
 *
 * Property cards always render the title. A keyword search can add a query-centered
 * excerpt, but there is no excerpt when no term is active and therefore no single
 * corpus-wide excerpt string. Detail renders only additional_description_1, cleaned
 * and truncated to 6,000 characters (site/app/routing.mjs: showNotice).
 */
export function renderedNoticeSurfaces(row = {}) {
  const title = cleanNoticeText(row.short_title);
  const detailBody = cleanNoticeText(row.additional_description_1).slice(0, DETAIL_BODY_LIMIT);
  return {
    title,
    detail_body: detailBody,
    combined: [title, detailBody].filter(Boolean).join(". "),
  };
}

/** Mirror the query-dependent excerpt window used by matchEvidence(). */
export function searchExcerptForTerm(row = {}, term = "") {
  const needle = cleanNoticeText(term);
  if (!needle) return null;
  const text = [row.additional_description_1, row.other_info_1]
    .map(cleanNoticeText)
    .filter(Boolean)
    .join(" ");
  const index = text.toLocaleLowerCase("en-US").indexOf(needle.toLocaleLowerCase("en-US"));
  if (index < 0) return null;
  const start = Math.max(0, index - SEARCH_EXCERPT_RADIUS);
  const end = Math.min(text.length, index + needle.length + SEARCH_EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function detectPropertySignals(row = {}) {
  const text = joinedRenderedText(row);
  return {
    structured_event_date: Boolean(String(row.event_date || "").slice(0, 10)),
    hearing: /public hearing|opportunity to be heard|wishing to be heard/i.test(text),
    auction_window: /auction.{0,100}(?:from|begin|start|open)|(?:from|between).{0,100}auction/i.test(text),
    bid_deadline: /(?:bid|proposal)s?.{0,100}(?:due|deadline|must be received|must be submitted|will be accepted|no later than)|(?:due|deadline|no later than).{0,100}(?:bid|proposal)|responses? are due no later than/i.test(text),
    objection_deadline: /(?:object|objection).{0,140}(?:within|before|by |no later than|days)|(?:within|before|by |no later than).{0,140}(?:object|objection)/i.test(text),
    comment_or_testimony: /written comments?|submit comments?|testif(?:y|ies|ied)|testimony/i.test(text),
    inspection_or_showing: /show dates?|public showings?|inspection.{0,80}(?:date|time)|prospective bidders are (?:required|encouraged) to attend/i.test(text),
    accommodation_deadline: /sign language interpreters?.{0,180}no later than.{0,80}(?:business )?days? prior|no later than.{0,80}(?:business )?days? prior.{0,180}sign language interpreters?/i.test(text),
    bid_action: /submit.{0,40}(?:bid|proposal)|(?:bid|proposal)s? must be (?:received|submitted)|register.{0,80}(?:auction|bid)/i.test(text),
    object_action: /(?:file|mail|send|submit|serve|interpose).{0,50}(?:an? )?objection|right to object/i.test(text),
    attend_action: /attend.{0,60}(?:hearing|auction|showing)|wishing to be heard|opportunity to be heard/i.test(text),
    comment_action: /(?:mail|email|send|submit).{0,50}(?:written )?comments?|comments? may be (?:submitted|sent|mailed)/i.test(text),
    inquiry_or_claim_action: /inquiries relating|make (?:an? )?inquir|claim(?:ing|ant| ownership)|owners are wanted/i.test(text),
  };
}

export function detectPropertyJargon(row = {}) {
  const text = joinedRenderedText(row);
  const patterns = {
    pursuant_to: /\bpursuant to\b/i,
    notice_hereby_given: /\bnotice is hereby given\b/i,
    disposition_area: /\bdisposition area\b/i,
    conveyance: /\bconvey(?:ance|ed|s|ing)\b/i,
    shall: /\bshall\b/i,
    legal_cross_references: /\b(?:section|article|chapter|title)\s+\d|§/i,
    calendar_boilerplate: /as soon thereafter as the matter may be reached on the calendar/i,
    public_examination: /available for public examination/i,
    udaap: /\bUDAAP\b|Urban Development Action Area Project/i,
    easement: /\beasement\b/i,
    fee_simple: /\bfee simple\b/i,
    condemnation: /\bcondemnation\b|eminent domain/i,
    upset_price: /\bupset price\b/i,
    sealed_bid: /\bsealed bid\b/i,
    forfeiture: /\bforfeiture\b/i,
    unauthorized_products: /\bUnauthorized Products?\b/i,
    claimants: /\bclaimants?\b/i,
    stumpage: /\bstumpage\b/i,
    board_feet: /\bboard feet\b/i,
    cordwood: /\bcordwood\b/i,
  };
  return Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, pattern.test(text)]));
}

/** Measure what the current Property-specific extractors can structure today. */
export function currentPropertyExtraction(row = {}, options = {}) {
  const stage = classifyDispositionStage(row);
  const commercial = extractPropertyCommercial(row);
  const events = extractPropertyTimedEvents(row);
  const eventKinds = new Set(events.map((event) => event.kind));
  const signals = detectPropertySignals(row);
  const stepKinds = new Set((commercial?.participation?.steps || []).map((step) => step.kind));
  const receiptsValid = events.every((event) => {
    const source = String(row[event.source_field] || "");
    return source.slice(event.source_span?.start, event.source_span?.end) === event.source_span?.text;
  });
  const reader = extractPropertyReaderActions(row, {
    today: options.today || null,
    events,
  });
  const actionKinds = new Set(reader.actions.map((action) => action.kind));
  return {
    stage_hearing: stage === "hearing",
    stage_auction_or_rfp: stage === "auction_or_rfp",
    stage_award_or_conveyance: stage === "award_or_conveyance",
    stage_unstaged: stage == null,
    event_date_as_action_deadline: false,
    typed_event_count: events.length,
    typed_hearing_event: eventKinds.has("hearing"),
    typed_auction_window: eventKinds.has("auction_window"),
    typed_sale_or_auction_event: eventKinds.has("sale") || eventKinds.has("auction"),
    typed_bid_deadline: eventKinds.has("bid_deadline"),
    typed_inspection_or_showing: eventKinds.has("inspection_showing"),
    typed_accommodation_deadline: eventKinds.has("accommodation_deadline"),
    typed_objection_deadline: eventKinds.has("objection_deadline"),
    typed_comment_deadline: eventKinds.has("comment_deadline"),
    typed_result_or_award: eventKinds.has("result_award"),
    source_receipts_valid: receiptsValid,
    known_cross_type_false_positive_count: events.some((event) => event.kind === "bid_deadline") && !signals.bid_deadline ? 1 : 0,
    bid_deadline_signal_without_parseable_date: signals.bid_deadline && !eventKinds.has("bid_deadline"),
    honest_empty_typed_events: events.length === 0,
    bid_deadline_step: stepKinds.has("bid_deadline"),
    inspection_or_showing_step: stepKinds.has("show_or_inspection"),
    registration_step: stepKinds.has("registration"),
    package_url: Boolean(commercial?.participation?.package_url),
    source_grounded_action: reader.actions.length > 0,
    source_receipted_action: reader.actions.length > 0 && reader.actions.every((action) => Boolean(action.how?.text)),
    bid_action: actionKinds.has("bid"),
    inspection_action: actionKinds.has("inspect"),
    attend_action: actionKinds.has("attend"),
    inquiry_or_claim_action: actionKinds.has("inquire_claim"),
    review_action: actionKinds.has("review_documents") || actionKinds.has("review_result"),
    objection_step: actionKinds.has("object"),
    comment_step: actionKinds.has("comment"),
    accommodation_deadline_step: actionKinds.has("request_accommodation"),
  };
}

function canonicalCorpus(rows) {
  return rows.map((row) => Object.fromEntries(SOURCE_FIELDS.map((key) => [key, row[key] ?? null])));
}

export function corpusSha256(rows) {
  return createHash("sha256").update(JSON.stringify(canonicalCorpus(rows))).digest("hex");
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[char]);
}

async function scoreSurfaces(rows, executable = "readable-or-else") {
  const dir = await mkdtemp(path.join(tmpdir(), "property-a11y-census-"));
  const index = new Map();
  try {
    for (const row of rows) {
      const id = String(row.request_id || "unknown").replace(/[^a-z0-9_-]/gi, "_");
      const surfaces = renderedNoticeSurfaces(row);
      for (const [surface, text] of Object.entries(surfaces)) {
        if (!text.trim()) continue;
        const filename = `${id}--${surface}.html`;
        const absolute = path.join(dir, filename);
        const html = `<!doctype html><html lang="en"><body><main><p>${escapeHtml(text)}</p></main></body></html>\n`;
        await writeFile(absolute, html, "utf8");
        index.set(filename, { request_id: String(row.request_id || ""), surface });
      }
    }
    const result = spawnSync(
      executable,
      ["check", ...[...index.keys()], "--preset", "nycsg7", "--mode", "warn", "--format", "json"],
      { cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.error?.code === "ENOENT") {
      throw new Error("readable-or-else is required; install it with the same command used by the CI reading-level job");
    }
    if (result.status !== 0) {
      throw new Error(`readable-or-else failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`readable-or-else returned invalid JSON: ${(result.stdout || "").slice(0, 500)}`);
    }
    const scores = new Map();
    for (const item of parsed) {
      const key = index.get(path.basename(item.path));
      if (!key) continue;
      scores.set(`${key.request_id}:${key.surface}`, {
        grade: Number.isFinite(item.grade) ? item.grade : null,
        word_count: Number(item.word_count || 0),
        sentence_count: Number(item.sentence_count || 0),
      });
    }
    return scores;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(places));
}

function summarizeGrades(records, surface) {
  const scored = records.filter((record) => Number.isFinite(record.scores[surface]?.grade));
  const grades = scored.map((record) => record.scores[surface].grade);
  return {
    notices: records.length,
    scored: scored.length,
    mean_grade: round(grades.reduce((sum, grade) => sum + grade, 0) / grades.length),
    median_grade: round(percentile(grades, 0.5)),
    p90_grade: round(percentile(grades, 0.9)),
    at_or_below_grade_7: grades.filter((grade) => grade <= 7).length,
    above_grade_7_to_9: grades.filter((grade) => grade > 7 && grade <= 9).length,
    above_grade_9_to_12: grades.filter((grade) => grade > 9 && grade <= 12).length,
    above_grade_12: grades.filter((grade) => grade > 12).length,
  };
}

function summarizeSignals(records) {
  const keys = Object.keys(detectPropertySignals({}));
  return Object.fromEntries(keys.map((key) => [key, records.filter((record) => record.signals[key]).length]));
}

function summarizeCurrentExtraction(records) {
  const keys = Object.keys(currentPropertyExtraction({}));
  return Object.fromEntries(keys.map((key) => {
    const values = records.map((record) => record.current_extraction[key]);
    if (values.every((value) => typeof value === "number")) {
      return [key, values.reduce((sum, value) => sum + value, 0)];
    }
    return [key, values.filter(Boolean).length];
  }));
}

function summarizeJargon(records) {
  const keys = Object.keys(detectPropertyJargon({}));
  return Object.fromEntries(keys
    .map((key) => [key, records.filter((record) => record.jargon[key]).length])
    .filter(([, count]) => count > 0));
}

export function summarizeCensus(rows, scores, { asOf = null, source = "live" } = {}) {
  const records = rows.map((row) => {
    const requestId = String(row.request_id || "");
    const surfaces = renderedNoticeSurfaces(row);
    return {
      request_id: requestId,
      start_date: String(row.start_date || "").slice(0, 10) || null,
      agency_name: cleanNoticeText(row.agency_name) || null,
      notice_type: cleanNoticeText(row.type_of_notice_description) || null,
      title: surfaces.title || null,
      pattern: classifyPropertyPattern(row),
      signals: detectPropertySignals(row),
      jargon: detectPropertyJargon(row),
      current_extraction: currentPropertyExtraction(row, { today: asOf }),
      scores: Object.fromEntries(Object.keys(surfaces).map((surface) => [
        surface,
        scores.get(`${requestId}:${surface}`) || null,
      ])),
    };
  });
  const patterns = {};
  for (const key of Object.keys(PATTERN_LABELS)) {
    const members = records.filter((record) => record.pattern === key);
    if (!members.length) continue;
    const worst = [...members]
      .filter((record) => Number.isFinite(record.scores.combined?.grade))
      .sort((a, b) => b.scores.combined.grade - a.scores.combined.grade)
      .slice(0, 3)
      .map((record) => ({
        request_id: record.request_id,
        title: record.title,
        grade: round(record.scores.combined.grade),
      }));
    patterns[key] = {
      label: PATTERN_LABELS[key],
      count: members.length,
      title: summarizeGrades(members, "title"),
      detail_body: summarizeGrades(members, "detail_body"),
      combined: summarizeGrades(members, "combined"),
      signals: summarizeSignals(members),
      jargon: summarizeJargon(members),
      current_extraction: summarizeCurrentExtraction(members),
      worst,
    };
  }
  const worstForSurface = (surface, limit = 15) => [...records]
    .filter((record) => Number.isFinite(record.scores[surface]?.grade))
    .sort((a, b) => b.scores[surface].grade - a.scores[surface].grade)
    .slice(0, limit)
    .map((record) => ({
      request_id: record.request_id,
      title: record.title,
      pattern: record.pattern,
      grade: round(record.scores[surface].grade),
    }));
  const worst = worstForSurface("combined");
  const starts = records.map((record) => record.start_date).filter(Boolean).sort();
  return {
    schema_version: 1,
    metric: {
      tool: "readable-or-else",
      preset: "nycsg7",
      primary_formula: "flesch_kincaid_grade",
      target_max_grade: 7,
    },
    renderer_contract: {
      title: "short_title after the shared notice-text cleaner",
      search_excerpt: `query-dependent window of up to ${SEARCH_EXCERPT_RADIUS} characters on each side of a match; absent on the default Property list`,
      detail_body: `cleaned additional_description_1 truncated to ${DETAIL_BODY_LIMIT} characters`,
      excluded_body_fields: BODY_FIELDS.filter((field) => field !== "additional_description_1"),
    },
    corpus: {
      source,
      dataset: SOURCE_DATASET,
      section: PROPERTY_SECTION,
      as_of: asOf,
      count: records.length,
      start_date_min: starts[0] || null,
      start_date_max: starts.at(-1) || null,
      sha256: corpusSha256(rows),
    },
    overall: {
      title: summarizeGrades(records, "title"),
      detail_body: summarizeGrades(records, "detail_body"),
      combined: summarizeGrades(records, "combined"),
      signals: summarizeSignals(records),
      jargon: summarizeJargon(records),
      current_extraction: summarizeCurrentExtraction(records),
    },
    patterns,
    worst,
    worst_by_surface: {
      title: worstForSurface("title", 10),
      detail_body: worstForSurface("detail_body", 10),
      combined: worst.slice(0, 10),
    },
  };
}

function markdownTable(report) {
  const lines = [
    "| Pattern | n | Mean grade | Median | p90 | ≤7 | >12 |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const value of Object.values(report.patterns)) {
    const score = value.combined;
    lines.push(`| ${value.label} | ${value.count} | ${score.mean_grade ?? "—"} | ${score.median_grade ?? "—"} | ${score.p90_grade ?? "—"} | ${score.at_or_below_grade_7} | ${score.above_grade_12} |`);
  }
  return lines.join("\n");
}

export function reportAsMarkdown(report) {
  const score = report.overall.combined;
  const extraction = report.overall.current_extraction;
  const signals = report.overall.signals;
  return [
    `Corpus: ${report.corpus.count} notices (${report.corpus.start_date_min} through ${report.corpus.start_date_max}); SHA-256 \`${report.corpus.sha256}\`.`,
    "",
    `Combined title + rendered detail body: mean grade ${score.mean_grade}, median ${score.median_grade}, p90 ${score.p90_grade}; ${score.at_or_below_grade_7}/${score.scored} at or below grade 7.`,
    "",
    `Typed timed events: ${extraction.typed_event_count}; bid-deadline signals ${signals.bid_deadline}, typed bid deadlines ${extraction.typed_bid_deadline}, signals without a parseable date ${extraction.bid_deadline_signal_without_parseable_date}; known cross-type false positives ${extraction.known_cross_type_false_positive_count}; honest-empty notices ${extraction.honest_empty_typed_events}.`,
    "",
    markdownTable(report),
    "",
    "Worst combined scores:",
    "",
    ...report.worst.map((row) => `- ${row.request_id} — ${row.title} (${PATTERN_LABELS[row.pattern]}, grade ${row.grade})`),
  ].join("\n");
}

async function fetchCorpus({ asOf = null, limit = DEFAULT_LIMIT } = {}) {
  const where = [`section_name='${PROPERTY_SECTION.replaceAll("'", "''")}'`];
  if (asOf) where.push(`start_date <= '${asOf}T23:59:59.999'`);
  const params = new URLSearchParams({
    "$select": SOURCE_FIELDS.join(","),
    "$where": where.join(" AND "),
    "$order": "start_date DESC, request_id DESC",
    "$limit": String(limit),
  });
  const url = `${SOURCE_URL}?${params}`;
  const response = await fetch(url, { headers: { "User-Agent": "CityScroll property accessibility census" } });
  if (!response.ok) throw new Error(`City Record query failed: HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("City Record query did not return an array");
  return { rows, source: url };
}

function inputRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.properties)) return payload.properties;
  if (Array.isArray(payload?.notices)) return payload.notices.map((item) => item?.row || item).filter(Boolean);
  throw new Error("Input must be an array, a {properties: []} payload, or a {notices: [{row}]} fixture");
}

function parseArgs(argv) {
  const options = { asOf: null, input: null, format: "json", limit: DEFAULT_LIMIT, executable: "readable-or-else" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--as-of") options.asOf = argv[++index];
    else if (arg === "--input") options.input = argv[++index];
    else if (arg === "--format") options.format = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--readable-or-else") options.executable = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(options.asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50000) throw new Error("--limit must be an integer from 1 to 50000");
  if (!new Set(["json", "markdown"]).has(options.format)) throw new Error("--format must be json or markdown");
  return options;
}

function usage() {
  return `Usage: node tools/property_a11y_census.mjs [options]\n\nOptions:\n  --as-of YYYY-MM-DD       Bound the live City Record corpus by start_date\n  --input FILE              Score a saved JSON corpus instead of fetching live data\n  --format json|markdown    Output format (default: json)\n  --limit N                 Maximum live rows (default: ${DEFAULT_LIMIT})\n  --readable-or-else PATH   Override the readability executable\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  let rows;
  let source;
  if (options.input) {
    rows = inputRows(JSON.parse(await readFile(options.input, "utf8")));
    source = `file:${path.basename(options.input)}`;
  } else {
    ({ rows, source } = await fetchCorpus(options));
  }
  const scores = await scoreSurfaces(rows, options.executable);
  const report = summarizeCensus(rows, scores, { asOf: options.asOf, source });
  process.stdout.write(options.format === "markdown" ? `${reportAsMarkdown(report)}\n` : `${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`property_a11y_census: ${error.message}\n`);
    process.exitCode = 1;
  });
}
