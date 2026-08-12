/**
 * Results-backed starter sets for Following.
 *
 * The input snapshots are the same open read models used by Browse. This
 * module deliberately does not query a second source or turn an unavailable
 * source into a zero: a missing source produces a null count and the set is
 * omitted from suggestions.
 */

import { currentMatchesHref } from "./following_view.mjs";
import { normalizeWatchTemplateRegistry } from "./watch_templates.mjs";

export const FOLLOWING_SUGGESTIONS_SCHEMA_VERSION = 1;

/**
 * Build the public starter-set registry for the current open snapshots.
 *
 * @param {object|null|undefined} registry
 * @param {{ money?: object|object[], rules?: object|object[], meetings?: object|object[] }} sources
 * @param {{ todayISO?: string }} [options]
 * @returns {{ schema_version: number, pattern: string, results_backed: boolean, templates: object[] }}
 */
export function buildResultsBackedWatchTemplateRegistry(registry, sources = {}, options = {}) {
  const normalized = normalizeWatchTemplateRegistry(registry);
  const templates = normalized.templates.map((template) => {
    const matchedWatches = [];
    const ids = new Set();
    let unavailable = false;

    for (const watch of template.watches) {
      const result = countOpenMatches(watch, sources, options);
      if (result.count == null) {
        unavailable = true;
        continue;
      }
      if (result.count < 1) continue;
      matchedWatches.push({ ...watch, matchCount: result.count });
      for (const id of result.ids) ids.add(id);
    }

    const matchCount = unavailable ? null : ids.size;
    if (matchCount == null || matchCount < 1) {
      return { ...template, watches: [], matchCount, resultsHref: null };
    }
    return {
      ...template,
      watches: matchedWatches,
      matchCount,
      resultsHref: currentMatchesHref(matchedWatches[0]),
    };
  }).filter((template) => Number.isInteger(template.matchCount) && template.matchCount > 0);

  return {
    schema_version: FOLLOWING_SUGGESTIONS_SCHEMA_VERSION,
    pattern: "results_backed_watch_template_registry",
    results_backed: true,
    generated_from: ["money_default_open", "rules_domain_observations", "meetings_domain_observations"],
    templates,
  };
}

/**
 * Count one watch against the open canonical universe.
 * @returns {{ count: number|null, ids: Set<string> }}
 */
export function countOpenMatches(watch, sources = {}, options = {}) {
  const lens = String(watch?.lens || "").trim();
  const source = sources[lens];
  const rows = sourceRows(source, lens);
  if (rows == null) return { count: null, ids: new Set() };

  const asOf = sourceAsOf(source, options.todayISO);
  const matches = rows.filter((row) => isOpenRow(row, lens, asOf) && rowMatchesWatch(row, watch));
  const ids = new Set(matches.map((row, index) => rowIdentity(row, lens, index)));
  return { count: ids.size, ids };
}

function sourceRows(source, lens) {
  if (source == null) return null;
  if (Array.isArray(source)) return source;
  if (lens === "money" && Array.isArray(source.notices)) return source.notices;
  if (Array.isArray(source.rows)) return source.rows;
  return [];
}

function sourceAsOf(source, fallback) {
  const value = source?.open_as_of || source?.as_of || source?.retrieved_at || fallback;
  return value ? String(value).slice(0, 10) : null;
}

function isOpenRow(row, lens, asOf) {
  const explicitStatuses = [
    row?.status,
    row?.temporal_status,
    row?.lifecycle_status,
    row?.rule_evidence?.lifecycle_status,
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  if (explicitStatuses.some((status) => /archiv|closed|expired|supersed|past/.test(status))) return false;

  if (lens === "money") {
    const due = dateValue(row?.due_date);
    return !due || !asOf || due > `${asOf}T00:00:00.000Z` || due.slice(0, 10) === asOf;
  }
  if (lens === "meetings") {
    const event = dateValue(row?.event_date);
    return Boolean(event && (!asOf || event > `${asOf}T00:00:00.000Z` || event.slice(0, 10) === asOf));
  }
  return true;
}

function rowMatchesWatch(row, watch) {
  const filter = watch?.filter && typeof watch.filter === "object" ? watch.filter : {};
  if (filter.agency && String(row?.agency_name || "") !== String(filter.agency)) return false;
  if (filter.noticeType) {
    const wanted = String(filter.noticeType).toLowerCase();
    if (String(row?.type_of_notice_description || "").toLowerCase() !== wanted) return false;
  }
  if (filter.borough || filter.boro) {
    const wanted = String(filter.borough || filter.boro).toLowerCase();
    const boroughs = [
      row?.borough,
      ...(Array.isArray(row?.affected_area?.boroughs) ? row.affected_area.boroughs : []),
      ...(Array.isArray(row?.place?.boroughs) ? row.place.boroughs : []),
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    if (!boroughs.includes(wanted)) return false;
  }
  const keywords = Array.isArray(filter.keywords) ? filter.keywords : [];
  if (!keywords.length) return true;
  const text = normalizeSearchText([
    row?.short_title,
    row?.agency_name,
    row?.type_of_notice_description,
    ...(Array.isArray(row?.rule_evidence?.topic_keys) ? row.rule_evidence.topic_keys : []),
    ...(Array.isArray(row?.matter_subject?.subject_tokens) ? row.matter_subject.subject_tokens : []),
  ].join(" "));
  return keywords.every((keyword) => {
    const tokens = normalizeSearchText(keyword).split(" ").filter(Boolean);
    return tokens.every((token) => text.includes(token));
  });
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowIdentity(row, lens, index) {
  const id = row?.request_id || row?.id || row?.project_id || row?.district_item_id;
  return id ? String(id) : `${lens}:${index}`;
}
