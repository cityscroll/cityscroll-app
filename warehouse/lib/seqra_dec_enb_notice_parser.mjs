/**
 * Narrow parser for one NYS DEC Environmental Notice Bulletin listing page
 * (https://dec.ny.gov/news/environmental-notice-bulletin). There is no
 * documented JSON/CSV/API interface for ENB -- a bounded live discovery
 * fetch (see warehouse/fixtures/seqra-adapters/nys_dec_enb_notice_metadata)
 * confirmed a server-rendered Drupal Views listing instead. Per the
 * commission's negative rule, this module never treats that HTML as a
 * stable API: every extraction is checked against the page's own declared
 * row range, and any mismatch is a visible failure (SeqraSchemaDriftError),
 * never a silently smaller parse.
 *
 * The extraction is a small, versioned set of literal string/regex markers
 * captured from real page bytes on 2026-09-04 (SEQRA_ENB_PARSER_VERSION),
 * not a general HTML/DOM parser -- this repo has no HTML parsing dependency,
 * and a narrow marker set makes drift in the publisher's markup fail loudly
 * instead of silently matching nothing.
 */

import { SeqraSchemaDriftError } from "./seqra_structured_adapter.mjs";

export const SEQRA_ENB_PARSER_VERSION = "seqra_dec_enb_notice_parser.v1";

const SUMMARY_RESULTS_RE = /summary-results">\s*<strong>\s*([\d,]+)\s*-\s*([\d,]+)\s*of\s*([\d,]+)\s*results\s*<\/strong>/;
const ROW_START_RE = /<div\s+class="c-view__row">/g;
const TITLE_RE = /<a href="([^"]+)">\s*<span>([^<]*)<\/span>/;
const DATE_RE = /<span class="c-card__date">([^<]*)<\/span>/;
const LOCATION_RE = /<div class="c-field__content">([^<]*)<\/div>/;
const NOTICE_TYPE_RE = /environmental-notice-bulletin\/\d{4}-\d{2}-\d{2}\/([a-z0-9-]+)\//;

function toInt(text) {
  return Number(String(text).replace(/,/g, ""));
}

/**
 * @param {string} html one ENB listing page's raw bytes
 * @param {{ sourceId?: string }} [opts]
 * @returns {{
 *   range_start: number, range_end: number, total_results: number,
 *   row_block_count: number,
 *   notices: Array<{ title, url, publish_date_raw, publish_date, region_or_county, notice_type }>,
 *   malformed: Array<{ reason: string, excerpt: string }>,
 * }}
 */
export function parseEnbListingPage(html, { sourceId = "nys_dec_enb_notice_metadata" } = {}) {
  const summaryMatch = String(html).match(SUMMARY_RESULTS_RE);
  if (!summaryMatch) {
    throw new SeqraSchemaDriftError(sourceId, ["summary_results_header"], []);
  }
  const rangeStart = toInt(summaryMatch[1]);
  const rangeEnd = toInt(summaryMatch[2]);
  const totalResults = toInt(summaryMatch[3]);
  const expectedRowCount = rangeEnd - rangeStart + 1;

  const starts = [...html.matchAll(ROW_START_RE)].map((match) => match.index);
  const blocks = starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));

  if (blocks.length !== expectedRowCount) {
    throw new SeqraSchemaDriftError(
      sourceId,
      [`row_block_count (found ${blocks.length}, page header declares ${expectedRowCount})`],
      [],
    );
  }

  const notices = [];
  const malformed = [];
  for (const block of blocks) {
    const titleMatch = block.match(TITLE_RE);
    if (!titleMatch) {
      malformed.push({ reason: "missing title/href", excerpt: block.slice(0, 200) });
      continue;
    }
    const url = titleMatch[1];
    const title = titleMatch[2].trim();
    const dateMatch = block.match(DATE_RE);
    const rawDate = dateMatch ? dateMatch[1].trim() : null;
    const publishDateMs = rawDate ? Date.parse(rawDate) : NaN;
    const locationMatch = block.match(LOCATION_RE);
    const typeMatch = url.match(NOTICE_TYPE_RE);
    notices.push({
      title,
      url,
      publish_date_raw: rawDate,
      publish_date: Number.isFinite(publishDateMs) ? new Date(publishDateMs).toISOString().slice(0, 10) : null,
      region_or_county: locationMatch ? locationMatch[1].trim() : null,
      notice_type: typeMatch ? typeMatch[1] : null,
    });
  }

  if (notices.length === 0 && expectedRowCount > 0) {
    throw new SeqraSchemaDriftError(sourceId, ["all_row_blocks_malformed"], []);
  }

  return {
    range_start: rangeStart,
    range_end: rangeEnd,
    total_results: totalResults,
    row_block_count: blocks.length,
    notices,
    malformed,
  };
}
