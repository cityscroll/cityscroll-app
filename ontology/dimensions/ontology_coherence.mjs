// Dimension: ontology-coherence
// Mechanical self-audit of generated lifecycle payloads for logical
// contradictions (current-stage vs later completions, past deadlines,
// out-of-order completions, implausible future dates, exam window vs
// post-list events). Emits the same multi-flywheel card stream.
//
// Pure: no network. Fixture inventory today; live payload side-car later.

import { makeDimensionCard } from "./shared.mjs";
import {
  LAND_ULURP_PHASES,
  buildLandPhaseView,
  mapMilestoneToPhase,
} from "../../site/land_phase_spine.mjs";
import { statutoryDeadlineForPhase } from "../../site/ulurp_statutory_clock.mjs";
import { EXAM_PROCESS_STAGES } from "../../site/exam_process_spine.mjs";

export const DIMENSION_ID = "ontology-coherence";

/**
 * Past-deadline grace days before a current statutory due is a violation.
 * Product-policy constant for audit only (not a Charter statute); 7 calendar
 * days absorbs clock-toll / timezone lag without masking multi-month stranding.
 * Source: product policy (audit tolerance), not Open Data.
 */
export const CURRENT_DEADLINE_PAST_TOLERANCE_DAYS = 7;

/**
 * Future-event grace days for actual (non-planned) rows.
 * Product-policy constant for audit only; about 13 months covers long planned
 * portal stub dates mislabeled as actual without treating near-term publisher
 * dates as impossible.
 * Source: product policy (audit tolerance), not Open Data.
 */
export const FUTURE_EVENT_PLAUSIBILITY_DAYS = 400;

/**
 * Shared rule registry — one place for land + exam (and future lenses).
 * Concurrent exam-lens fixes implement the product repair; this registry
 * keeps the audit shape unified so sampling does not fork per lens.
 */
export const COHERENCE_RULES = Object.freeze([
  Object.freeze({
    id: "current_stage_past_deadline",
    lenses: Object.freeze(["land"]),
    description:
      "A stage marked current whose statutory or expected deadline is in the past beyond tolerance.",
  }),
  Object.freeze({
    id: "current_while_later_completed",
    lenses: Object.freeze(["land", "pipeline"]),
    description:
      "A stage marked current while a later stage in the same pipeline has completed events.",
  }),
  Object.freeze({
    id: "completion_order_violation",
    lenses: Object.freeze(["land", "pipeline"]),
    description:
      "Completion timestamps that violate pipeline order (later stage completed before an earlier one).",
  }),
  Object.freeze({
    id: "future_dated_event",
    lenses: Object.freeze(["land", "exam", "pipeline"]),
    description:
      "Events dated in the future beyond source plausibility for actual (non-planned) rows.",
  }),
  Object.freeze({
    id: "exam_post_list_during_open_application",
    lenses: Object.freeze(["exam"]),
    description:
      "Post-list events (list establishment, certification, appointment) while the application window is still open.",
  }),
]);

export function coherenceRuleById(id) {
  return COHERENCE_RULES.find((r) => r.id === id) || null;
}

function isoDateOnly(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = isoDateOnly(a);
  const db = isoDateOnly(b);
  if (!da || !db) return null;
  const ms = Date.parse(`${db}T00:00:00Z`) - Date.parse(`${da}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86_400_000);
}

function eventIsPlanned(event) {
  if (event?.time?.certainty === "planned") return true;
  const status = String(event?.status || event?.detail || "").toLowerCase();
  return status.includes("not started");
}

function eventIsTerminalComplete(event) {
  if (event?._synthetic) return false;
  if (eventIsPlanned(event)) return false;
  // A disposition without a vote date is still useful hearing evidence, but
  // its hearing date is not evidence that the represented body's review was
  // complete. Keep it on the reader timeline without using it to order
  // lifecycle completions.
  if (event?.kind === "zap_disposition" && event?.time?.basis === "hearing_date") return false;
  const status = String(event?.status || event?.detail || "").toLowerCase();
  if (status.includes("not started")) return false;
  if (status.includes("in progress")) return false;
  return true;
}

function phasesHaveStrictCompletionOrder(earlier, later) {
  // ZAP publishes filing and CEQR as parallel, repeatedly re-filed workflows.
  // Their display order is useful navigation, not a completion dependency.
  return !(earlier === "pre_application" && later === "environmental");
}

function phaseIndex(phaseId, order) {
  return order.indexOf(phaseId);
}

function permalinkForLand(projectId) {
  return projectId ? `#land/${projectId}` : null;
}

function permalinkForExam(examNumber) {
  return examNumber ? `#exam/${examNumber}` : null;
}

/**
 * Audit one land/ZAP outcome payload (spine + optional statutory_clock).
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {string} [opts.today] YYYY-MM-DD
 * @returns {{ subject_ref: string, permalink: string|null, violations: object[] }}
 */
export function auditLandPayload(payload = {}, opts = {}) {
  const today = isoDateOnly(opts.today) || isoDateOnly(new Date().toISOString()) || "1970-01-01";
  const projectId =
    payload.project_id ||
    payload.open_data?.project_id ||
    payload.spine?.project_id ||
    "unknown";
  const subject_ref = `land:${projectId}`;
  const permalink = permalinkForLand(projectId);
  // Accumulator (not a measured table).
  const violations = Array();

  const spine = payload.spine || null;
  if (!spine || !Array.isArray(spine.events)) {
    return { subject_ref, permalink, violations, lens: "land" };
  }

  const view = buildLandPhaseView(spine, {
    open_data: payload.open_data || null,
    portal_url: payload.portal_url || null,
    public_status: payload.public_status || payload.open_data?.public_status || null,
    project_id: projectId,
  });

  const currentId = view.current?.phase_id || null;
  const curIdx = phaseIndex(currentId, LAND_ULURP_PHASES);

  // Rule: current while later completed
  if (currentId && curIdx >= 0) {
    for (let i = curIdx + 1; i < LAND_ULURP_PHASES.length; i++) {
      const laterId = LAND_ULURP_PHASES[i];
      const phase = view.phases.find((p) => p.id === laterId);
      const laterCompletes = (phase?.all_events || phase?.events || []).filter(
        eventIsTerminalComplete,
      );
      if (laterCompletes.length) {
        violations.push({
          rule_id: "current_while_later_completed",
          subject_ref,
          permalink,
          lens: "land",
          detail: {
            current_phase: currentId,
            later_phase: laterId,
            later_completion_count: laterCompletes.length,
            sample_title: laterCompletes[0]?.title || null,
            sample_date: isoDateOnly(laterCompletes[0]?.time?.value),
          },
        });
        break;
      }
    }
  }

  // Rule: current stage past statutory deadline
  // Skip when the clock or project is already terminal — a completed review
  // still carries historical due dates and must not read as an open overdue step.
  const clock = payload.statutory_clock || null;
  const pubStatus = String(payload.public_status || payload.open_data?.public_status || "").toLowerCase();
  const projectTerminal =
    (clock && (clock.status === "completed" || clock.status === "withdrawn"))
    || /\bcompleted\b|\bapproved\b|\bdisapproved\b|\bwithdrawn\b|\bterminated\b/.test(pubStatus);
  if (
    currentId
    && clock
    && clock.status !== "ineligible"
    && clock.status !== "withdrawn"
    && clock.status !== "completed"
    && !projectTerminal
  ) {
    const row = statutoryDeadlineForPhase(clock, currentId);
    const rowClosed = row && row.status && row.status !== "open";
    const due = isoDateOnly(row?.due_date);
    if (due && !rowClosed) {
      const lag = daysBetween(due, today);
      if (lag != null && lag > CURRENT_DEADLINE_PAST_TOLERANCE_DAYS) {
        violations.push({
          rule_id: "current_stage_past_deadline",
          subject_ref,
          permalink,
          lens: "land",
          detail: {
            current_phase: currentId,
            due_date: due,
            today,
            days_past: lag,
            tolerance_days: CURRENT_DEADLINE_PAST_TOLERANCE_DAYS,
          },
        });
      }
    }
  }

  // Rule: statutory clock still all-open after completed milestones / terminal status
  if (clock && clock.status !== "ineligible" && clock.status !== "withdrawn") {
    const phases = Array.isArray(clock.phases) ? clock.phases : [];
    const allOpen = phases.length > 0 && phases.every((p) => !p.status || p.status === "open");
    if (allOpen) {
      const pub = String(payload.public_status || payload.open_data?.public_status || "").toLowerCase();
      const projectDone = /\bcompleted\b|\bapproved\b|\bdisapproved\b/.test(pub);
      const completedMilestone = (payload.spine?.events || []).some((e) => {
        const title = String(e?.title || "").toLowerCase();
        const st = String(e?.status || e?.detail || "").toLowerCase();
        return /community board|borough president|city planning|city council|mayoral/.test(title)
          && /\bcompleted\b|\bapproved\b|\bsubmitted\b/.test(st);
      });
      if (projectDone || completedMilestone) {
        violations.push({
          rule_id: "statutory_clock_stale_open",
          subject_ref,
          permalink,
          lens: "land",
          detail: {
            clock_status: clock.status,
            public_status: payload.public_status || payload.open_data?.public_status || null,
            open_phase_count: phases.length,
            project_completed: projectDone,
            completed_milestone_signal: completedMilestone,
          },
        });
      }
    }
  }

  // Rule: completion order (later phase completed before earlier phase)
  const firstCompleteByPhase = new Map();
  for (const event of spine.events) {
    if (!eventIsTerminalComplete(event)) continue;
    const phaseId = mapMilestoneToPhase(event.title, {
      kind: event.kind,
      representing: event.detail,
      detail: event.detail,
    });
    const day = isoDateOnly(event.time?.value);
    if (!day) continue;
    const prev = firstCompleteByPhase.get(phaseId);
    if (!prev || day < prev) firstCompleteByPhase.set(phaseId, day);
  }
  for (let i = 0; i < LAND_ULURP_PHASES.length; i++) {
    for (let j = i + 1; j < LAND_ULURP_PHASES.length; j++) {
      const earlier = LAND_ULURP_PHASES[i];
      const later = LAND_ULURP_PHASES[j];
      if (!phasesHaveStrictCompletionOrder(earlier, later)) continue;
      const eDay = firstCompleteByPhase.get(earlier);
      const lDay = firstCompleteByPhase.get(later);
      if (eDay && lDay && lDay < eDay) {
        violations.push({
          rule_id: "completion_order_violation",
          subject_ref,
          permalink,
          lens: "land",
          detail: {
            earlier_phase: earlier,
            earlier_first_complete: eDay,
            later_phase: later,
            later_first_complete: lDay,
          },
        });
      }
    }
  }

  // Rule: actual events dated far in the future
  for (const event of spine.events) {
    if (eventIsPlanned(event) || event?._synthetic) continue;
    const day = isoDateOnly(event.time?.value);
    if (!day) continue;
    const ahead = daysBetween(today, day);
    if (ahead != null && ahead > FUTURE_EVENT_PLAUSIBILITY_DAYS) {
      violations.push({
        rule_id: "future_dated_event",
        subject_ref,
        permalink,
        lens: "land",
        detail: {
          title: event.title || null,
          date: day,
          today,
          days_ahead: ahead,
          plausibility_days: FUTURE_EVENT_PLAUSIBILITY_DAYS,
        },
      });
    }
  }

  return {
    subject_ref,
    permalink,
    lens: "land",
    current_phase: currentId,
    violations,
  };
}

/**
 * Audit one exam process spine / staffing row for the open-window vs post-list rule.
 * Product repair for exam cards may land separately; the rule shape lives here.
 *
 * @param {object} payload — { exam_number, application?: {status|open}, stages|spine }
 * @param {object} [opts]
 */
export function auditExamPayload(payload = {}, opts = {}) {
  const today = isoDateOnly(opts.today) || isoDateOnly(new Date().toISOString()) || "1970-01-01";
  const examNumber = payload.exam_number || payload.exam?.exam_number || "unknown";
  const subject_ref = `exam:${examNumber}`;
  const permalink = permalinkForExam(examNumber);
  // Accumulator (not a measured table).
  const violations = Array();

  const app = payload.application || payload.stages?.application || null;
  const appStatus = String(app?.status || payload.application_status || "").toLowerCase();
  const appOpen =
    appStatus === "open" ||
    app?.open === true ||
    (isoDateOnly(app?.to || app?.end || payload.application_end) &&
      daysBetween(today, isoDateOnly(app?.to || app?.end || payload.application_end)) >= 0 &&
      (!isoDateOnly(app?.from || app?.start || payload.application_start) ||
        daysBetween(isoDateOnly(app?.from || app?.start || payload.application_start), today) >= 0));

  const postListStages = EXAM_PROCESS_STAGES.filter((s) => s !== "application");
  const stageBag =
    payload.stages ||
    payload.spine?.stages ||
    (Array.isArray(payload.spine?.events)
      ? Object.fromEntries(
          payload.spine.events.map((e) => [e.stage || e.id, e]),
        )
      : {});

  if (appOpen) {
    for (const stage of postListStages) {
      const row = stageBag[stage];
      if (!row) continue;
      const hasEvent =
        row.status === "matched" ||
        row.state === "matched" ||
        row.matched === true ||
        (Array.isArray(row.events) && row.events.length > 0) ||
        row.date ||
        row.first ||
        row.list_count > 0 ||
        row.established_date;
      if (hasEvent) {
        violations.push({
          rule_id: "exam_post_list_during_open_application",
          subject_ref,
          permalink,
          lens: "exam",
          detail: {
            stage,
            application_status: app?.status || "open",
            sample: row.date || row.first || row.established_date || null,
          },
        });
      }
    }
  }

  // Future-dated actual exam events when present
  const events = Array.isArray(payload.spine?.events)
    ? payload.spine.events
    : Array.isArray(payload.events)
      ? payload.events
      : [];
  for (const event of events) {
    if (eventIsPlanned(event)) continue;
    const day = isoDateOnly(event.time?.value || event.date);
    if (!day) continue;
    const ahead = daysBetween(today, day);
    if (ahead != null && ahead > FUTURE_EVENT_PLAUSIBILITY_DAYS) {
      violations.push({
        rule_id: "future_dated_event",
        subject_ref,
        permalink,
        lens: "exam",
        detail: {
          title: event.title || event.stage || null,
          date: day,
          today,
          days_ahead: ahead,
          plausibility_days: FUTURE_EVENT_PLAUSIBILITY_DAYS,
        },
      });
    }
  }

  return { subject_ref, permalink, lens: "exam", violations };
}

/**
 * Run the full coherence census over a payload inventory.
 *
 * @param {object} inventory
 * @param {object[]} [inventory.land] land payloads
 * @param {object[]} [inventory.exam] exam payloads
 * @param {object} [opts]
 */
export function auditOntologyCoherence(inventory = {}, opts = {}) {
  const land = Array.isArray(inventory.land) ? inventory.land : Array();
  const exam = Array.isArray(inventory.exam) ? inventory.exam : Array();
  const today = isoDateOnly(opts.today) || inventory.today || null;

  // Accumulator (not a measured table).
  const reports = Array();
  for (const row of land) {
    reports.push(auditLandPayload(row, { today }));
  }
  for (const row of exam) {
    reports.push(auditExamPayload(row, { today }));
  }

  const violations = reports.flatMap((r) => r.violations || []);
  const by_rule = Object.fromEntries(COHERENCE_RULES.map((r) => [r.id, 0]));
  for (const v of violations) {
    if (by_rule[v.rule_id] == null) by_rule[v.rule_id] = 0;
    by_rule[v.rule_id] += 1;
  }

  // Land-class measures used in PR before/after:
  // - cards with current-stage deadline in the past (beyond tolerance)
  // - cards with later-stage completions after the pointed current stage
  const land_reports = reports.filter((r) => r.lens === "land");
  const land_past_deadline = land_reports.filter((r) =>
    (r.violations || []).some((v) => v.rule_id === "current_stage_past_deadline"),
  ).length;
  const land_later_completed = land_reports.filter((r) =>
    (r.violations || []).some((v) => v.rule_id === "current_while_later_completed"),
  ).length;

  return {
    schema: "cityscroll.ontology_coherence_census.v0",
    today: today || null,
    rules: COHERENCE_RULES.map((r) => ({ id: r.id, lenses: [...r.lenses], description: r.description })),
    checked: {
      land: land.length,
      exam: exam.length,
      total: land.length + exam.length,
    },
    violation_count: violations.length,
    by_rule,
    land_class: {
      past_deadline_current: land_past_deadline,
      later_completed_while_current: land_later_completed,
      cards_checked: land.length,
    },
    violations,
    reports,
  };
}

/**
 * Multi-flywheel evaluator: mint one card per distinct rule with open violations,
 * plus a census summary when anything fires.
 */
export function evaluateOntologyCoherence(input = {}) {
  const inventory = input.ontology_coherence || input.coherence_payloads || null;
  // Accumulator (not a measured table).
  const cards = Array();
  const emptyMetrics = {
    rules_registered: COHERENCE_RULES.length,
    payloads_checked: 0,
    violation_count: 0,
    by_rule: Object.fromEntries(COHERENCE_RULES.map((r) => [r.id, 0])),
    land_past_deadline_current: 0,
    land_later_completed_while_current: 0,
  };

  if (!inventory) {
    return { dimension: DIMENSION_ID, metrics: emptyMetrics, cards: [] };
  }

  const census = auditOntologyCoherence(inventory, {
    today: inventory.today || input.today || null,
  });

  const metrics = {
    rules_registered: COHERENCE_RULES.length,
    payloads_checked: census.checked.total,
    violation_count: census.violation_count,
    by_rule: census.by_rule,
    land_past_deadline_current: census.land_class.past_deadline_current,
    land_later_completed_while_current: census.land_class.later_completed_while_current,
  };

  // One card per rule that fired (avoids flooding the queue per subject).
  for (const rule of COHERENCE_RULES) {
    const hits = census.violations.filter((v) => v.rule_id === rule.id);
    if (!hits.length) continue;
    const sample = hits.slice(0, 8).map((v) => ({
      subject_ref: v.subject_ref,
      permalink: v.permalink,
      detail: v.detail,
    }));
    cards.push(
      makeDimensionCard({
        dimension: DIMENSION_ID,
        slug: `rule-${rule.id}`,
        title: `Resolve ontology coherence: ${rule.id.replace(/_/g, " ")}`,
        rank_score: rule.id === "current_while_later_completed" || rule.id === "current_stage_past_deadline"
          ? 93
          : 86,
        evidence: {
          kind: "ontology-coherence-violation",
          rule_id: rule.id,
          description: rule.description,
          hit_count: hits.length,
          sample,
          land_class: census.land_class,
        },
        verify:
          "node --test test/ontology_coherence.test.mjs test/land_phase_spine.test.mjs",
        demo_win:
          `Generated ${rule.lenses.join("/")} timelines no longer contradict themselves on ${rule.id}; sample cards: ${
            sample.map((s) => s.permalink || s.subject_ref).filter(Boolean).slice(0, 3).join(", ") || "n/a"
          }.`,
        context: [
          "ontology/dimensions/ontology_coherence.mjs",
          "site/land_phase_spine.mjs",
          "ontology/fixtures/dimensions/ontology_coherence_payloads.json",
        ],
        lesson_class: `ontology-coherence-${rule.id}`,
      }),
    );
  }

  return { dimension: DIMENSION_ID, metrics, cards, census };
}
