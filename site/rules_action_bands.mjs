/**
 * Rules action bands — group notices by what a reader can do now,
 * not merely by calendar date.
 *
 * Bands name the action; each entry carries that action's affordance.
 * Pure: no DOM, no fetch.
 */

import {
  normalizeRuleStage,
  ruleStageToPhase,
  rulesOfficialLinks,
  rulesProcessActionKey,
} from "./rules_explorer.mjs";

export const RULES_ACTION_BANDS_SCHEMA_VERSION = 1;

/** Band order: act-now first, then attend, then already-decided, then residual. */
export const RULES_ACTION_BAND_ORDER = Object.freeze([
  "comment_open",
  "hearing",
  "adopted",
  "other",
]);

export const RULES_ACTION_BAND_META = Object.freeze({
  comment_open: {
    id: "comment_open",
    label_key: "rule_band_comment_open",
    label_with_days_key: "rule_band_comment_open_days",
    action_key: "rule_action_comment",
  },
  hearing: {
    id: "hearing",
    label_key: "rule_band_hearing",
    label_with_date_key: "rule_band_hearing_dated",
    action_key: "rule_action_attend_hearing",
  },
  adopted: {
    id: "adopted",
    label_key: "rule_band_adopted",
    label_with_date_key: "rule_band_adopted_effective",
    action_key: "rule_phase_action_adoption",
  },
  other: {
    id: "other",
    label_key: "rule_band_other",
    action_key: "rule_action_open_notice",
  },
});

/**
 * Calendar days remaining until ISO date (UTC noon). Negative = past.
 * @param {string|null|undefined} iso
 * @param {string|Date|null} [now]
 */
export function daysUntil(iso, now = null) {
  const day = isoDate(iso);
  if (!day) return null;
  const end = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(end)) return null;
  let start;
  if (now instanceof Date) {
    start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 12 * 3600 * 1000;
  } else if (now) {
    const n = isoDate(now) || String(now).slice(0, 10);
    start = Date.parse(`${n}T12:00:00Z`);
  } else {
    const n = new Date();
    start = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + 12 * 3600 * 1000;
  }
  if (!Number.isFinite(start)) return null;
  return Math.round((end - start) / 86400000);
}

/**
 * Classify a rules explorer entry (or raw row+stage) into an action band.
 *
 * @param {object} entry — buildRulesExplorerEntries item or loose notice shape
 * @param {{ now?: string|Date|null }} [opts]
 * @returns {object}
 */
export function classifyRulesActionBand(entry, opts = {}) {
  const now = opts.now || null;
  const fine = normalizeRuleStage(
    entry?.fine_stage
    || entry?._ruleStage?.stage
    || entry?.stage
    || entry?.primary?._ruleStage?.stage,
  );
  const links = {
    comment_url: entry?.comment_url || null,
    rule_url: entry?.rule_url || null,
    comment_by_date: isoDate(entry?.comment_by_date) || null,
    hearing_date: isoDate(entry?.hearing_date) || null,
    ...rulesOfficialLinks(entry?.stitched || entry?._ruleStage || entry?.primary?._ruleStage || entry),
  };
  // Prefer entry-level fields when present.
  if (entry?.comment_by_date) links.comment_by_date = isoDate(entry.comment_by_date);
  if (entry?.hearing_date) links.hearing_date = isoDate(entry.hearing_date);
  if (entry?.comment_url) links.comment_url = entry.comment_url;
  if (entry?.rule_url) links.rule_url = entry.rule_url;

  const effectiveDate = isoDate(
    entry?.effective_date
    || entry?.stitched?.nyc_rules?.effective_date
    || entry?._ruleStage?.nyc_rules?.effective_date
    || entry?.primary?._ruleStage?.nyc_rules?.effective_date,
  );
  const adoptionDate = isoDate(
    entry?.adoption_published_at
    || entry?.stitched?.nyc_rules?.adoption_published_at
    || entry?._ruleStage?.nyc_rules?.adoption_published_at,
  );

  let bandId = "other";
  if (fine === "comment-open") {
    const dl = daysUntil(links.comment_by_date, now);
    if (dl == null || dl >= 0) bandId = "comment_open";
    else bandId = "other"; // closed by wall clock
  } else if (fine === "hearing") {
    bandId = "hearing";
  } else if (fine === "adopted" || fine === "effective") {
    bandId = "adopted";
  } else if (links.comment_by_date && daysUntil(links.comment_by_date, now) >= 0) {
    // Stage unknown but a future comment deadline is published.
    bandId = "comment_open";
  } else if (links.hearing_date && daysUntil(links.hearing_date, now) >= 0) {
    bandId = "hearing";
  }

  const meta = RULES_ACTION_BAND_META[bandId];
  const daysLeft = bandId === "comment_open"
    ? daysUntil(links.comment_by_date, now)
    : null;
  const phase = ruleStageToPhase(fine);
  const actionKey = bandId === "comment_open"
    ? "rule_action_comment"
    : bandId === "hearing"
      ? "rule_action_attend_hearing"
      : bandId === "adopted"
        ? (fine === "effective" ? "rule_phase_action_effective" : "rule_phase_action_adoption")
        : rulesProcessActionKey(phase, fine);

  // Primary affordance URL for the band action.
  let actionUrl = null;
  if (bandId === "comment_open") {
    actionUrl = links.comment_url || links.rule_url || null;
  } else if (bandId === "hearing" || bandId === "adopted") {
    actionUrl = links.rule_url || links.comment_url || null;
  }

  return {
    schema_version: RULES_ACTION_BANDS_SCHEMA_VERSION,
    band_id: bandId,
    label_key: meta.label_key,
    action_key: actionKey,
    action_url: actionUrl,
    days_left: daysLeft,
    comment_by_date: links.comment_by_date,
    hearing_date: links.hearing_date,
    effective_date: effectiveDate,
    adoption_date: adoptionDate,
    fine_stage: fine,
    process_stage: phase,
  };
}

/**
 * Resolve a display label for a band (or a single entry's band stamp).
 * @param {object} bandOrStamp — classifyRulesActionBand result or band group
 * @param {(key: string, vars?: object) => string} t — i18n lookup
 */
export function rulesActionBandLabel(bandOrStamp, t) {
  const translate = typeof t === "function" ? t : (k) => k;
  const id = bandOrStamp?.band_id || bandOrStamp?.id || "other";
  const meta = RULES_ACTION_BAND_META[id] || RULES_ACTION_BAND_META.other;
  if (id === "comment_open") {
    const days = bandOrStamp?.days_left;
    if (days != null && days >= 0 && meta.label_with_days_key) {
      return translate(meta.label_with_days_key, { n: String(days) });
    }
    return translate(meta.label_key);
  }
  if (id === "hearing") {
    const d = bandOrStamp?.hearing_date;
    if (d && meta.label_with_date_key) {
      return translate(meta.label_with_date_key, { date: formatBandDate(d, translate) });
    }
    return translate(meta.label_key);
  }
  if (id === "adopted") {
    const d = bandOrStamp?.effective_date || bandOrStamp?.adoption_date;
    if (d && meta.label_with_date_key) {
      return translate(meta.label_with_date_key, { date: formatBandDate(d, translate) });
    }
    return translate(meta.label_key);
  }
  return translate(meta.label_key);
}

/**
 * Group explorer entries into action bands (ordered).
 * Each group: { band_id, label_key, days_left, hearing_date, effective_date, entries[] }
 *
 * @param {object[]} entries
 * @param {{ now?: string|Date|null }} [opts]
 */
export function groupEntriesByActionBand(entries, opts = {}) {
  const buckets = new Map(RULES_ACTION_BAND_ORDER.map((id) => [id, []]));
  for (const entry of entries || []) {
    if (!entry) continue;
    const stamp = classifyRulesActionBand(entry, opts);
    const enriched = { ...entry, action_band: stamp };
    const list = buckets.get(stamp.band_id) || buckets.get("other");
    list.push(enriched);
  }

  const groups = [];
  for (const id of RULES_ACTION_BAND_ORDER) {
    const list = buckets.get(id) || [];
    if (!list.length) continue;
    const meta = RULES_ACTION_BAND_META[id];
    // Aggregate dates for the band header (soonest comment / hearing / effective).
    let daysLeft = null;
    let hearingDate = null;
    let effectiveDate = null;
    for (const e of list) {
      const s = e.action_band;
      if (s.days_left != null && (daysLeft == null || s.days_left < daysLeft)) {
        daysLeft = s.days_left;
      }
      if (s.hearing_date && (!hearingDate || s.hearing_date < hearingDate)) {
        hearingDate = s.hearing_date;
      }
      const eff = s.effective_date || s.adoption_date;
      if (eff && (!effectiveDate || eff < effectiveDate)) effectiveDate = eff;
    }
    groups.push({
      band_id: id,
      id,
      label_key: meta.label_key,
      action_key: meta.action_key,
      days_left: daysLeft,
      hearing_date: hearingDate,
      effective_date: effectiveDate,
      entries: list,
      count: list.length,
    });
  }
  return groups;
}

/**
 * Group raw digest rows (rules lens) for email rendering.
 * @param {object[]} rows
 * @param {{ now?: string|Date|null, rulesById?: Map|object }} [opts]
 */
export function groupDigestRowsByActionBand(rows, opts = {}) {
  const byId = opts.rulesById instanceof Map
    ? opts.rulesById
    : new Map(Object.entries(opts.rulesById || {}));
  const entries = (rows || []).map((row) => {
    const rid = row?.request_id != null ? String(row.request_id) : null;
    const rec = rid ? byId.get(rid) : null;
    return {
      primary: row,
      fine_stage: rec?.stage || row?.stage || null,
      comment_url: rec?.nyc_rules?.comment_url || row?.comment_url || null,
      rule_url: rec?.nyc_rules?.url || row?.rule_url || null,
      comment_by_date: rec?.nyc_rules?.comment_by_date || row?.comment_by_date || null,
      hearing_date: rec?.nyc_rules?.hearing_date || row?.hearing_date || row?.event_date || null,
      _ruleStage: rec || null,
    };
  });
  return groupEntriesByActionBand(entries, { now: opts.now || null });
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function formatBandDate(iso, t) {
  // Prefer caller's date formatter if they pass one via t.date; else raw ISO.
  if (typeof t?.date === "function") return t.date(iso);
  return iso;
}
