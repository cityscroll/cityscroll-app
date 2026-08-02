/**
 * Civil-service exam process spine — exam → eligible list → appointment.
 *
 * Reconstructs one multi-stage timeline per exam_number from precomputed
 * staffing fields (application window, Civil Service List aggregates, DCAS
 * annual outcome counts). Pure: no fetch, no env.
 *
 * Not the static career-guide steps or the post-cycle metrics grid alone —
 * those teach or summarize; this is the process chain for one exam.
 *
 * Gap honesty (hard):
 * - Aggregate empty stages use class-(a) `not_yet_ingested` naming public sources.
 * - Never re-label aggregate empties as class-(b) "city does not publish".
 * - Individual scores remain class-(b) elsewhere (exam-outcome-individual); not on this spine.
 */

export const EXAM_PROCESS_SPINE_SCHEMA_VERSION = 1;

/** Ordered process stages for one civil-service exam hiring path. */
export const EXAM_PROCESS_STAGES = Object.freeze([
  "application",
  "list_establishment",
  "certification",
  "appointment",
]);

export const STAGE_APPLICATION = "application";
export const STAGE_LIST_ESTABLISHMENT = "list_establishment";
export const STAGE_CERTIFICATION = "certification";
export const STAGE_APPOINTMENT = "appointment";

const SOURCE_SCHEDULE = {
  id: "dcas-exam-schedule",
  label: "DCAS exam schedule / Notice of Examination",
};

const SOURCE_LIST = {
  id: "dcas-active-civil-service-list",
  label: "Civil Service List open data",
  url: "https://data.cityofnewyork.us/d/vx8i-nprf",
};

const SOURCE_OUTCOMES = {
  id: "dcas-annual-exam-outcomes",
  label: "DCAS annual civil-service exam outcomes publication",
};

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isoDate(value) {
  const s = clean(value);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}

function positiveCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dayTime(value, { basis = "publication_date", certainty = "actual" } = {}) {
  const day = isoDate(value);
  if (!day) return null;
  return {
    value: day,
    precision: "day",
    basis,
    certainty,
  };
}

function windowTime(start, end) {
  const from = isoDate(start);
  const to = isoDate(end);
  if (!from && !to) return null;
  if (from && to) {
    return {
      value: from,
      value_to: to,
      precision: "day",
      basis: "application_window",
      certainty: "planned",
    };
  }
  return dayTime(from || to, { basis: "application_window", certainty: "planned" });
}

function gapForStage(stage, sourceLabel) {
  return {
    slot: stage,
    class: "not_yet_ingested",
    taxonomy: true,
    source: sourceLabel,
  };
}

/**
 * Build one exam→list→appointment spine from a staffing exam row.
 * Empty post-cycle stages stay class-(a) not_yet_ingested — never invent events
 * and never claim the city withheld aggregate sources that exist publicly.
 *
 * @param {object} exam - row from site/data/staffing_exams.json
 * @param {object} [options]
 * @param {string} [options.today] - YYYY-MM-DD for application status wording
 */
export function buildExamProcessSpine(exam = {}, options = {}) {
  const examNumber = clean(exam?.exam_number);
  const title = clean(exam?.title) || null;
  const outcome = exam?.outcome && typeof exam.outcome === "object" ? exam.outcome : null;
  const list =
    exam?.list_aggregate && typeof exam.list_aggregate === "object"
      ? exam.list_aggregate
      : null;

  const events = [];
  const stagePayload = Object.fromEntries(
    EXAM_PROCESS_STAGES.map((kind) => [kind, { matched: false, events: [], detail: null }]),
  );

  // --- application window (schedule / NOE) ---
  const appStart = isoDate(exam?.application_start);
  const appEnd = isoDate(exam?.application_end);
  const appTime = windowTime(appStart, appEnd);
  if (appTime) {
    const event = {
      id: `exam:${examNumber || "unknown"}:application`,
      kind: "exam_application",
      stage: STAGE_APPLICATION,
      title: title ? `Application window — ${title}` : "Application window",
      detail: exam?.notice_url ? "Notice of Examination" : "DCAS exam schedule",
      status: "published",
      exam_number: examNumber || null,
      count: null,
      time: appTime,
      source: {
        ...SOURCE_SCHEDULE,
        url: exam?.notice_url || null,
      },
    };
    events.push(event);
    stagePayload[STAGE_APPLICATION] = {
      matched: true,
      events: [event],
      detail: {
        application_start: appStart,
        application_end: appEnd,
        notice_url: exam?.notice_url || null,
        schedule_status: exam?.schedule_status || null,
      },
    };
  }

  // --- eligible list ---
  const listCountFromOutcome = outcome ? positiveCount(outcome.list_establishment) : 0;
  const listCountFromList = list ? positiveCount(list.list_count) : 0;
  const listCount = listCountFromOutcome || listCountFromList;
  const listDate =
    dayTime(list?.established_date, { basis: "list_established_date", certainty: "actual" })
    || dayTime(outcome?.published_on, { basis: "publication_date", certainty: "actual" });
  if (listCount > 0) {
    const fromListFeed = listCountFromList > 0 && !listCountFromOutcome;
    const event = {
      id: `exam:${examNumber || "unknown"}:list_establishment`,
      kind: "exam_list_establishment",
      stage: STAGE_LIST_ESTABLISHMENT,
      title: title ? `Eligible list — ${title}` : "Eligible list established",
      detail: fromListFeed ? "Civil Service List aggregate" : "DCAS annual outcomes",
      status: "published",
      exam_number: examNumber || null,
      count: listCount,
      time: listDate,
      source: fromListFeed ? SOURCE_LIST : SOURCE_OUTCOMES,
    };
    events.push(event);
    stagePayload[STAGE_LIST_ESTABLISHMENT] = {
      matched: true,
      events: [event],
      detail: {
        list_count: listCount,
        established_date: list?.established_date || null,
        extension_date: list?.extension_date || null,
        from_outcomes: listCountFromOutcome > 0,
        from_list_feed: listCountFromList > 0,
      },
    };
  }

  // --- agency certification (annual outcomes only) ---
  const certCount = outcome ? positiveCount(outcome.certification_count) : 0;
  if (certCount > 0) {
    const event = {
      id: `exam:${examNumber || "unknown"}:certification`,
      kind: "exam_certification",
      stage: STAGE_CERTIFICATION,
      title: title ? `Agency certification — ${title}` : "Agency certification",
      detail: "DCAS annual outcomes",
      status: "published",
      exam_number: examNumber || null,
      count: certCount,
      time: dayTime(outcome.published_on, { basis: "publication_date", certainty: "actual" }),
      source: SOURCE_OUTCOMES,
    };
    events.push(event);
    stagePayload[STAGE_CERTIFICATION] = {
      matched: true,
      events: [event],
      detail: {
        certification_count: certCount,
        application_cycle: outcome.application_cycle || null,
        published_on: outcome.published_on || null,
      },
    };
  }

  // --- appointment / hire (annual outcomes only) ---
  const appointmentCount = outcome
    ? (positiveCount(outcome.appointment_count) || positiveCount(outcome.hire_count))
    : 0;
  if (appointmentCount > 0) {
    const event = {
      id: `exam:${examNumber || "unknown"}:appointment`,
      kind: "exam_appointment",
      stage: STAGE_APPOINTMENT,
      title: title ? `Appointments — ${title}` : "Appointments",
      detail: "DCAS annual outcomes",
      status: "published",
      exam_number: examNumber || null,
      count: appointmentCount,
      time: dayTime(outcome.published_on, { basis: "publication_date", certainty: "actual" }),
      source: SOURCE_OUTCOMES,
    };
    events.push(event);
    stagePayload[STAGE_APPOINTMENT] = {
      matched: true,
      events: [event],
      detail: {
        appointment_count: positiveCount(outcome.appointment_count) || null,
        hire_count: positiveCount(outcome.hire_count) || null,
        applicant_count: positiveCount(outcome.applicant_count) || null,
        application_cycle: outcome.application_cycle || null,
        published_on: outcome.published_on || null,
      },
    };
  }

  events.sort((a, b) => {
    const ta = a.time?.value || "";
    const tb = b.time?.value || "";
    return ta.localeCompare(tb) || a.id.localeCompare(b.id);
  });

  const stages = EXAM_PROCESS_STAGES.map((kind) => {
    const payload = stagePayload[kind];
    return {
      kind,
      matched: Boolean(payload.matched),
      count: payload.events[0]?.count ?? null,
      events: payload.events,
      detail: payload.detail,
    };
  });

  const gapSource = {
    [STAGE_APPLICATION]: SOURCE_SCHEDULE.label,
    [STAGE_LIST_ESTABLISHMENT]: SOURCE_LIST.label,
    [STAGE_CERTIFICATION]: SOURCE_OUTCOMES.label,
    [STAGE_APPOINTMENT]: SOURCE_OUTCOMES.label,
  };
  const gaps = stages
    .filter((s) => !s.matched)
    .map((s) => gapForStage(s.kind, gapSource[s.kind] || SOURCE_OUTCOMES.label));

  // Never surface a false class-(b) for aggregate slots on this spine.
  for (const g of gaps) {
    if (g.class === "not_published") g.class = "not_yet_ingested";
  }

  const matchedCount = stages.filter((s) => s.matched).length;
  const joinMethod = outcome
    ? "exam_number_outcomes"
    : listCountFromList > 0
      ? "exam_number_list_aggregate"
      : appStart || appEnd
        ? "exam_number_schedule"
        : null;

  return {
    schema_version: EXAM_PROCESS_SPINE_SCHEMA_VERSION,
    subject_ref: examNumber ? `exam:${examNumber}` : null,
    exam_number: examNumber || null,
    title,
    join: {
      matched: Boolean(examNumber),
      method: joinMethod,
      exam_number: examNumber || null,
      has_outcome: Boolean(outcome),
      has_list_aggregate: listCountFromList > 0,
    },
    stages,
    events,
    gaps,
    stage_fill: stages.length ? matchedCount / stages.length : 0,
    matched_stages: matchedCount,
    total_stages: stages.length,
    full: matchedCount === stages.length,
    // Carry through for UI: never treat outcome_gap class b as spine truth.
    outcome_gap: exam?.outcome_gap
      ? {
          ...exam.outcome_gap,
          class:
            exam.outcome_gap.class === "not_published"
              ? "not_yet_ingested"
              : exam.outcome_gap.class || "not_yet_ingested",
        }
      : null,
    today: options.today || null,
  };
}

/**
 * Build spines for every exam in a staffing artifact (or exam array).
 */
export function buildExamProcessSpines(exams = [], options = {}) {
  const list = Array.isArray(exams) ? exams : [];
  return list
    .filter((exam) => exam && clean(exam.exam_number))
    .map((exam) => buildExamProcessSpine(exam, options))
    .sort((a, b) => String(a.exam_number).localeCompare(String(b.exam_number)));
}

/**
 * Find the spine for an exam number.
 */
export function spineForExam(spines, examNumber) {
  const id = clean(examNumber);
  if (!id) return null;
  return (spines || []).find((spine) => clean(spine.exam_number) === id) || null;
}

/**
 * Named product metric: exam_process_spine_completeness_rate
 * Mean stage_fill over spines for exams that have at least an application window
 * or a post-cycle observation.
 */
export function measureExamProcessSpineCompleteness(spines = []) {
  const pool = (spines || []).filter(
    (s) => s && (s.events?.length || s.join?.exam_number),
  );
  if (!pool.length) {
    return {
      metric: "exam_process_spine_completeness_rate",
      exam_process_spine_completeness_rate: 0,
      full_spine_rate: 0,
      spine_count: 0,
      post_list_spine_count: 0,
      stage_rates: Object.fromEntries(EXAM_PROCESS_STAGES.map((s) => [s, 0])),
    };
  }
  const stageHits = Object.fromEntries(EXAM_PROCESS_STAGES.map((s) => [s, 0]));
  let fillSum = 0;
  let full = 0;
  let postList = 0;
  for (const spine of pool) {
    fillSum += Number(spine.stage_fill) || 0;
    if (spine.full) full += 1;
    const listOrLater = (spine.stages || []).some(
      (st) =>
        st.matched
        && (st.kind === STAGE_LIST_ESTABLISHMENT
          || st.kind === STAGE_CERTIFICATION
          || st.kind === STAGE_APPOINTMENT),
    );
    if (listOrLater) postList += 1;
    for (const stage of spine.stages || []) {
      if (stage.matched) stageHits[stage.kind] = (stageHits[stage.kind] || 0) + 1;
    }
  }
  const n = pool.length;
  return {
    metric: "exam_process_spine_completeness_rate",
    exam_process_spine_completeness_rate: fillSum / n,
    full_spine_rate: full / n,
    spine_count: n,
    post_list_spine_count: postList,
    stage_rates: Object.fromEntries(
      EXAM_PROCESS_STAGES.map((s) => [s, stageHits[s] / n]),
    ),
  };
}

/**
 * Attach process spines onto a staffing artifact (shallow copy).
 */
export function attachExamProcessSpines(artifact, options = {}) {
  const exams = Array.isArray(artifact?.exams) ? artifact.exams : [];
  const spines = buildExamProcessSpines(exams, options);
  const byNumber = new Map(spines.map((s) => [s.exam_number, s]));
  const stamped = exams.map((exam) => {
    const spine = byNumber.get(clean(exam.exam_number)) || buildExamProcessSpine(exam, options);
    return {
      ...exam,
      process_spine: spine,
    };
  });
  return {
    ...artifact,
    exams: stamped,
    exam_process_spines: spines,
    exam_process_metrics: measureExamProcessSpineCompleteness(spines),
  };
}
