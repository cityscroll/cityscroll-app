// Source watch: pure comparison of observed legal source text against the register's hashes.
//
// Prototype location: imports "../register/legal_register.mjs". In cityscroll-app this lands as
// ontology/procurement_legal_source_watch.mjs and the import becomes "./procurement_legal_register.mjs".
// Node built-ins only. No I/O, no clock, no mutation: the register is only read.
import { normalizeLegalText, sha256Hex } from "./procurement_legal_register.mjs";

export const LEGAL_SOURCE_WATCH_RECEIPT_SCHEMA = "cityscroll.legal_source_watch_receipt.v1";
export const SOURCE_WATCH_STATUSES = Object.freeze(["unchanged", "changed", "fetch_failed", "not_checked"]);

/** The only transform applied before hashing: drop a BOM, make line endings LF. */
export function normalizeCapture(text) {
  return String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function sourcesInUse(register) {
  const bySource = new Map();
  // Every catalogued source is watched, even one no entry cites yet (it then affects no entry).
  for (const file of Object.keys(register.sources?.files || {})) bySource.set(file, []);
  for (const entry of register.entries) {
    const file = entry.authority?.source_file;
    if (!file) continue;
    if (!bySource.has(file)) bySource.set(file, []);
    bySource.get(file).push(entry);
  }
  return bySource;
}

function matchObservation(observations, file, register) {
  const direct = observations.find((item) => item?.source_file === file);
  if (direct) return direct;
  // A url-only observation matches only when that url identifies exactly one catalogued source.
  const urlHits = observations.filter((item) => item && !item.source_file && item.url);
  for (const item of urlHits) {
    const files = new Set(register.entries
      .filter((entry) => entry.authority?.url === item.url && entry.authority?.source_file)
      .map((entry) => entry.authority.source_file));
    if (files.size === 1 && files.has(file)) return item;
  }
  return null;
}

/**
 * Compare observations with the register.
 * observations: [{ source_file | url, fetched: true|false, status, text?, reason? }]
 * Returns a receipt. Never mutates the register and never changes review status.
 */
export function compareSourceCaptures(register, observations = [], { checkedAt = null } = {}) {
  const list = Array.isArray(observations) ? observations : [];
  const bySource = sourcesInUse(register);
  const catalog = register.sources?.files || {};
  const sources = [];
  const reviewItems = [];

  for (const [file, entries] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const expected = catalog[file]?.sha256 ?? entries[0]?.authority.source_sha256 ?? null;
    const affected = [...new Set(entries.map((entry) => entry.id))].sort();
    const row = {
      source_file: file,
      status: "not_checked",
      expected_sha256: expected,
      observed_sha256: null,
      http_status: null,
      affected_entry_ids: affected,
      broken_quotes: [],
      reason: "no observation supplied",
    };
    const observation = matchObservation(list, file, register);
    if (observation) {
      row.http_status = observation.status ?? null;
      const okStatus = Number.isInteger(observation.status) && observation.status >= 200 && observation.status < 300;
      if (observation.fetched !== true || !okStatus || typeof observation.text !== "string" || observation.text.length === 0) {
        row.status = "fetch_failed";
        row.reason = observation.reason
          || (observation.fetched !== true ? "fetch did not complete" : !okStatus ? `http status ${observation.status}` : "empty body");
      } else {
        const text = normalizeCapture(observation.text);
        row.observed_sha256 = sha256Hex(text);
        if (row.observed_sha256 === expected) {
          row.status = "unchanged";
          row.reason = null;
        } else {
          row.status = "changed";
          row.reason = "section text hash differs from authority.source_sha256";
          const normalized = normalizeLegalText(text);
          for (const entry of entries) {
            if (entry.review?.status !== "source_checked" && entry.review?.status !== "practitioner_reviewed") continue;
            for (const field of ["quote", "context_quote"]) {
              const quote = entry.authority?.[field];
              if (typeof quote === "string" && quote && !normalized.includes(normalizeLegalText(quote))) {
                row.broken_quotes.push({
                  entry_id: entry.id,
                  record_version: entry.record_version,
                  field,
                  quote_sha256: entry.authority[`${field}_sha256`] ?? sha256Hex(quote),
                });
              }
            }
          }
        }
      }
    }
    sources.push(row);

    if (row.status === "changed") {
      reviewItems.push({
        kind: row.broken_quotes.length ? "quote_broken" : "source_changed",
        source_file: file,
        entry_ids: affected,
        broken_quote_entry_ids: [...new Set(row.broken_quotes.map((item) => item.entry_id))].sort(),
        action: row.broken_quotes.length
          ? "a reviewed quote no longer occurs: re-read the source and propose a register change (new record_version); do not edit review status here"
          : "section text changed but every reviewed quote still occurs: re-read the section and decide whether a register change is needed",
      });
    } else if (row.status === "fetch_failed") {
      reviewItems.push({
        kind: "fetch_failed",
        source_file: file,
        entry_ids: affected,
        broken_quote_entry_ids: [],
        action: "could not check this source; it is NOT confirmed unchanged",
      });
    }
  }

  const known = new Set(bySource.keys());
  const unmatched = list
    .filter((item) => item && !(item.source_file && known.has(item.source_file))
      && !([...known].some((file) => matchObservation([item], file, register))))
    .map((item) => ({ source_file: item.source_file ?? null, url: item.url ?? null }));

  const summary = Object.fromEntries(SOURCE_WATCH_STATUSES.map((name) => [name, sources.filter((row) => row.status === name).length]));
  return {
    schema: LEGAL_SOURCE_WATCH_RECEIPT_SCHEMA,
    checked_at: checkedAt,
    register_schema: register.schema,
    register_version: register.version,
    mutates_register: false,
    summary,
    changes_found: summary.changed > 0,
    could_not_check: summary.fetch_failed > 0 || summary.not_checked > 0,
    sources,
    review_items: reviewItems,
    unmatched_observations: unmatched,
  };
}
