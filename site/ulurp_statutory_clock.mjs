/**
 * ULURP statutory review clocks (NYC Charter §197-c).
 *
 * Once a project is certified / referred into formal ULURP public review, the
 * Charter fixes sequential review windows. This table is the versioned day-math
 * source of truth. Predictions that ride these deadlines are emitted elsewhere
 * via cityscroll.prediction.v0 (method: statutory_clock) — they are not source
 * assertions (the clock can toll; projects can withdraw).
 *
 * Phase status is not only open/withdrawn: completed milestones and terminal
 * public_status close stages so clocks and pipeline position do not stay
 * frozen on Community Board after review has moved on.
 *
 * Pure: no fetch, no env. Browser and worker share this module.
 */

import { mapMilestoneToPhase } from "./land_phase_spine.mjs";

export const ULURP_STATUTORY_CLOCK_SCHEMA_VERSION = 1;
export const ULURP_STATUTORY_STATUTE_REF = "NYC Charter §197-c";
export const ULURP_STATUTORY_MODEL_NAME = "ulurp_statutory_clock";
export const ULURP_STATUTORY_MODEL_VERSION = "1.0.0";

/**
 * Ordered statutory public-review stages after certification.
 * `days` is the Charter window for that body; `cumulative_days` is the end of
 * that window measured from the certification / referral date (D).
 *
 * CB 60 → BP +30 → CPC +60 → Council +50 → Mayor +5  (≤205 days total).
 */
export const ULURP_STATUTORY_STAGES = Object.freeze([
  Object.freeze({
    phase_id: "community_board",
    short: "CB",
    label_key: "land_phase_community_board",
    days: 60,
    cumulative_days: 60,
    model_stage: "community_board",
  }),
  Object.freeze({
    phase_id: "borough_president",
    short: "BP",
    label_key: "land_phase_borough_president",
    days: 30,
    cumulative_days: 90,
    model_stage: "borough_president",
  }),
  Object.freeze({
    phase_id: "cpc",
    short: "CPC",
    label_key: "land_phase_cpc",
    days: 60,
    cumulative_days: 150,
    model_stage: "cpc",
  }),
  Object.freeze({
    phase_id: "city_council",
    short: "Council",
    label_key: "land_phase_city_council",
    days: 50,
    cumulative_days: 200,
    model_stage: "city_council",
  }),
  Object.freeze({
    phase_id: "mayoral_appeals",
    short: "Mayor",
    label_key: "land_phase_mayoral_appeals",
    days: 5,
    cumulative_days: 205,
    model_stage: "mayoral_appeals",
  }),
]);

export const ULURP_STATUTORY_TOTAL_DAYS = 205;

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

/** @returns {string|null} YYYY-MM-DD */
export function isoDateOnly(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Add whole days on the UTC calendar (statute day-count is calendar days). */
export function addCalendarDays(isoDate, days) {
  const day = isoDateOnly(isoDate);
  if (!day) return null;
  if (!Number.isSafeInteger(days)) throw new TypeError("days must be a safe integer");
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve the certification / referral anchor date for statutory clocks.
 * Prefers the ZAP API certified-referred field; falls back to an observed
 * certification milestone with an actual date.
 */
export function resolveCertificationDate(record = {}) {
  const referred = isoDateOnly(record.certified_referred);
  if (referred) return referred;

  const openData = record.open_data || {};
  const odReferred = isoDateOnly(openData.certified_referred || openData.certified_date);
  if (odReferred) return odReferred;

  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  for (const m of milestones) {
    const title = String(m?.title || "").toLowerCase();
    const detail = String(m?.status || m?.outcome || m?.detail || "").toLowerCase();
    const date = isoDateOnly(m?.time?.value || m?.date);
    if (!date) continue;
    if (
      /application reviewed at city planning commission review session/.test(title)
      && /certif/.test(detail)
    ) {
      return date;
    }
    if (/\bcertif(y|ied|ication)\b/.test(title) && !/pre-?certif/.test(title) && /certif|completed|approved/.test(detail)) {
      return date;
    }
  }

  const events = Array.isArray(record.spine?.events) ? record.spine.events : [];
  for (const e of events) {
    const title = String(e?.title || "").toLowerCase();
    const detail = String(e?.detail || e?.status || e?.outcome || "").toLowerCase();
    const date = isoDateOnly(e?.time?.value);
    if (!date) continue;
    if (e?.time?.certainty === "planned") continue;
    if (
      /application reviewed at city planning commission review session/.test(title)
      && /certif/.test(detail)
    ) {
      return date;
    }
    if (/\bcertif(y|ied|ication)\b/.test(title) && !/pre-?certif/.test(title) && /certif|completed|approved/.test(detail)) {
      return date;
    }
  }

  return null;
}

/** True when the project has left formal review by withdrawal/termination. */
export function projectIsWithdrawn(record = {}) {
  const blobs = [
    record.public_status,
    record.open_data?.public_status,
    record.open_data?.project_status,
    record.open_data?.current_milestone,
    record.project_brief,
  ];
  for (const b of blobs) {
    if (/\bwithdrawn\b|\bterminated\b/i.test(String(b || ""))) return true;
  }
  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  for (const m of milestones) {
    const t = `${m?.title || ""} ${m?.status || ""} ${m?.outcome || ""}`;
    if (/project withdrawn|project terminated|\bwithdrawn\b|\bterminated\b/i.test(t)) return true;
  }
  const events = Array.isArray(record.spine?.events) ? record.spine.events : [];
  for (const e of events) {
    const t = `${e?.title || ""} ${e?.detail || ""} ${e?.status || ""}`;
    if (/project withdrawn|project terminated|\bwithdrawn\b|\bterminated\b/i.test(t)) return true;
  }
  return false;
}

/** True when the publisher marks the land-use review as finished (not withdrawn). */
export function projectIsCompleted(record = {}) {
  if (projectIsWithdrawn(record)) return false;
  const blobs = [
    record.public_status,
    record.open_data?.public_status,
    record.open_data?.project_status,
  ];
  for (const b of blobs) {
    const s = String(b || "").toLowerCase();
    if (/\bcompleted\b|\bapproved\b|\bdisapproved\b|\bterminated\b/.test(s)) return true;
  }
  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  for (const m of milestones) {
    const t = `${m?.title || ""} ${m?.status || ""}`;
    if (/project completed/i.test(t) && /completed|approved/i.test(String(m?.status || t))) {
      return true;
    }
  }
  return false;
}

function milestoneLooksCompleted(status, detail) {
  const s = `${status || ""} ${detail || ""}`.toLowerCase();
  if (!s.trim()) return false;
  if (/\bin progress\b|\bnot started\b|\bplanned\b|\bupcoming\b/.test(s)) return false;
  return /\bcompleted\b|\bapproved\b|\bsubmitted\b|\bcertified\b|\bfavorable\b|\bunfavorable\b|\bdisapproved\b/.test(
    s,
  );
}

/**
 * Map completed ZAP milestones / spine events onto statutory public-review phases.
 * Returns phase_id → { completed_at, evidence_id } (earliest completion date wins).
 */
export function completedStatutoryPhases(record = {}) {
  const out = new Map();
  const statutory = new Set(ULURP_STATUTORY_STAGES.map((s) => s.phase_id));

  const consider = (title, status, detail, date, evidenceId, kind, representing) => {
    if (!milestoneLooksCompleted(status, detail)) return;
    const day = isoDateOnly(date);
    if (!day) return;
    const phaseId = mapMilestoneToPhase(title, {
      kind: kind || null,
      representing: representing || detail || null,
      detail: detail || null,
    });
    if (!statutory.has(phaseId)) return;
    const prev = out.get(phaseId);
    if (!prev || day < prev.completed_at) {
      out.set(phaseId, {
        completed_at: day,
        evidence_id: evidenceId || `ulurp-phase-complete:${phaseId}:${day}`,
      });
    }
  };

  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  for (const m of milestones) {
    consider(
      m?.title,
      m?.status,
      m?.outcome || m?.detail,
      m?.time?.value || m?.date || m?.display_date || m?.dcp_actualenddate,
      m?.id ? `zap-milestone:${m.id}` : null,
      m?.kind || "zap_milestone",
      m?.representing || null,
    );
  }

  const events = Array.isArray(record.spine?.events) ? record.spine.events : [];
  for (const e of events) {
    if (e?.time?.certainty === "planned") continue;
    consider(
      e?.title,
      e?.status,
      e?.detail || e?.outcome,
      e?.time?.value,
      e?.id ? String(e.id) : null,
      e?.kind || "zap_milestone",
      e?.representing || e?.detail || null,
    );
  }

  // Disposition rows carry body identity + vote/hearing completion signals.
  const dispositions = Array.isArray(record.dispositions) ? record.dispositions : [];
  for (const d of dispositions) {
    const status = d?.status || "";
    const representing = d?.representing || d?.name || "";
    const day = isoDateOnly(d?.vote_date || d?.hearing_date || d?.date);
    if (!day) continue;
    if (!milestoneLooksCompleted(status, representing) && !/submitted|completed|approved/i.test(String(status))) {
      // Saved / draft dispositions are not completions.
      if (!/\bsubmitted\b|\bcompleted\b|\bapproved\b/i.test(String(status))) continue;
    }
    const phaseId = mapMilestoneToPhase(d?.name || representing, {
      kind: "zap_disposition",
      representing,
      detail: representing,
    });
    if (!statutory.has(phaseId)) continue;
    const prev = out.get(phaseId);
    const evidence = d?.id ? `zap-disposition:${d.id}` : `ulurp-disposition:${phaseId}:${day}`;
    if (!prev || day < prev.completed_at) {
      out.set(phaseId, { completed_at: day, evidence_id: evidence });
    }
  }

  return out;
}

/**
 * Detector: completed / advanced land projects whose statutory clock still lists
 * every phase as open. Returns finding object or null.
 */
export function detectStaleOpenStatutoryClock(record = {}, clock = null) {
  const view = clock || buildUlurpStatutoryClockView(record);
  if (!view || view.status === "ineligible") return null;
  if (view.status === "withdrawn") return null;
  const phases = Array.isArray(view.phases) ? view.phases : [];
  if (!phases.length) return null;
  const allOpen = phases.every((p) => !p.status || p.status === "open");
  if (!allOpen) return null;

  const completedMap = completedStatutoryPhases(record);
  const projectDone = projectIsCompleted(record);
  if (!projectDone && completedMap.size === 0) return null;

  const projectId = clean(record.project_id) || clean(record.open_data?.project_id) || "unknown";
  return {
    rule_id: "statutory_clock_stale_open",
    subject_ref: `land:${projectId}`,
    detail: {
      clock_status: view.status,
      public_status: record.public_status || record.open_data?.public_status || null,
      open_phase_count: phases.length,
      completed_phase_count: completedMap.size,
      project_completed: projectDone,
      sample_completed_phases: [...completedMap.keys()].slice(0, 5),
    },
  };
}

/**
 * Build per-phase statutory due dates from a certification date.
 * Does not invent a cert date — returns null when uncertified.
 *
 * @param {string} certifiedDate YYYY-MM-DD
 * @returns {object[]|null}
 */
export function projectStatutoryDeadlines(certifiedDate) {
  const d = isoDateOnly(certifiedDate);
  if (!d) return null;
  return ULURP_STATUTORY_STAGES.map((stage) => ({
    phase_id: stage.phase_id,
    short: stage.short,
    label_key: stage.label_key,
    days: stage.days,
    cumulative_days: stage.cumulative_days,
    model_stage: stage.model_stage,
    due_date: addCalendarDays(d, stage.cumulative_days),
    statute_ref: ULURP_STATUTORY_STATUTE_REF,
  }));
}

/**
 * Evidence event ids for the certification anchor (stable strings for the contract).
 */
export function certificationEvidenceIds(record = {}, certifiedDate) {
  const ids = []; // evidence ids from ZAP certification milestone (NYC Charter §197-c)
  const date = isoDateOnly(certifiedDate);
  const projectId = clean(record.project_id) || clean(record.open_data?.project_id) || "project";
  if (record.certified_referred || record.open_data?.certified_referred) {
    ids.push(`zap-certified-referred:${projectId}:${date || "unknown"}`);
  }
  const events = Array.isArray(record.spine?.events) ? record.spine.events : [];
  for (const e of events) {
    const title = String(e?.title || "").toLowerCase();
    const detail = String(e?.detail || e?.status || "").toLowerCase();
    if (
      /application reviewed at city planning commission review session/.test(title)
      && /certif/.test(detail)
      && e?.id
    ) {
      ids.push(String(e.id));
    }
  }
  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  for (const m of milestones) {
    const title = String(m?.title || "").toLowerCase();
    const detail = String(m?.status || m?.outcome || "").toLowerCase();
    if (
      /application reviewed at city planning commission review session/.test(title)
      && /certif/.test(detail)
    ) {
      ids.push(`zap-milestone:${m.id || m.sequence || date || "cert"}`);
    }
  }
  if (!ids.length && date) ids.push(`ulurp-certification:${projectId}:${date}`);
  return [...new Set(ids)];
}

/**
 * Precompute-first presentation + machine slice for one land outcome record.
 * Safe to stamp onto GET /zap-outcomes materialization. No day math later.
 *
 * @param {object} record - parseZapApiProject / buildZapOutcomeRecord shape
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] ISO timestamp
 * @returns {object|null} null when the project is not yet certified
 */
export function buildUlurpStatutoryClockView(record = {}, opts = {}) {
  const certifiedDate = resolveCertificationDate(record);
  if (!certifiedDate) {
    return {
      schema_version: ULURP_STATUTORY_CLOCK_SCHEMA_VERSION,
      statute_ref: ULURP_STATUTORY_STATUTE_REF,
      model_name: ULURP_STATUTORY_MODEL_NAME,
      model_version: ULURP_STATUTORY_MODEL_VERSION,
      status: "ineligible",
      reason: "not_certified",
      certified_date: null,
      phases: [],
      disposition: null,
      generated_at: opts.generatedAt || null,
    };
  }

  const withdrawn = projectIsWithdrawn(record);
  const projectDone = !withdrawn && projectIsCompleted(record);
  const completed = withdrawn ? new Map() : completedStatutoryPhases(record);
  const dispositionDue = addCalendarDays(certifiedDate, ULURP_STATUTORY_TOTAL_DAYS);

  const phases = projectStatutoryDeadlines(certifiedDate).map((p) => {
    if (withdrawn) {
      return { ...p, status: "withdrawn", completed_at: null, evidence_id: null };
    }
    const hit = completed.get(p.phase_id);
    if (hit) {
      return {
        ...p,
        status: "completed",
        completed_at: hit.completed_at,
        evidence_id: hit.evidence_id,
      };
    }
    // Terminal project status closes remaining statutory stages without inventing dates.
    if (projectDone) {
      return {
        ...p,
        status: "completed",
        completed_at: null,
        evidence_id: null,
      };
    }
    return { ...p, status: "open", completed_at: null, evidence_id: null };
  });

  let dispositionStatus = "open";
  let dispositionCompletedAt = null;
  let dispositionEvidence = null;
  if (withdrawn) {
    dispositionStatus = "withdrawn";
  } else if (projectDone) {
    dispositionStatus = "completed";
    // Prefer last completed statutory phase date as disposition evidence when present.
    const completedDays = phases
      .map((p) => p.completed_at)
      .filter(Boolean)
      .sort();
    dispositionCompletedAt = completedDays.length ? completedDays[completedDays.length - 1] : null;
    dispositionEvidence = dispositionCompletedAt
      ? `ulurp-disposition-complete:${clean(record.project_id) || "project"}:${dispositionCompletedAt}`
      : null;
  }

  const allPhasesCompleted =
    phases.length > 0 && phases.every((p) => p.status === "completed" || p.status === "withdrawn");
  let status = "open";
  let reason = null;
  if (withdrawn) {
    status = "withdrawn";
    reason = "project_withdrawn";
  } else if (projectDone || (allPhasesCompleted && dispositionStatus === "completed")) {
    status = "completed";
    reason = projectDone ? "project_completed" : "statutory_phases_completed";
  }

  return {
    schema_version: ULURP_STATUTORY_CLOCK_SCHEMA_VERSION,
    statute_ref: ULURP_STATUTORY_STATUTE_REF,
    model_name: ULURP_STATUTORY_MODEL_NAME,
    model_version: ULURP_STATUTORY_MODEL_VERSION,
    status,
    reason,
    certified_date: certifiedDate,
    total_days: ULURP_STATUTORY_TOTAL_DAYS,
    phases,
    disposition: {
      phase_id: "disposition",
      predicted_event_kind: "land.zap_disposition",
      due_date: dispositionDue,
      cumulative_days: ULURP_STATUTORY_TOTAL_DAYS,
      statute_ref: ULURP_STATUTORY_STATUTE_REF,
      status: dispositionStatus,
      completed_at: dispositionCompletedAt,
      evidence_id: dispositionEvidence,
    },
    evidence_event_ids: certificationEvidenceIds(record, certifiedDate),
    generated_at: opts.generatedAt || null,
  };
}

/**
 * Map phase_id → statutory deadline row from a precomputed clock view.
 */
export function statutoryDeadlineForPhase(clockView, phaseId) {
  if (!clockView || clockView.status === "ineligible") return null;
  return (clockView.phases || []).find((p) => p.phase_id === phaseId) || null;
}

/** Statutory public-review phase ids in Charter order (CB → … → Mayor). */
export const ULURP_PUBLIC_REVIEW_PHASE_IDS = Object.freeze(
  ULURP_STATUTORY_STAGES.map((s) => s.phase_id),
);

/**
 * True when public_status (or clock status) means formal review has ended.
 * Terminal projects must not paint "Public review — step N … days past."
 */
export function publicStatusIsTerminal(publicStatus, clock = null) {
  if (clock && (clock.status === "completed" || clock.status === "withdrawn")) return true;
  const s = String(publicStatus || "").toLowerCase();
  return /\bcompleted\b|\bapproved\b|\bdisapproved\b|\bwithdrawn\b|\bterminated\b/.test(s);
}

/**
 * Prefer a pure rebuild of statutory_clock when the edge stamp is stale-open
 * (all phases open while milestones/status advanced). Safe no-op when already
 * coherent. Keeps land detail honest even when materialization lags.
 *
 * @param {object} record
 * @param {object} [opts]
 * @returns {object} shallow-cloned record with normalized statutory_clock
 */
export function normalizeLandOutcomeRecord(record = {}, opts = {}) {
  if (!record || typeof record !== "object") return record;
  const stamped = record.statutory_clock || null;
  const rebuilt = buildUlurpStatutoryClockView(record, {
    generatedAt: opts.generatedAt || stamped?.generated_at || record.generated_at || null,
  });
  if (!rebuilt) return record;
  // Always prefer rebuild when stamped clock is missing, ineligible, or stale-open.
  const stale = detectStaleOpenStatutoryClock(record, stamped);
  const stampedOpenAll =
    stamped
    && stamped.status === "open"
    && Array.isArray(stamped.phases)
    && stamped.phases.length > 0
    && stamped.phases.every((p) => !p.status || p.status === "open");
  const shouldReplace =
    !stamped
    || stale
    || stampedOpenAll
    || (stamped.status === "open" && projectIsCompleted(record))
    || (stamped.status === "open" && rebuilt.status === "completed")
    || (stamped.status === "open"
      && Array.isArray(rebuilt.phases)
      && rebuilt.phases.some((p) => p.status === "completed")
      && stampedOpenAll);
  if (!shouldReplace && stamped) return record;
  return { ...record, statutory_clock: rebuilt };
}

/**
 * Pipeline position inside formal ULURP public review.
 *
 * Public status "In Public Review" is the OVERALL stage; Community Board /
 * Borough President / CPC / Council / Mayor is the CURRENT STEP inside it.
 * Renders as one sentence so the two labels stop competing on the land card.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.phaseView] buildLandPhaseView result
 * @param {object|null} [opts.clock] statutory_clock from /zap-outcomes
 * @param {string|null} [opts.publicStatus]
 * @param {string} [opts.today] YYYY-MM-DD (for days-left math)
 * @returns {object|null} null when not in measurable public-review pipeline
 */
export function buildUlurpPipelinePosition(opts = {}) {
  const phaseView = opts.phaseView || null;
  const clock = opts.clock || null;
  const publicStatus = clean(opts.publicStatus)
    || clean(phaseView?.current?.public_status)
    || null;
  const today = isoDateOnly(opts.today) || new Date().toISOString().slice(0, 10);

  // Terminal projects: never claim an open public-review step or overdue window.
  // Stale edge clocks used to make Completed projects say "step 4 of 5, N days past."
  if (publicStatusIsTerminal(publicStatus, clock)) return null;

  const statusLower = (publicStatus || "").toLowerCase();
  // Do NOT treat a bare open clock as "in public review" — Completed projects
  // with lagging materialization still carry open clocks and certified dates.
  const overallPublicReview = /public review/i.test(statusLower)
    || phaseView?.current?.in_public_review === true;

  // Current step: prefer phase-view current when it is a statutory public-review stage.
  let stepPhaseId = clean(phaseView?.current?.phase_id) || null;
  if (stepPhaseId && !ULURP_PUBLIC_REVIEW_PHASE_IDS.includes(stepPhaseId)) {
    // Pre-cert / CEQR / filing are not steps *inside* public review.
    if (!/public review/i.test(statusLower)) return null;
    stepPhaseId = null;
  }

  // Fall back: first open statutory stage by due-date / sequence when phase view
  // has not advanced into the public-review band yet but status says public review.
  if (!stepPhaseId && overallPublicReview && clock?.phases?.length) {
    const open = clock.phases.find((p) => p.status === "open" || !p.status);
    stepPhaseId = open?.phase_id || clock.phases[0]?.phase_id || null;
  }

  if (!stepPhaseId || !ULURP_PUBLIC_REVIEW_PHASE_IDS.includes(stepPhaseId)) {
    return null;
  }
  if (!overallPublicReview && !phaseView?.current?.in_public_review) {
    // Only emit the combined sentence when public review is the overall frame.
    return null;
  }

  const stepIndex = ULURP_PUBLIC_REVIEW_PHASE_IDS.indexOf(stepPhaseId);
  const stepN = stepIndex + 1;
  const stepM = ULURP_PUBLIC_REVIEW_PHASE_IDS.length;
  const stageMeta = ULURP_STATUTORY_STAGES.find((s) => s.phase_id === stepPhaseId);
  const clockRow = statutoryDeadlineForPhase(clock, stepPhaseId);
  // Completed/closed phase rows must not drive an "open window / overdue" count.
  const phaseStillOpen = !clockRow?.status || clockRow.status === "open";
  const dueDate = phaseStillOpen ? (clockRow?.due_date || null) : null;
  const windowDays = stageMeta?.days ?? clockRow?.days ?? null;

  let daysLeft = null;
  if (dueDate && phaseStillOpen) {
    const dueMs = Date.parse(`${dueDate}T00:00:00Z`);
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    if (Number.isFinite(dueMs) && Number.isFinite(todayMs)) {
      daysLeft = Math.ceil((dueMs - todayMs) / 86_400_000);
    }
  }

  return {
    schema_version: ULURP_STATUTORY_CLOCK_SCHEMA_VERSION,
    overall_status: "public_review",
    overall_label_key: "land_pipeline_overall_public_review",
    step_phase_id: stepPhaseId,
    step_label_key: stageMeta?.label_key || null,
    step_short: stageMeta?.short || null,
    step_n: stepN,
    step_m: stepM,
    window_days: windowDays,
    due_date: dueDate,
    days_left: daysLeft,
    statute_ref: ULURP_STATUTORY_STATUTE_REF,
    certified_date: clock?.certified_date || null,
    public_status: publicStatus,
  };
}
