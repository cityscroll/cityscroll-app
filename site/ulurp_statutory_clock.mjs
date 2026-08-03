/**
 * ULURP statutory review clocks (NYC Charter §197-c).
 *
 * Once a project is certified / referred into formal ULURP public review, the
 * Charter fixes sequential review windows. This table is the versioned day-math
 * source of truth. Predictions that ride these deadlines are emitted elsewhere
 * via cityscroll.prediction.v0 (method: statutory_clock) — they are not source
 * assertions (the clock can toll; projects can withdraw).
 *
 * Pure: no fetch, no env. Browser and worker share this module.
 */

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
  const phases = projectStatutoryDeadlines(certifiedDate).map((p) => ({
    ...p,
    status: withdrawn ? "withdrawn" : "open",
  }));
  const dispositionDue = addCalendarDays(certifiedDate, ULURP_STATUTORY_TOTAL_DAYS);

  return {
    schema_version: ULURP_STATUTORY_CLOCK_SCHEMA_VERSION,
    statute_ref: ULURP_STATUTORY_STATUTE_REF,
    model_name: ULURP_STATUTORY_MODEL_NAME,
    model_version: ULURP_STATUTORY_MODEL_VERSION,
    status: withdrawn ? "withdrawn" : "open",
    reason: withdrawn ? "project_withdrawn" : null,
    certified_date: certifiedDate,
    total_days: ULURP_STATUTORY_TOTAL_DAYS,
    phases,
    disposition: {
      phase_id: "disposition",
      predicted_event_kind: "land.zap_disposition",
      due_date: dispositionDue,
      cumulative_days: ULURP_STATUTORY_TOTAL_DAYS,
      statute_ref: ULURP_STATUTORY_STATUTE_REF,
      status: withdrawn ? "withdrawn" : "open",
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

  const statusLower = (publicStatus || "").toLowerCase();
  const overallPublicReview = /public review/i.test(statusLower)
    || phaseView?.current?.in_public_review === true
    || (clock && clock.status === "open" && clock.certified_date);

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
    // Still allow when clock is open (certified) even if Open Data is stale.
    if (!(clock && clock.status === "open" && clock.certified_date)) return null;
  }

  const stepIndex = ULURP_PUBLIC_REVIEW_PHASE_IDS.indexOf(stepPhaseId);
  const stepN = stepIndex + 1;
  const stepM = ULURP_PUBLIC_REVIEW_PHASE_IDS.length;
  const stageMeta = ULURP_STATUTORY_STAGES.find((s) => s.phase_id === stepPhaseId);
  const clockRow = statutoryDeadlineForPhase(clock, stepPhaseId);
  const dueDate = clockRow?.due_date || null;
  const windowDays = stageMeta?.days ?? clockRow?.days ?? null;

  let daysLeft = null;
  if (dueDate) {
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
