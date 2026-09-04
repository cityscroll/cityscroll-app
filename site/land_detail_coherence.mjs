/**
 * Land detail page coherence — reconcile independently-derived reader state
 * before render so one project page never asserts incompatible facts.
 *
 * Shared root cause addressed here: list-row Open Data status, zap-outcomes
 * public_status, phase-spine current/next, hearing logistics, and statutory
 * clocks were each locally "correct" while the composed page contradicted itself.
 */

/** Keep this module import-light — unique name so DOM-equivalence inlining
 *  does not collide with `LAND_ULURP_PHASES` from land_phase_spine. */
const LAND_COHERENCE_PHASE_ORDER = Object.freeze([
  "pre_application",
  "environmental",
  "pre_certification",
  "certification",
  "community_board",
  "borough_president",
  "cpc",
  "city_council",
  "mayoral_appeals",
]);

function landCoherenceIsoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function cleanLandStatusText(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

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
 *
 * Filed / Noticed / In Public Review / Completed are values of the SAME ZAP
 * `public_status` dimension (portal process label) — not separate concepts.
 * Open Data list rows often lag the portal (Filed while portal already Noticed);
 * prefer the more advanced authoritative stamp and never paint two "Public status"
 * lines for the same dimension.
 */
export function resolveLandPublicStatus(listRow = null, outcomeRecord = null) {
  const candidates = [
    { value: cleanLandStatusText(outcomeRecord?.public_status), source: "zap_outcomes.public_status" },
    { value: cleanLandStatusText(listRow?.public_status), source: "list_row.public_status" },
    { value: cleanLandStatusText(outcomeRecord?.open_data?.public_status), source: "open_data.public_status" },
    { value: cleanLandStatusText(listRow?.project_status), source: "list_row.project_status" },
    { value: cleanLandStatusText(outcomeRecord?.open_data?.project_status), source: "open_data.project_status" },
  ].filter((c) => c.value);

  if (!candidates.length) {
    return {
      public_status: null,
      source: null,
      disagreement: false,
      candidates: [],
      dimension: "public_status",
      dimension_note: "single_zap_public_status_enum",
    };
  }

  // Prefer portal / zap-outcomes public_status over project_status when ranks tie.
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    const rankDiff = statusRank(c.value) - statusRank(best.value);
    if (rankDiff > 0) best = c;
    else if (rankDiff === 0 && /public_status/.test(c.source) && !/public_status/.test(best.source)) {
      best = c;
    }
  }

  const publicValues = candidates
    .filter((c) => /public_status/.test(c.source))
    .map((c) => c.value);
  const distinctPublic = [...new Set(publicValues)];
  const distinct = [...new Set(candidates.map((c) => c.value))];
  return {
    public_status: best.value,
    source: best.source,
    disagreement: distinctPublic.length > 1 || distinct.length > 1,
    candidates,
    dimension: "public_status",
    dimension_note: "single_zap_public_status_enum",
    source_lag: distinctPublic.length > 1
      ? {
          values: distinctPublic,
          note: "Same public_status dimension; Open Data/list may lag the portal.",
        }
      : null,
  };
}

/**
 * A phase displayed after the resolved current phase must not read as completed
 * ("passed" / Done) unless it is an explained permitted overlap.
 *
 * @returns {{ ok: boolean, violations: object[] }}
 */
export function detectCompletedPhaseAfterCurrent(phaseView = null) {
  const phases = Array.isArray(phaseView?.phases)
    ? phaseView.phases
    : (Array.isArray(phaseView?.all_phases) ? phaseView.all_phases : []);
  const currentPhaseId = phaseView?.current?.phase_id || null;
  const curIdx = LAND_COHERENCE_PHASE_ORDER.indexOf(currentPhaseId);
  const violations = [];
  if (curIdx < 0) return { ok: true, violations };

  for (const phase of phases) {
    const id = phase?.id || phase?.phase_id || null;
    const idx = LAND_COHERENCE_PHASE_ORDER.indexOf(id);
    if (idx < 0 || idx <= curIdx) continue;
    const state = phase?.state || null;
    // Plain completed/passed after current is forbidden.
    if (state === "passed" || state === "completed" || state === "done") {
      const explained =
        phase?.overlap?.permitted === true
        && phase?.overlap?.label_key
        && state === "overlap";
      if (!explained) {
        violations.push({
          phase_id: id,
          state,
          current_phase_id: currentPhaseId,
          reason: "completed_after_current_unexplained",
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function hearingDay(hearing) {
  return landCoherenceIsoDate(hearing?.event_date || hearing?.hearing_at || hearing?.hearing_date || hearing?.deadline);
}

/**
 * Next hearing must be future-dated, or absent. Past logistics may still be
 * retained separately for venue/maps context, but never labeled "Next hearing".
 */
export function selectNextLandHearing(hearings = [], today = null) {
  const day = landCoherenceIsoDate(today) || new Date().toISOString().slice(0, 10);
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
  const curIdx = LAND_COHERENCE_PHASE_ORDER.indexOf(currentPhaseId);
  if (curIdx < 0) return null;
  const list = Array.isArray(phases) ? phases : [];
  for (let i = curIdx + 1; i < LAND_COHERENCE_PHASE_ORDER.length; i++) {
    const id = LAND_COHERENCE_PHASE_ORDER[i];
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
  const start = landCoherenceIsoDate(startDate);
  const due = landCoherenceIsoDate(dueDate);
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
  const due = landCoherenceIsoDate(dueDate);
  const day = landCoherenceIsoDate(today) || new Date().toISOString().slice(0, 10);
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
    && LAND_COHERENCE_PHASE_ORDER.indexOf(phaseView.next.phase_id) < LAND_COHERENCE_PHASE_ORDER.indexOf(currentPhaseId)
  ) {
    contradictions.push("next_phase_before_current");
  }
  if (clockIssues.length) contradictions.push("incoherent_statutory_deadline");
  if (completed && phaseView?.current?.in_public_review) {
    contradictions.push("completed_marked_in_public_review");
  }
  const phaseOrder = detectCompletedPhaseAfterCurrent(phaseView);
  if (!phaseOrder.ok) contradictions.push("completed_phase_after_current");

  return {
    schema_version: 1,
    public_status: status.public_status,
    public_status_source: status.source,
    public_status_disagreement: status.disagreement,
    public_status_dimension: status.dimension || "public_status",
    next_hearing: nextHearing,
    next_phase: nextPhase,
    completed,
    clock_issues: clockIssues,
    phase_order_violations: phaseOrder.violations,
    contradictions,
    coherent: contradictions.length === 0,
  };
}

/**
 * Single resolved project-state object for every reader-facing land detail
 * surface (participation panel, timeline lead, action rail, pipeline).
 *
 * Callers pass a phaseView already built with `public_status` from this object's
 * resolved value so Filed/Noticed cannot diverge across panels.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.listRow]
 * @param {object|null} [opts.outcomeRecord]
 * @param {object|null} [opts.phaseView] buildLandPhaseView result (preferred)
 * @param {Function|null} [opts.buildLandPhaseView] optional builder when phaseView omitted
 * @param {object|null} [opts.clock]
 * @param {object[]} [opts.hearings]
 * @param {string|null} [opts.today]
 */
export function buildLandProjectState(opts = {}) {
  const listRow = opts.listRow || null;
  const outcomeRecord = opts.outcomeRecord || null;
  const status = resolveLandPublicStatus(listRow, outcomeRecord);
  const publicStatus = status.public_status;

  let phaseView = opts.phaseView || null;
  if (!phaseView && typeof opts.buildLandPhaseView === "function" && outcomeRecord?.spine) {
    phaseView = opts.buildLandPhaseView(outcomeRecord.spine, {
      open_data: outcomeRecord.open_data || listRow || null,
      actions: outcomeRecord.actions || null,
      portal_url: outcomeRecord.portal_url || null,
      public_status: publicStatus,
      project_id: outcomeRecord.project_id || listRow?.project_id || null,
    });
  }

  // Ensure the phase view's stamped public_status matches the reconciled value.
  if (phaseView?.current && phaseView.current.public_status !== publicStatus) {
    phaseView = {
      ...phaseView,
      current: {
        ...phaseView.current,
        public_status: publicStatus,
        noticed: publicStatus ? /^noticed$/i.test(publicStatus) : !!phaseView.current.noticed,
        in_public_review: publicStatus
          ? /public review/i.test(publicStatus)
            && !/completed|approved|disapproved|withdrawn|terminated/i.test(publicStatus)
          : false,
      },
    };
  }

  const hearings = Array.isArray(opts.hearings)
    ? opts.hearings
    : (outcomeRecord?.hearing_logistics || []);
  const report = landDetailCoherenceReport({
    listRow,
    outcomeRecord,
    phaseView,
    hearings,
    clock: opts.clock || outcomeRecord?.statutory_clock || null,
    today: opts.today || null,
  });

  const explanation = opts.prediction?.promotion_status === "shadow_only_until_backtest_gate"
    && opts.prediction?.explanation?.schema === "cityscroll.land_prediction_explanation.v1"
    ? opts.prediction.explanation
    : {
        schema: "cityscroll.land_prediction_explanation.v1",
        schema_version: 1,
        status: "unavailable",
        known_reasons: [],
        unknown_signals: [],
        unavailable_note: "A grounded shadow-prediction explanation is unavailable; the incumbent prediction remains unchanged.",
      };

  return {
    schema_version: 1,
    project_id: outcomeRecord?.project_id || listRow?.project_id || phaseView?.project_id || null,
    // One reader-facing public status (same ZAP enum dimension).
    public_status: publicStatus,
    public_status_source: status.source,
    public_status_dimension: "public_status",
    public_status_dimension_note:
      "Filed/Noticed/In Public Review/Completed are values of one ZAP public_status field; Open Data may lag the portal.",
    source_lag: status.source_lag || null,
    phase_view: phaseView,
    current_phase_id: phaseView?.current?.phase_id || null,
    next_phase: phaseView?.next || report.next_phase,
    next_hearing: report.next_hearing,
    coherence: report,
    prediction_explanation: explanation,
  };
}
