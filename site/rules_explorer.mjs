/**
 * Rules domain explorer — list ontology over rulemaking process stages.
 *
 * Groups multi-notice rulemakings into one list entry (high-confidence
 * rulemaking_subject_ref only), filters by process phase (proposal → public
 * process → adoption → effective), and stamps next-action keys for feed cards.
 * Pure: no DOM, no fetch.
 *
 * Detail-page phase spine lives in site/rules_phase_spine.mjs; this module is
 * the list/explorer twin of site/property_explorer.mjs.
 */

import {
  RULES_PHASES,
  RULES_PHASE_META,
  isConfidentMultiNoticeRulemaking,
  isConfidentRelatedNotice,
  stitchRulemakingRecord,
} from "./rules_phase_spine.mjs";

export const RULES_EXPLORER_SCHEMA_VERSION = 1;

/** Process-stage filter chips for the Rules domain rail (ops ontology). */
export const RULES_PROCESS_STAGES = Object.freeze([
  ["all", "stage_all"],
  ["proposal", "rule_phase_proposal"],
  ["public_process", "rule_phase_public_process"],
  ["adoption", "rule_phase_adoption"],
  ["effective", "rule_phase_effective"],
  ["unstaged", "rule_stage_unstaged"],
]);

/** Fine materialization stage → process phase. */
export const RULE_STAGE_TO_PHASE = Object.freeze({
  proposed: "proposal",
  "comment-open": "public_process",
  hearing: "public_process",
  "comment-closed": "public_process",
  adopted: "adoption",
  effective: "effective",
});

const PHASE_ORDER = new Map(RULES_PHASES.map((id, i) => [id, i]));

const STAGE_RANK = Object.freeze({
  unknown: 0,
  proposed: 1,
  "comment-open": 2,
  hearing: 3,
  "comment-closed": 4,
  adopted: 5,
  effective: 6,
});

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

/**
 * Normalize a materialization stage string (null → null).
 * @param {string|null|undefined} stage
 */
export function normalizeRuleStage(stage) {
  const id = clean(stage);
  if (!id || id === "unknown") return null;
  return STAGE_RANK[id] != null ? id : null;
}

/**
 * Map fine stage → process phase id (or null when unstaged).
 * @param {string|null|undefined} stage
 */
export function ruleStageToPhase(stage) {
  const id = normalizeRuleStage(stage);
  if (!id) return null;
  return RULE_STAGE_TO_PHASE[id] || null;
}

/**
 * Process phase for a City Record notice row (from attached _ruleStage).
 * @param {object} row
 */
export function rulesProcessStage(row) {
  const rec = row?._ruleStage || row?.rule_stage || null;
  return ruleStageToPhase(rec?.stage || row?.stage) || null;
}

/**
 * Filter key for process rail counts (includes "unstaged").
 * @param {object} row
 */
export function rulesProcessFilterKey(row) {
  return rulesProcessStage(row) || "unstaged";
}

/**
 * Prefer the later of two fine stages (for multi-notice collapse).
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 */
export function pickLaterRuleStage(a, b) {
  const sa = normalizeRuleStage(a) || "unknown";
  const sb = normalizeRuleStage(b) || "unknown";
  const ra = STAGE_RANK[sa] ?? 0;
  const rb = STAGE_RANK[sb] ?? 0;
  return rb > ra ? (normalizeRuleStage(b) || null) : (normalizeRuleStage(a) || null);
}

/**
 * Action i18n key for a process phase / fine stage (next-action on list cards).
 * Prefer fine stage when it names a concrete resident action.
 * @param {string|null} phase
 * @param {string|null} [fineStage]
 */
export function rulesProcessActionKey(phase, fineStage = null) {
  const fine = normalizeRuleStage(fineStage);
  if (fine === "comment-open") return "rule_action_comment";
  if (fine === "hearing") return "rule_action_attend_hearing";
  if (fine === "comment-closed") return "rule_action_comment_closed";
  if (fine === "proposed") return "rule_phase_action_proposal";
  if (fine === "adopted") return "rule_phase_action_adoption";
  if (fine === "effective") return "rule_phase_action_effective";
  const id = phase && RULES_PHASE_META[phase] ? phase : ruleStageToPhase(fine);
  if (!id) return "rule_action_open_notice";
  return RULES_PHASE_META[id]?.action_key || "rule_action_open_notice";
}

/**
 * Index /rules materialization rows by request_id and rulemaking_subject_ref.
 * @param {object[]|object|null} rulesView — full /rules payload or rules[] array
 */
export function indexRulesRecords(rulesView) {
  const list = Array.isArray(rulesView)
    ? rulesView
    : Array.isArray(rulesView?.rules)
      ? rulesView.rules
      : [];
  const byRequestId = new Map();
  const bySubject = new Map();
  for (const rec of list) {
    if (!rec || typeof rec !== "object") continue;
    const rid = clean(rec.request_id);
    if (rid) byRequestId.set(rid, rec);
    const subject = clean(rec.rulemaking_subject_ref);
    if (subject) {
      if (!bySubject.has(subject)) bySubject.set(subject, []);
      bySubject.get(subject).push(rec);
    }
  }
  return { byRequestId, bySubject, list };
}

/**
 * Latest process phase implied by a multi-notice stitch / members.
 * @param {object|null} stitched
 * @param {object[]} members
 */
export function entryCurrentProcessStage(stitched, members = []) {
  let best = null;
  let bestOrder = -1;
  const candidates = [];
  if (stitched?.stage) candidates.push(ruleStageToPhase(stitched.stage));
  if (stitched?.current?.phase_id) candidates.push(stitched.current.phase_id);
  for (const m of members) {
    candidates.push(rulesProcessStage(m));
  }
  for (const id of candidates) {
    if (!id || !PHASE_ORDER.has(id)) continue;
    const order = PHASE_ORDER.get(id);
    if (order >= bestOrder) {
      bestOrder = order;
      best = id;
    }
  }
  return best;
}

/**
 * Latest fine stage across stitched record + members.
 * @param {object|null} stitched
 * @param {object[]} members
 */
export function entryFineStage(stitched, members = []) {
  let best = normalizeRuleStage(stitched?.stage) || null;
  for (const m of members) {
    const stage = normalizeRuleStage(m?._ruleStage?.stage || m?.stage);
    best = pickLaterRuleStage(best, stage);
  }
  return best;
}

function sortNoticesNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    const da = isoDate(a?.start_date) || isoDate(a?.event_date) || "";
    const db = isoDate(b?.start_date) || isoDate(b?.event_date) || "";
    return String(db).localeCompare(String(da));
  });
}

/**
 * Title for a multi-notice rulemaking card (prefer proposal title when present).
 * @param {object[]} members
 * @param {object|null} stitched
 */
export function rulemakingListTitle(members, stitched = null) {
  const fromStitch = clean(stitched?.title)
    || clean(stitched?.city_record?.title)
    || clean(stitched?.city_record?.short_title);
  if (fromStitch) return fromStitch;
  const sorted = sortNoticesNewestFirst(members || []);
  // Prefer a proposal-shaped notice when roles are known.
  for (const m of sorted) {
    const role = clean(m?._ruleStage?.rulemaking_join?.role);
    if (role === "proposal") {
      return clean(m.short_title) || clean(m.title) || null;
    }
  }
  const primary = sorted[0];
  return clean(primary?.short_title) || clean(primary?.title) || null;
}

/**
 * Agency entity link target for list cards (cross-domain affordance).
 * @param {object} row
 * @param {object|null} stitched
 */
export function rulesAgencyName(row, stitched = null) {
  return (
    clean(row?.agency_name)
    || clean(stitched?.agency)
    || clean(stitched?.agency_name)
    || clean(stitched?.city_record?.agency_name)
    || null
  );
}

/**
 * Official NYC Rules / comment URLs from a stitched or row record.
 * @param {object|null} rec
 */
export function rulesOfficialLinks(rec) {
  const nr = rec?.nyc_rules || rec?._ruleStage?.nyc_rules || null;
  return {
    rule_url: clean(nr?.url) || null,
    comment_url: clean(nr?.comment_url) || clean(nr?.url) || null,
    comment_by_date: isoDate(nr?.comment_by_date) || null,
    hearing_date: isoDate(nr?.hearing_date) || null,
  };
}

/**
 * Build list entries for the Rules explorer.
 * Multi-notice rulemakings (high-confidence join) collapse to one entry;
 * singleton / unjoined notices remain individual cards.
 *
 * @param {object[]} notices — City Record Agency Rules rows (may carry _ruleStage)
 * @param {object[]|object|null} rulesView — /rules materialization
 * @param {object} [opts]
 * @param {string|null} [opts.now]
 * @returns {object[]}
 */
export function buildRulesExplorerEntries(notices, rulesView, opts = {}) {
  const rows = Array.isArray(notices) ? notices.filter(Boolean) : [];
  const { byRequestId } = indexRulesRecords(rulesView);

  // Ensure every row has _ruleStage when the view knows the request_id.
  for (const row of rows) {
    const rid = clean(row.request_id);
    if (!rid) continue;
    if (!row._ruleStage && byRequestId.has(rid)) {
      row._ruleStage = byRequestId.get(rid);
    }
  }

  // subject_ref → notices in current window
  const membersBySubject = new Map();
  for (const row of rows) {
    const rec = row._ruleStage || byRequestId.get(String(row.request_id || "")) || null;
    const subject = clean(rec?.rulemaking_subject_ref) || null;
    if (!subject) continue;
    if (!isConfidentMultiNoticeRulemaking(rec)) continue;
    if (!membersBySubject.has(subject)) membersBySubject.set(subject, []);
    membersBySubject.get(subject).push(row);
  }

  // Multi-notice only when join says so, or ≥2 notices share the subject in-window.
  const multiSubjects = new Set();
  for (const [subject, members] of membersBySubject) {
    const sample = members[0]?._ruleStage || byRequestId.get(String(members[0]?.request_id || ""));
    const joinCount = sample?.rulemaking_join?.notice_count || 0;
    if (joinCount > 1 || members.length > 1) multiSubjects.add(subject);
  }

  const emittedSubjects = new Set();
  const entries = [];

  for (const row of rows) {
    const rid = clean(row.request_id);
    const rec = row._ruleStage || (rid ? byRequestId.get(rid) : null) || null;
    const subject = clean(rec?.rulemaking_subject_ref) || null;

    if (subject && multiSubjects.has(subject)) {
      if (emittedSubjects.has(subject)) continue;
      emittedSubjects.add(subject);

      const members = sortNoticesNewestFirst(membersBySubject.get(subject) || [row]);
      const primary = members[0] || row;
      // Stitch from the richest member record (prefer one that already has related_notices).
      const seed =
        members
          .map((m) => m._ruleStage || byRequestId.get(String(m.request_id || "")))
          .find((r) => r && isConfidentMultiNoticeRulemaking(r))
        || rec
        || null;
      const stitched = seed
        ? stitchRulemakingRecord(seed, byRequestId, { now: opts.now || null })
        : null;
      const fineStage = entryFineStage(stitched, members);
      const processStage =
        entryCurrentProcessStage(stitched, members)
        || ruleStageToPhase(fineStage)
        || null;
      const links = rulesOfficialLinks(stitched || primary._ruleStage || primary);
      const matchedPhases = [];
      for (const m of members) {
        const p = rulesProcessStage(m);
        if (p && !matchedPhases.includes(p)) matchedPhases.push(p);
      }
      if (processStage && !matchedPhases.includes(processStage)) {
        matchedPhases.push(processStage);
      }
      // Also credit phases from stitched sibling roles / stage.
      if (stitched?.multi_notice) {
        for (const sib of stitched.sibling_notices || []) {
          const p = ruleStageToPhase(sib.stage);
          if (p && !matchedPhases.includes(p)) matchedPhases.push(p);
        }
      }

      entries.push({
        kind: "rulemaking",
        schema_version: RULES_EXPLORER_SCHEMA_VERSION,
        subject_ref: subject,
        primary,
        members,
        notice_count:
          stitched?.notice_count
          || seed?.rulemaking_join?.notice_count
          || members.length,
        stitched: stitched || null,
        process_stage: processStage,
        process_filter: processStage || "unstaged",
        fine_stage: fineStage,
        action_key: rulesProcessActionKey(processStage, fineStage),
        agency: rulesAgencyName(primary, stitched),
        title: rulemakingListTitle(members, stitched),
        join_method: seed?.rulemaking_join?.method || null,
        matched_phases: matchedPhases,
        rule_url: links.rule_url,
        comment_url: links.comment_url,
        comment_by_date: links.comment_by_date,
        hearing_date: links.hearing_date,
        sibling_notices: stitched?.sibling_notices || [],
      });
      continue;
    }

    // Singleton notice card
    const processStage = rulesProcessStage(row);
    const fineStage = normalizeRuleStage(rec?.stage || row?.stage);
    const links = rulesOfficialLinks(rec || row);
    entries.push({
      kind: "notice",
      schema_version: RULES_EXPLORER_SCHEMA_VERSION,
      subject_ref: subject || (rid ? `notice:${rid}` : null),
      primary: row,
      members: [row],
      notice_count: 1,
      stitched: null,
      process_stage: processStage,
      process_filter: processStage || "unstaged",
      fine_stage: fineStage,
      action_key: rulesProcessActionKey(processStage, fineStage),
      agency: rulesAgencyName(row, rec),
      title: clean(row.short_title) || clean(row.title) || null,
      join_method: rec?.rulemaking_join?.method || (rec?.join?.matched ? "nyc_rules" : "single_notice"),
      matched_phases: processStage ? [processStage] : [],
      rule_url: links.rule_url,
      comment_url: links.comment_url,
      comment_by_date: links.comment_by_date,
      hearing_date: links.hearing_date,
      sibling_notices: [],
    });
  }

  return entries;
}

/**
 * Filter explorer entries by process phase, agency, and keyword.
 *
 * @param {object[]} entries
 * @param {object} opts
 * @param {string} [opts.process="all"]
 * @param {string|null} [opts.agency]
 * @param {string|null} [opts.keyword]
 * @param {(row: object) => string} [opts.matchText]
 */
export function filterRulesExplorerEntries(entries, opts = {}) {
  const process = opts.process || "all";
  const agency = clean(opts.agency);
  const keyword = clean(opts.keyword)?.toLowerCase() || null;
  const matchText =
    typeof opts.matchText === "function"
      ? opts.matchText
      : (row) =>
          [
            row?.short_title,
            row?.title,
            row?.agency_name,
            row?.additional_description_1,
            row?.type_of_notice_description,
          ]
            .filter(Boolean)
            .join(" ");

  return (entries || []).filter((entry) => {
    if (!entry || !entry.primary) return false;

    if (process !== "all") {
      if (process === "unstaged") {
        if (entry.process_filter !== "unstaged") return false;
      } else {
        // Keep multi-notice chains findable under earlier phases.
        const memberHit = (entry.members || [entry.primary]).some(
          (m) => rulesProcessStage(m) === process,
        );
        const matchedHit = (entry.matched_phases || []).includes(process);
        if (!memberHit && !matchedHit && entry.process_filter !== process) {
          return false;
        }
      }
    }

    if (agency) {
      const hit = (entry.members || [entry.primary]).some(
        (m) => clean(m.agency_name) === agency || clean(entry.agency) === agency,
      );
      if (!hit) return false;
    }

    if (keyword) {
      const hit = (entry.members || [entry.primary]).some((m) =>
        String(matchText(m) || "")
          .toLowerCase()
          .includes(keyword),
      );
      // Also search stitched / list title for multi-notice cards.
      const titleHit = clean(entry.title)?.toLowerCase().includes(keyword);
      if (!hit && !titleHit) return false;
    }

    return true;
  });
}

/**
 * Count process-filter keys across entries (for chip badges).
 * @param {object[]} entries
 */
export function countRulesProcessStages(entries) {
  const counts = { all: 0 };
  for (const [key] of RULES_PROCESS_STAGES) {
    if (key !== "all") counts[key] = 0;
  }
  for (const entry of entries || []) {
    counts.all += 1;
    const k = entry.process_filter || "unstaged";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * Re-export confidence helpers so list UI / tests share one import surface.
 */
export {
  isConfidentMultiNoticeRulemaking,
  isConfidentRelatedNotice,
  RULES_PHASES,
  RULES_PHASE_META,
};
