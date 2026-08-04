/**
 * Template-shepherded public-comment participation for Agency Rules.
 *
 * On any rule with an open comment window: where comments go (deep-linked
 * official channel), what makes a comment count, and a neutral structural
 * scaffold (who you are / how this rule affects your operation / what you ask).
 * Never advocates a position — structures participation only.
 *
 * Pure: no DOM, no fetch.
 */

import { daysUntil } from "./rules_action_bands.mjs";

export const RULES_PARTICIPATION_SCHEMA_VERSION = 1;

/**
 * Whether the record has an open comment window as of `now`.
 * @param {object|null} rec — /rules materialization row or stitched view
 * @param {{ now?: string|Date|null }} [opts]
 */
export function hasOpenCommentWindow(rec, opts = {}) {
  const facts = extractCommentFacts(rec);
  if (!facts.comment_by_date && !facts.stage_comment_open) return false;
  if (facts.stage_comment_open && !facts.comment_by_date) return true;
  const dl = daysUntil(facts.comment_by_date, opts.now || null);
  return dl != null && dl >= 0;
}

/**
 * @param {object|null} rec
 */
export function extractCommentFacts(rec) {
  const nr = rec?.nyc_rules || rec?.stitched?.nyc_rules || null;
  const stage = rec?.stage || rec?.stitched?.stage || null;
  return {
    comment_url: clean(nr?.comment_url) || clean(nr?.url) || clean(rec?.comment_url) || null,
    rule_url: clean(nr?.url) || clean(rec?.rule_url) || null,
    comment_by_date: isoDate(nr?.comment_by_date || rec?.comment_by_date),
    hearing_date: isoDate(nr?.hearing_date || rec?.hearing_date),
    stage_comment_open: stage === "comment-open",
    agency: clean(rec?.agency || rec?.agency_name || rec?.city_record?.agency_name),
    title: clean(rec?.title || rec?.short_title || rec?.city_record?.short_title),
  };
}

/**
 * Neutral scaffold prompts — structure only, no position.
 * @returns {{ id: string, label_key: string, placeholder_key: string }[]}
 */
export function participationScaffoldFields() {
  return [
    {
      id: "who",
      label_key: "rule_part_scaffold_who_label",
      placeholder_key: "rule_part_scaffold_who_placeholder",
    },
    {
      id: "how_affects",
      label_key: "rule_part_scaffold_affects_label",
      placeholder_key: "rule_part_scaffold_affects_placeholder",
    },
    {
      id: "ask",
      label_key: "rule_part_scaffold_ask_label",
      placeholder_key: "rule_part_scaffold_ask_placeholder",
    },
  ];
}

/**
 * Build the participation path model for UI rendering.
 *
 * @param {object|null} rec
 * @param {object|null} noticeRow — City Record notice (title/agency fallback)
 * @param {{ now?: string|Date|null }} [opts]
 * @returns {object|null} null when comment window is not open
 */
export function buildRulesParticipationPath(rec, noticeRow = null, opts = {}) {
  const merged = {
    ...(rec || {}),
    agency: rec?.agency || rec?.agency_name || noticeRow?.agency_name,
    agency_name: rec?.agency_name || noticeRow?.agency_name,
    title: rec?.title || rec?.short_title || noticeRow?.short_title,
    short_title: rec?.short_title || noticeRow?.short_title,
  };
  if (!hasOpenCommentWindow(merged, opts) && !hasOpenCommentWindow(rec, opts)) {
    // Also accept notice-row stage stamps.
    const fromNotice = {
      stage: noticeRow?._ruleStage?.stage || noticeRow?.stage,
      nyc_rules: noticeRow?._ruleStage?.nyc_rules || noticeRow?.nyc_rules,
      agency_name: noticeRow?.agency_name,
      short_title: noticeRow?.short_title,
    };
    if (!hasOpenCommentWindow(fromNotice, opts)) return null;
    Object.assign(merged, fromNotice);
  }

  const facts = extractCommentFacts({
    ...merged,
    nyc_rules: merged.nyc_rules || rec?.nyc_rules || noticeRow?._ruleStage?.nyc_rules,
    stage: merged.stage || rec?.stage || noticeRow?._ruleStage?.stage,
  });
  // Re-check with fully extracted facts.
  if (facts.comment_by_date) {
    const dl = daysUntil(facts.comment_by_date, opts.now || null);
    if (dl != null && dl < 0) return null;
  } else if (!facts.stage_comment_open) {
    return null;
  }

  const daysLeft = facts.comment_by_date
    ? daysUntil(facts.comment_by_date, opts.now || null)
    : null;
  const submitUrl = facts.comment_url || facts.rule_url || null;

  return {
    schema_version: RULES_PARTICIPATION_SCHEMA_VERSION,
    open: true,
    submit_url: submitUrl,
    rule_url: facts.rule_url,
    comment_by_date: facts.comment_by_date,
    days_left: daysLeft,
    hearing_date: facts.hearing_date,
    agency: facts.agency || clean(noticeRow?.agency_name),
    title: facts.title || clean(noticeRow?.short_title),
    channel_label_key: "rule_part_channel_nyc_rules",
    counts_keys: [
      "rule_part_counts_timely",
      "rule_part_counts_specific",
      "rule_part_counts_identify",
    ],
    scaffold: participationScaffoldFields(),
    // Neutral seed lines that stimulate thinking without advocating a stance.
    scaffold_seed: {
      who: "",
      how_affects: "",
      ask: "",
    },
  };
}

/**
 * Assemble a draft comment from scaffold field values (still neutral structure).
 * @param {object} path — buildRulesParticipationPath result
 * @param {{ who?: string, how_affects?: string, ask?: string }} values
 */
export function assembleScaffoldDraft(path, values = {}) {
  const who = clean(values.who) || "";
  const how = clean(values.how_affects) || "";
  const ask = clean(values.ask) || "";
  const title = path?.title || "this proposed rule";
  const agency = path?.agency || "the agency";
  const lines = [];
  lines.push(`Re: ${title}`);
  if (who) lines.push("", who);
  else lines.push("", "[Who you are / role / organization]");
  if (how) lines.push("", how);
  else lines.push("", "[How this rule would affect your operation or members]");
  if (ask) lines.push("", ask);
  else lines.push("", "[What you ask the agency to consider]");
  lines.push("", `Submitted regarding ${agency}.`);
  return lines.join("\n");
}

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
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
