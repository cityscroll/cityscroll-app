/**
 * Land detail page coherence — reconcile independently-derived reader state
 * before render so one project page never asserts incompatible facts.
 *
 * Shared root cause addressed here: list-row Open Data status, zap-outcomes
 * public_status, phase-spine current/next, hearing logistics, and statutory
 * clocks were each locally "correct" while the composed page contradicted itself.
 */

import { LAND_ULURP_PHASES } from "./land_phase_spine.mjs";
import { isoDateOnly } from "./ulurp_statutory_clock.mjs";

const clean = (value) => {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
};

const TERMINAL_STATUS_RE = /\bcompleted\b|\bapproved\b|\bdisapproved\b|\bwithdrawn\b|\bterminated\b/i;
const PUBLIC_REVIEW_RE = /public review/i;

export function statusRank(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return 0;
  if (/\bwithdrawn\b|\bterminated\b/.test(s)) return 50;
  if (/\bcompleted\b|\bapproved\b|\bdisapproved\b/.test(s)) return 40;
  if (PUBLIC_REVIEW_RE.test(s)) return 30;
  if (/\bnoticed\b/.test(s)) return 20;
  if (/\bactive\b|\bfiled\b/.test(s)) return 10;
  return 5;
}

/**
 * Exactly one resolved public status for the detail page.
 * Prefer the more terminal / authoritative zap-outcomes record status over a
 * lagging Open Data list-row stamp when they disagree.
 */
export function resolveLandPublicStatus(listRow = null, outcomeRecord = null) {
  const candidates = [
    { value: clean(outcomeRecord?.public_status), source: "zap_outcomes.public_status" },
    { value: clean(listRow?.public_status), source: "list_row.public_status" },
    { value: clean(outcomeRecord?.open_data?.public_status), source: "open_data.public_status" },
    { value: clean(listRow?.project_status), source: "list_row.project_status" },
    { value: clean(outcomeRecord?.open_data?.project_status), source: "open_data.project_status" },
  ].filter((c) => c.value);

  if (!candidates.length) {
    return {
      public_status: null,
      source: null,
      disagreement: false,
      candidates: [],
    };
  }

  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (statusRank(c.value) > statusRank(best.value)) best = c;
  }

  const distinct = [...new Set(candidates.map((c) => c.value))];
  return {
    public_status: best.value,
    source: best.source,
    disagreement: distinct.length > 1,
    candidates,
  };
}

function hearingDay(hearing) {
  return isoDateOnly(hearing?.event_date || hearing?.hearing_at || hearing?.hearing_date || hearing?.deadline);
}

/**
 * Next hearing must be future-dated, or absent. Past logistics may still be
 * retained separately for venue/maps context, but never labeled "Next hearing".
 */
export function selectNextLandHearing(hearings = [], today = null) {
  const day = isoDateOnly(today) || new Date().toISOString().slice(0, 10);
  const list = Array.isArray(hearings) ? hearings : [];
  const upcoming = list
    .map((h) => ({ hearing: h, date: hearingDay(h) }))
    .filter((row) => row.date && row.date >= day)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return upcoming[0]?.hearing || null;
}

/**
 * "What's next" must occur after the resolved current phase. Never fall back to
 * an earlier incomplete phase in the fixed ULURP template.
 */
export function selectNextLandPhase(phases = [], currentPhaseId = null) {
  const curIdx = LAND_ULURP_PHASES.indexOf(currentPhaseId);
  if (curIdx < 0) return null;
  const list = Array.isArray(phases) ? phases : [];
  for (let i = curIdx + 1; i < LAND_ULURP_PHASES.length; i++) {
    const id = LAND_ULURP_PHASES[i];
    const phase = list.find((p) => p.id === id || p.phase_id === id);
    if (!phase) continue;
    const state = phase.state || null;
    if (state === "future" || state === "current") {
      // Only advertise a later phase that is still ahead of the pointer.
      if (state === "future") {
        return {
          phase_id: phase.id || phase.phase_id,
          label_key: phase.label_key || null,
          short: phase.short || null,
        };
      }
    }
  }
  return null;
}

/**
 * Statutory deadline must be chronologically compatible with the phase start.
 * Returns null due when the inputs cannot form a coherent statutory fact.
 */
export function coherentStatutoryDue({ startDate = null, dueDate = null, windowDays = null } = {}) {
  const start = isoDateOnly(startDate);
  const due = isoDateOnly(dueDate);
  if (!due) {
    return { due_date: null, ok: false, reason: "missing_due" };
  }
  if (start && due < start) {
    return { due_date: null, ok: false, reason: "due_before_start" };
  }
  if (start && Number.isSafeInteger(windowDays) && windowDays >= 0) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const dueMs = Date.parse(`${due}T00:00:00Z`);
    if (Number.isFinite(startMs) && Number.isFinite(dueMs)) {
      const span = Math.round((dueMs - startMs) / 86_400_000);
      // Allow a small calendar skew of 1 day; otherwise reject impossible clocks.
      if (span > windowDays + 1) {
        return { due_date: null, ok: false, reason: "due_exceeds_window" };
      }
    }
  }
  return { due_date: due, ok: true, reason: null };
}

/**
 * Days-left from the SAME deadline shown to the reader. Past deadlines never
 * yield a positive count.
 */
export function daysLeftFromDeadline(dueDate, today = null) {
  const due = isoDateOnly(dueDate);
  const day = isoDateOnly(today) || new Date().toISOString().slice(0, 10);
  if (!due) return null;
  const dueMs = Date.parse(`${due}T00:00:00Z`);
  const todayMs = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(dueMs) || !Number.isFinite(todayMs)) return null;
  return Math.ceil((dueMs - todayMs) / 86_400_000);
}

/**
 * Compose reader-facing coherence flags for tests and optional UI disclosure.
 */
export function landDetailCoherenceReport({
  listRow = null,
  outcomeRecord = null,
  phaseView = null,
  hearings = [],
  clock = null,
  today = null,
} = {}) {
  const status = resolveLandPublicStatus(listRow, outcomeRecord);
  const nextHearing = selectNextLandHearing(hearings, today);
  const currentPhaseId = phaseView?.current?.phase_id || null;
  const nextPhase = selectNextLandPhase(phaseView?.phases || [], currentPhaseId);
  const completed = status.public_status && TERMINAL_STATUS_RE.test(status.public_status);

  const openClockPhases = (clock?.phases || []).filter((p) => !p.status || p.status === "open");
  const clockIssues = [];
  for (const row of openClockPhases) {
    const check = coherentStatutoryDue({
      startDate: row.start_date || null,
      dueDate: row.due_date || null,
      windowDays: row.days ?? null,
    });
    if (row.due_date && !check.ok) {
      clockIssues.push({ phase_id: row.phase_id, reason: check.reason });
    }
  }

  const contradictions = [];
  // Source disagreement is recorded separately; the page is coherent when it
  // renders exactly one resolved status (and the other invariants below hold).
  if (
    currentPhaseId
    && phaseView?.next?.phase_id
    && LAND_ULURP_PHASES.indexOf(phaseView.next.phase_id) < LAND_ULURP_PHASES.indexOf(currentPhaseId)
  ) {
    contradictions.push("next_phase_before_current");
  }
  if (clockIssues.length) contradictions.push("incoherent_statutory_deadline");
  if (completed && phaseView?.current?.in_public_review) {
    contradictions.push("completed_marked_in_public_review");
  }

  return {
    schema_version: 1,
    public_status: status.public_status,
    public_status_source: status.source,
    public_status_disagreement: status.disagreement,
    next_hearing: nextHearing,
    next_phase: nextPhase,
    completed,
    clock_issues: clockIssues,
    contradictions,
    coherent: contradictions.length === 0,
  };
}
