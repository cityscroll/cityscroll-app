/**
 * NYCIDA / Build NYC subsidy lifecycle — phase-group view model.
 *
 * Pure view model over assembleSubsidyLifecycle timeline entries: keep the five
 * ontology stages (application → hearing → board decision → closing →
 * compliance), derive current status + next action, and mark empty future stages
 * so the UI can collapse N verbose gap cards into one “not yet reached”
 * progress indicator (Money-collapse pattern from procurement lifecycle).
 *
 * Presentation shape matches site/procurement_phase_spine.mjs and
 * site/land_phase_spine.mjs: lead → stepper → current panel → history
 * disclosure. When a shared phase-timeline helper lands, migrate — do not fork
 * a second generic component.
 *
 * HTML lives in site/index.html subsidyLifecycleHTML / subsidyPhaseTimelineHTML.
 */

export const SUBSIDY_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered subsidy stages (one phase each — ontology-complete). */
export const SUBSIDY_PHASES = Object.freeze([
  "application",
  "hearing",
  "board_decision",
  "closing",
  "compliance",
]);

export const SUBSIDY_PHASE_META = Object.freeze({
  application: {
    id: "application",
    short: "Apply",
    label_key: "subsidy_stage_application",
    action_key: "subsidy_phase_action_application",
  },
  hearing: {
    id: "hearing",
    short: "Hearing",
    label_key: "subsidy_stage_hearing",
    action_key: "subsidy_phase_action_hearing",
  },
  board_decision: {
    id: "board_decision",
    short: "Board",
    label_key: "subsidy_stage_board_decision",
    action_key: "subsidy_phase_action_board",
  },
  closing: {
    id: "closing",
    short: "Close",
    label_key: "subsidy_stage_closing",
    action_key: "subsidy_phase_action_closing",
  },
  compliance: {
    id: "compliance",
    short: "Comply",
    label_key: "subsidy_stage_compliance",
    action_key: "subsidy_phase_action_compliance",
  },
});

/** Stage order index (matches worker STAGES). */
export const STAGE_ORDER = Object.freeze({
  application: 0,
  hearing: 1,
  board_decision: 2,
  closing: 3,
  compliance: 4,
});

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDate(value) {
  if (value == null || value === "") return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Map a subsidy stage id to a phase id (1:1 with ontology stages).
 * @param {string|null|undefined} stage
 * @returns {string}
 */
export function mapStageToPhase(stage) {
  const id = clean(stage);
  if (id && STAGE_ORDER[id] != null) return id;
  return "application";
}

/**
 * Public status for a timeline entry.
 * Later matched stages mark earlier unmatched as "passed".
 * @param {object|null} entry
 * @param {object[]} timeline
 */
export function publicStatus(entry, timeline) {
  if (!entry) return "unmatched";
  if (entry.status === "not_applicable") return "not_applicable";
  if (entry.status === "matched" || entry.status === "ambiguous" || entry.status === "passed") {
    return entry.status;
  }
  const order = STAGE_ORDER[entry.stage];
  if (order != null) {
    const laterMatched = (timeline || []).some(
      (e) =>
        e &&
        e.status === "matched" &&
        (STAGE_ORDER[e.stage] ?? -1) > order,
    );
    if (laterMatched) return "passed";
  }
  if (entry.status === "unknown" || entry.status === "unmatched") return "unmatched";
  return entry.status || "unmatched";
}

/**
 * Last matched stage key (or data.stage) — reader "current" step.
 * @param {object[]} timeline
 * @param {string|null|undefined} dataStage
 */
export function currentStageKey(timeline, dataStage) {
  const raw = timeline || [];
  for (const e of raw) {
    if (publicStatus(e, raw) === "ambiguous") return e.stage;
  }
  let lastMatched = null;
  for (const e of raw) {
    if (publicStatus(e, raw) === "matched") lastMatched = e.stage;
  }
  if (lastMatched) return lastMatched;
  const hinted = clean(dataStage);
  if (hinted && STAGE_ORDER[hinted] != null) return hinted;
  return raw[0]?.stage || "application";
}

/**
 * Milestone title for display (not i18n — presentation labels stages).
 * @param {object} entry
 */
function milestoneTitle(entry) {
  if (entry?.official_action) {
    return String(entry.official_action).replace(/_/g, " ");
  }
  if (entry?.outcome && entry.outcome !== "unknown") {
    return String(entry.outcome).replace(/_/g, " ");
  }
  if (entry?.detail?.company) return clean(entry.detail.company) || entry.stage;
  return entry?.stage || "—";
}

/**
 * Build phase-grouped subsidy lifecycle view model.
 *
 * @param {object|null|undefined} data - assembleSubsidyLifecycle payload
 * @param {object} [opts]
 * @param {object|null} [opts.notice]
 */
export function buildSubsidyPhaseView(data, opts = {}) {
  const raw = Array.isArray(data?.timeline) ? data.timeline.slice() : [];
  // Ensure every ontology stage appears so the stepper stays complete even when
  // the payload only stamps matched rows.
  const byStage = Object.fromEntries(SUBSIDY_PHASES.map((id) => [id, null]));
  for (const entry of raw) {
    if (!entry || !entry.stage) continue;
    const id = mapStageToPhase(entry.stage);
    if (byStage[id] == null) byStage[id] = entry;
  }
  // Synthetic unmatched placeholders for missing stages (ontology-complete).
  for (const id of SUBSIDY_PHASES) {
    if (!byStage[id]) {
      byStage[id] = {
        stage: id,
        status: "unmatched",
        date: null,
        official_action: null,
        outcome: null,
        source: null,
        detail: null,
        gap_kind: null,
        _synthetic: true,
      };
    }
  }

  const timeline = SUBSIDY_PHASES.map((id) => byStage[id]);
  const stageKey = currentStageKey(raw.length ? raw : timeline, data?.stage);
  let currentPhaseId = mapStageToPhase(stageKey);
  const curIdx = SUBSIDY_PHASES.indexOf(currentPhaseId);
  if (curIdx < 0) currentPhaseId = "application";

  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = SUBSIDY_PHASES.indexOf(id);
    const entry = byStage[id];
    const pub = publicStatus(entry, timeline);
    if (idx < SUBSIDY_PHASES.indexOf(currentPhaseId)) return "passed";
    if (pub === "matched" || pub === "passed" || pub === "ambiguous") return "passed";
    return "future";
  }

  const phases = SUBSIDY_PHASES.map((id) => {
    const state = phaseState(id);
    const entry = byStage[id];
    const pub = publicStatus(entry, timeline);
    const material =
      pub === "matched" ||
      pub === "ambiguous" ||
      (pub === "passed" && entry && !entry._synthetic);

    // Future empty stages: stepper chips only — never detail milestones.
    // Current/passed: material only (matched / ambiguous / passed notes).
    let milestones = [];
    if (state === "future") {
      if (pub === "matched" || pub === "ambiguous") {
        milestones = [
          {
            stage: entry.stage,
            status: entry.status,
            public_status: pub,
            date: entry.date || null,
            title: milestoneTitle(entry),
            entry,
          },
        ];
      }
    } else if (material) {
      milestones = [
        {
          stage: entry.stage,
          status: entry.status,
          public_status: pub,
          date: entry.date || null,
          title: milestoneTitle(entry),
          entry,
        },
      ];
    }

    const dates = milestones
      .map((m) => isoDate(m.date))
      .filter(Boolean)
      .sort();

    return {
      id,
      short: SUBSIDY_PHASE_META[id].short,
      label_key: SUBSIDY_PHASE_META[id].label_key,
      action_key: SUBSIDY_PHASE_META[id].action_key,
      state,
      event_count: milestones.length,
      total_count: 1,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      milestones,
      all_milestones: [
        {
          stage: entry.stage,
          status: entry.status,
          public_status: pub,
          date: entry.date || null,
          title: milestoneTitle(entry),
          entry,
        },
      ],
      entry,
      public_status: pub,
      gap_kind: entry.gap_kind || null,
    };
  });

  const futurePhases = phases.filter((p) => p.state === "future");
  const futureEmpty = futurePhases.filter((p) => !p.event_count);

  let nextPhase = null;
  const curI = SUBSIDY_PHASES.indexOf(currentPhaseId);
  for (let i = curI + 1; i < phases.length; i++) {
    if (phases[i].state === "future") {
      nextPhase = phases[i];
      break;
    }
  }

  const currentEntry = byStage[currentPhaseId];
  const currentMilestone = currentEntry && publicStatus(currentEntry, timeline) === "matched"
    ? currentEntry
    : raw.find((e) => e && e.stage === stageKey) || currentEntry;

  return {
    schema_version: SUBSIDY_PHASE_SPINE_SCHEMA_VERSION,
    current: {
      phase_id: currentPhaseId,
      label_key: SUBSIDY_PHASE_META[currentPhaseId]?.label_key || "subsidy_stage_application",
      action_key: SUBSIDY_PHASE_META[currentPhaseId]?.action_key || "subsidy_phase_action_application",
      stage: currentPhaseId,
      milestone_label: currentMilestone ? milestoneTitle(currentMilestone) : null,
      since: currentMilestone ? isoDate(currentMilestone.date) : null,
      entry: currentMilestone,
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
        }
      : null,
    phases,
    chronological: timeline,
    event_count: raw.filter((e) => e && e.status === "matched").length,
    future_empty_phase_ids: futureEmpty.map((p) => p.id),
    future_empty_count: futureEmpty.length,
    join: data?.join || null,
    stage: data?.stage || currentPhaseId,
    project: data?.project || null,
    company: data?.company || null,
  };
}
