/**
 * Pure cycle-context model for DOF tax-lien sale list progression.
 *
 * Consumes precomputed site/data/tax_lien_sale_{summary,bbl}.json — no live
 * SODA. Inline this on notices/cards whose parcels appear on a published list;
 * the standalone aggregate panel is archive-only (deep link), not a lens dest.
 */

export const TAX_LIEN_STAGES = [
  "notice_90",
  "notice_60",
  "notice_30",
  "notice_10",
  "sold",
];

export const TAX_LIEN_STAGE_SHORT = {
  notice_90: "90-day",
  notice_60: "60-day",
  notice_30: "30-day",
  notice_10: "10-day",
  sold: "Final sale",
};

/** Closing-soon window for exemption / payment-plan deadlines (event time). */
export const TAX_LIEN_CLOSING_SOON_DAYS = 14;

/**
 * @param {string|null|undefined} value
 * @returns {string|null} YYYY-MM-DD
 */
export function isoDay(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Civic-date day delta (today − day uses calendar days, noon-safe).
 * @param {string|null} day YYYY-MM-DD
 * @param {string|Date|null} [today]
 * @returns {number|null}
 */
export function daysUntil(day, today = null) {
  const d = isoDay(day);
  if (!d) return null;
  const end = Date.parse(`${d}T12:00:00`);
  if (!Number.isFinite(end)) return null;
  let start;
  if (today instanceof Date) {
    start = today.getTime();
  } else if (typeof today === "string" && isoDay(today)) {
    start = Date.parse(`${isoDay(today)}T12:00:00`);
  } else {
    const now = new Date();
    start = Date.parse(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T12:00:00`,
    );
  }
  if (!Number.isFinite(start)) return null;
  return Math.ceil((end - start) / 86_400_000);
}

/**
 * @param {string|null} day
 * @param {string|Date|null} [today]
 * @returns {{ state: 'open'|'closing-soon'|'closed'|'none', days_left: number|null, event_at: string|null }}
 */
export function deadlineState(day, today = null) {
  const event_at = isoDay(day);
  const days_left = daysUntil(event_at, today);
  if (event_at == null || days_left == null) {
    return { state: "none", days_left: null, event_at };
  }
  if (days_left < 0) return { state: "closed", days_left, event_at };
  if (days_left <= TAX_LIEN_CLOSING_SOON_DAYS) {
    return { state: "closing-soon", days_left, event_at };
  }
  return { state: "open", days_left, event_at };
}

/**
 * Decode a compact BBL row from tax_lien_sale_bbl.json.
 * @param {object|null} lookup
 * @param {string} bbl
 */
export function decodeTaxLienBbl(lookup, bbl) {
  const key = String(bbl || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(key)) return null;
  const raw = lookup?.rows?.[key];
  if (!raw) return null;
  const keys = lookup.field_order || [];
  return { bbl: key, ...Object.fromEntries(keys.map((k, i) => [k, raw[i]])) };
}

/**
 * Stage index in the 90→60→30→10→final ladder (sold = last).
 * @param {string|null} stage
 */
export function stageIndex(stage) {
  const i = TAX_LIEN_STAGES.indexOf(stage);
  return i >= 0 ? i : 0;
}

/**
 * Stepper chips for the ladder with the observed stage highlighted.
 * @param {string} currentStage
 */
export function buildTaxLienStepper(currentStage) {
  const cur = stageIndex(currentStage);
  return TAX_LIEN_STAGES.map((id, index) => {
    let status = "todo";
    if (index < cur) status = "done";
    else if (index === cur) status = "current";
    return {
      id,
      short: TAX_LIEN_STAGE_SHORT[id] || id,
      status,
      current: index === cur,
    };
  });
}

/**
 * Resident actions, kept in the order a household can use them.
 * Missing source links produce no step; the UI never invents a destination.
 * @param {object|null} channels
 */
export function buildTaxLienResidentChecklist(channels) {
  if (!channels) return [];
  return [
    { id: "exemptions", url: channels.exemption_url || null },
    { id: "payment_plans", url: channels.payment_plan_url || null },
    { id: "official_guide", url: channels.lien_sale_help_url || null },
  ].filter((step) => step.url);
}

/**
 * Shared cycle guide for notice detail and the archive surface.
 * @param {object|null} summary
 * @param {string} stage
 * @param {string|Date|null} today
 */
export function buildTaxLienCycleGuide(summary, stage = "sold", today = null) {
  if (!summary) return null;
  const actionDeadline = isoDay(summary.schedule?.action_deadline);
  const saleDate = isoDay(summary.schedule?.sale_date);
  const deadline = deadlineState(actionDeadline, today);
  const saleState = deadlineState(saleDate, today);
  const publishedStatus = summary.latest_cycle?.status || null;
  const cycleStatus = publishedStatus === "expired" || saleState.state === "closed"
    ? "expired"
    : publishedStatus;
  const actionChannels = summary.action_channels
    ? {
      exemption_url: summary.action_channels.exemption_url || null,
      payment_plan_url: summary.action_channels.payment_plan_url || null,
      lien_sale_help_url: summary.action_channels.lien_sale_help_url || null,
      phone: summary.action_channels.phone || "311",
    }
    : null;
  return {
    stepper: buildTaxLienStepper(stage),
    deadline: {
      action_deadline: actionDeadline,
      sale_date: saleDate,
      ...deadline,
      cycle_status: cycleStatus,
      // Never present a countdown after the announced cycle ended.
      live: cycleStatus !== "expired"
        && (deadline.state === "open" || deadline.state === "closing-soon"),
    },
    action_channels: actionChannels,
    resident_checklist: buildTaxLienResidentChecklist(actionChannels),
  };
}

/**
 * Cohort leave-before-sale rate for a stage (citywide training), 0–1.
 * @param {object|null} summary
 * @param {string} stage
 */
export function leaveRateForStage(summary, stage) {
  const key = stage === "sold" ? "notice_10" : stage;
  const cell = summary?.training?.citywide?.[key];
  if (!cell || cell.probability_leave_before_sale == null) return null;
  return Number(cell.probability_leave_before_sale);
}

/**
 * Attributed historical outcome line (house prediction style).
 * Rate is rounded percent; never invents when training is thin.
 * @param {object} opts
 * @param {number|null} opts.leaveRate 0–1
 * @param {number|null} opts.cycleCount
 * @param {string} [opts.stage]
 */
export function taxLienHistoricalContextLine({ leaveRate, cycleCount, stage = "notice_90" }) {
  if (leaveRate == null || cycleCount == null || cycleCount < 1) return null;
  const p = Math.round(Number(leaveRate) * 100);
  const stageWord =
    stage === "notice_90" ? "90-day list"
      : stage === "notice_60" ? "60-day list"
        : stage === "notice_30" ? "30-day list"
          : stage === "notice_10" ? "10-day list"
            : "list";
  return `Properties on the ${stageWord} historically left before sale ${p}% of the time — exemption and payment-plan deadlines are the lever. Based on ${cycleCount} prior cycles.`;
}

/**
 * Collect 10-digit BBLs from a notice-ish row or location stamp.
 * @param {object|null} notice
 * @param {object|null} [location] property_location shape
 * @returns {string[]}
 */
export function noticeParcelBbls(notice, location = null) {
  const out = [];
  const push = (v) => {
    const b = String(v || "").replace(/\D/g, "");
    if (/^\d{10}$/.test(b) && !out.includes(b)) out.push(b);
  };
  if (notice?._property_bbl) push(notice._property_bbl);
  const loc = location || notice?.property_location || null;
  if (loc) {
    for (const b of loc.bbls || []) push(b);
    for (const a of loc.addresses || []) if (a?.bbl) push(a.bbl);
    for (const t of loc.tax_lots || []) if (t?.bbl) push(t.bbl);
  }
  // Bare body fields some workers stamp.
  if (notice?.bbl) push(notice.bbl);
  if (Array.isArray(notice?.bbls)) for (const b of notice.bbls) push(b);
  return out;
}

/**
 * Build the full cycle-context object for one notice (or one BBL).
 * Prefer the notice's own parcels; only report BBLs that appear in the lookup.
 *
 * @param {object} opts
 * @param {object|null} opts.summary tax_lien_sale_summary.json
 * @param {object|null} opts.lookup tax_lien_sale_bbl.json
 * @param {object|null} [opts.notice]
 * @param {object|null} [opts.location]
 * @param {string|null} [opts.bbl] single BBL override (list card)
 * @param {string|Date|null} [opts.today]
 */
export function buildTaxLienCycleContext({
  summary,
  lookup,
  notice = null,
  location = null,
  bbl = null,
  today = null,
} = {}) {
  if (!summary) return null;

  const parcelBbls = bbl
    ? [String(bbl).replace(/\D/g, "")].filter((x) => /^\d{10}$/.test(x))
    : noticeParcelBbls(notice, location);

  const listed = [];
  for (const id of parcelBbls) {
    const row = decodeTaxLienBbl(lookup, id);
    if (row) listed.push(row);
  }
  if (!listed.length) return null;

  // Primary = furthest along the ladder (most advanced stage), else first parcel.
  const primary = listed.slice().sort((a, b) => stageIndex(b.stage) - stageIndex(a.stage))[0];
  const stage = primary.stage || "notice_90";
  // House headline always cites the 90-day citywide leave rate (~87%) — the
  // lever is the same at every stage; stage-specific rates stay in the model.
  const leaveRate = leaveRateForStage(summary, "notice_90");
  const cycleCount = summary.training?.cycle_count ?? null;
  const guide = buildTaxLienCycleGuide(summary, stage, today);
  const historical_line = taxLienHistoricalContextLine({
    leaveRate,
    cycleCount,
    stage: "notice_90",
  });

  return {
    class_id: "tax_lien",
    schema_version: 1,
    subject_ref: `property-bbl:${primary.bbl}`,
    bbl: primary.bbl,
    parcels: listed.map((row) => ({
      bbl: row.bbl,
      stage: row.stage,
      outcome: row.outcome,
      borough_code: row.borough_code,
      nta_name: row.nta_name || null,
    })),
    stage,
    outcome: primary.outcome || null,
    stepper: guide.stepper,
    historical_context: historical_line
      ? {
        leave_rate: leaveRate,
        leave_pct: leaveRate == null ? null : Math.round(leaveRate * 100),
        cycle_count: cycleCount,
        stage,
        line: historical_line,
        attribution: cycleCount != null ? `Evidence: ${cycleCount} prior cycles` : null,
      }
      : null,
    deadline: guide.deadline,
    action_channels: guide.action_channels,
    resident_checklist: guide.resident_checklist,
    data_vintage: isoDay(summary.latest_cycle?.data_vintage),
    public_projection: summary.public_projection || "cohort_statistic_only",
  };
}

/**
 * Shared property cycle-context envelope used by tax-lien and disposition.
 * Keeps one shape for "position + historical context + deadline + next action".
 *
 * @param {object} partial
 */
export function propertyCycleContextEnvelope(partial = {}) {
  return {
    class_id: partial.class_id || null,
    schema_version: partial.schema_version || 1,
    position: partial.position || null, // { stages, current_id }
    historical_context: partial.historical_context || null,
    deadline: partial.deadline || null,
    next_action: partial.next_action || null,
    subject_ref: partial.subject_ref || null,
    survey_status: partial.survey_status || "implemented", // implemented | carded
  };
}

/**
 * Disposition class: fold phase view + attributed timing line into the shared envelope.
 * Historical context only when the timing model provides an attributed line.
 *
 * @param {object|null} phaseView from buildPropertyPhaseView (+ optional timing attach)
 * @param {object} [opts]
 */
export function buildDispositionCycleContext(phaseView, opts = {}) {
  if (!phaseView || !Array.isArray(phaseView.phases) || !phaseView.phases.length) {
    return null;
  }
  const stages = phaseView.phases.map((p) => ({
    id: p.id,
    short: p.short || p.id,
    matched: Boolean(p.matched),
    current: phaseView.current && phaseView.current.id === p.id,
    status: p.matched
      ? (phaseView.current && phaseView.current.id === p.id ? "current" : "done")
      : "todo",
  }));
  // Field name disposition_timing_estimate is the existing product stamp; read-only here.
  const timingStamp = phaseView.disposition_timing_estimate || null;
  const historical = timingStamp && timingStamp.pattern_line
    ? {
      kind: timingStamp.kind || "cohort_statistic",
      line: timingStamp.pattern_line,
      n: timingStamp.n ?? null,
      since_year: timingStamp.since_year || null,
      public_projection: timingStamp.public_projection || "cohort_statistic_only",
      attribution: timingStamp.n != null
        ? `Evidence: ${timingStamp.n} prior dispositions`
        : null,
    }
    : null;
  const cur = phaseView.current;
  const nextAction = cur
    ? {
      phase_id: cur.id,
      action_key: cur.action_key || null,
    }
    : null;

  return propertyCycleContextEnvelope({
    class_id: "property_disposition",
    subject_ref: opts.subject_ref || null,
    position: {
      stages,
      current_id: cur?.id || null,
      next_id: phaseView.next?.id || null,
    },
    historical_context: historical,
    deadline: null, // auction event_date rides on phase cards / commercial close chips
    next_action: nextAction,
    survey_status: "implemented",
  });
}

/**
 * Survey of property notice classes and whether cycle-context history exists.
 * Named cards for classes that are not yet implementable — no dangling deferrals.
 */
export const PROPERTY_CYCLE_CONTEXT_SURVEY = [
  {
    class_id: "tax_lien",
    label: "Tax lien sale list (DOF 90→60→30→10→final)",
    status: "implemented",
    history: "3 prior cycles; citywide leave-before-sale ~87% at 90-day stage",
    surface: "notice detail + list card when parcel BBL is on a published list",
  },
  {
    class_id: "property_disposition",
    label: "Property disposition (hearing → auction/RFP → award)",
    status: "implemented",
    history: "Cohort auction-notice→event lags (n≈34); multi-stage hearing→auction pairs rare",
    surface: "disposition phase spine + attributed timing line on Property Disposition notices",
  },
  {
    class_id: "commercial_surplus_auction",
    label: "Commercial surplus / vehicle / equipment auctions",
    status: "carded",
    history: "Per-notice close dates exist; no multi-cycle outcome history model",
    reason: "No attributed prior-cycle leave/win rates — commercial glance + close chips only",
    card_id: "property-cycle-context-commercial-surplus",
  },
  {
    class_id: "franchise_concession",
    label: "Franchise / concession (FCRC)",
    status: "carded",
    history: "Process spine exists; no cross-cycle award-rate cohort",
    reason: "Need multi-year FCRC award rates before historical context lines",
    card_id: "property-cycle-context-franchise",
  },
  {
    class_id: "destruction_transfer_abandonment",
    label: "Destruction / transfer / abandonment (non-sale disposition)",
    status: "carded",
    history: "No sale ladder",
    reason: "Not a recurring sale cycle — correctly sale_eligible=false, no cycle context",
    card_id: "property-cycle-context-non-sale",
  },
];
