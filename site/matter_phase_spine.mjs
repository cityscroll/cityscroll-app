/**
 * Matter PIN timeline (#matter/<pin>) — procurement phase grouping.
 *
 * Pure view model over City Record notice rows + bolted-on Checkbook
 * registration/payment facts: group under the same procurement phases as the
 * contract lifecycle (solicitation → selection → award/registration → payments),
 * aggregate verbatim-repeated notice types, derive current status + next action,
 * and count outbound source-family duplicates (City Record / Checkbook).
 *
 * Presentation shape matches site/land_phase_spine.mjs (ZAP/ULURP #326) and
 * site/procurement_phase_spine.mjs (notice lifecycle phase PR): lead → stepper →
 * phase panels → chronological disclosure. When a shared phase-timeline helper
 * lands, migrate both — do not fork a third presentation.
 *
 * HTML lives in site/index.html showMatter / matterPhaseTimelineHTML.
 */

export const MATTER_PHASE_SPINE_SCHEMA_VERSION = 1;

/**
 * Ordered procurement phases (shared ontology with contract lifecycle).
 * Intermediate City Record stages sit in `selection`.
 */
export const MATTER_PROCUREMENT_PHASES = Object.freeze([
  "solicitation",
  "selection",
  "award_registration",
  "payments",
]);

export const MATTER_PHASE_META = Object.freeze({
  solicitation: {
    id: "solicitation",
    short: "Solicit",
    label_key: "matter_phase_solicitation",
    action_key: "matter_phase_action_respond",
  },
  selection: {
    id: "selection",
    short: "Select",
    label_key: "matter_phase_selection",
    action_key: "matter_phase_action_review_selection",
  },
  award_registration: {
    id: "award_registration",
    short: "Award",
    label_key: "matter_phase_award_registration",
    action_key: "matter_phase_action_track_award",
  },
  payments: {
    id: "payments",
    short: "Pay",
    label_key: "matter_phase_payments",
    action_key: "matter_phase_action_follow_money",
  },
});

/** City Record type_of_notice_description → lifecycle stage id. */
export const NOTICE_TYPE_TO_STAGE = Object.freeze({
  Solicitation: "solicitation",
  "Intent to Negotiate": "intent_to_negotiate",
  "Vendor List": "vendor_list",
  "Intent to Award": "intent_to_award",
  Award: "award",
});

/** Stage → phase id. */
export const STAGE_TO_PHASE = Object.freeze({
  solicitation: "solicitation",
  intent_to_negotiate: "selection",
  vendor_list: "selection",
  intent_to_award: "selection",
  award: "award_registration",
  pending: "award_registration",
  registered: "award_registration",
  payment: "payments",
});

export const STAGE_ORDER = Object.freeze({
  solicitation: 0,
  intent_to_negotiate: 1,
  vendor_list: 2,
  intent_to_award: 3,
  award: 4,
  pending: 5,
  registered: 6,
  payment: 7,
});

export const SOURCE_FAMILY = Object.freeze({
  "city-record": "city-record",
  "checkbook-contracts": "checkbook",
  "checkbook-spending": "checkbook",
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

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map a lifecycle stage id to a procurement phase id.
 * @param {string|null|undefined} stage
 * @returns {string}
 */
export function mapStageToPhase(stage) {
  const id = clean(stage);
  if (id && STAGE_TO_PHASE[id]) return STAGE_TO_PHASE[id];
  return "solicitation";
}

/**
 * Map a City Record notice type label to a lifecycle stage id.
 * @param {string|null|undefined} typeOfNotice
 * @returns {string}
 */
export function mapNoticeTypeToStage(typeOfNotice) {
  const raw = clean(typeOfNotice);
  if (!raw) return "solicitation";
  if (NOTICE_TYPE_TO_STAGE[raw]) return NOTICE_TYPE_TO_STAGE[raw];
  const lower = raw.toLowerCase();
  if (lower.includes("intent to negotiate")) return "intent_to_negotiate";
  if (lower.includes("vendor list")) return "vendor_list";
  if (lower.includes("intent to award")) return "intent_to_award";
  if (lower.includes("award")) return "award";
  if (lower.includes("solicit")) return "solicitation";
  return "solicitation";
}

/**
 * Source family for outbound-link dedupe.
 * @param {string|null|undefined} source
 */
export function sourceFamily(source) {
  const s = clean(source);
  if (!s) return null;
  return SOURCE_FAMILY[s] || s;
}

/**
 * Collapse verbatim-identical milestones within one phase.
 * Key = stage + normalized title.
 * @param {object[]} milestones
 */
export function aggregatePhaseMilestones(milestones) {
  const map = new Map();
  for (const m of milestones || []) {
    const title = clean(m.title) || clean(m.stage) || "—";
    const key = [normalizeKey(m.stage), normalizeKey(title)].join("|");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  const out = [];
  for (const group of map.values()) {
    const dates = group
      .map((m) => isoDate(m.date) || null)
      .filter(Boolean)
      .sort();
    out.push({
      stage: group[0].stage,
      title: clean(group[0].title) || clean(group[0].stage) || "—",
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      members: group,
    });
  }
  out.sort((a, b) => {
    const oa = STAGE_ORDER[a.stage] ?? 99;
    const ob = STAGE_ORDER[b.stage] ?? 99;
    if (oa !== ob) return oa - ob;
    return String(a.first || "9999").localeCompare(String(b.first || "9999"));
  });
  return out;
}

/**
 * Count how many City Record / Checkbook links would repeat if every row linked.
 * @param {object[]} milestones
 */
export function countDuplicateSourceLinks(milestones) {
  const familyCounts = {};
  for (const m of milestones || []) {
    const fam = sourceFamily(m.source);
    if (!fam) continue;
    familyCounts[fam] = (familyCounts[fam] || 0) + 1;
  }
  return Object.values(familyCounts).reduce((n, c) => n + Math.max(0, c - 1), 0);
}

/**
 * Build a milestone from a City Record notice row.
 * @param {object} row
 * @param {string} pin - requested matter PIN
 */
export function noticeToMilestone(row, pin) {
  const stage = mapNoticeTypeToStage(row?.type_of_notice_description);
  const title =
    clean(row?.short_title) ||
    clean(row?.type_of_notice_description) ||
    clean(row?.request_id) ||
    "—";
  return {
    kind: "notice",
    stage,
    date: isoDate(row?.start_date) || isoDate(row?.event_date) || null,
    source: "city-record",
    title,
    notice_type: clean(row?.type_of_notice_description),
    request_id: clean(row?.request_id),
    pin: clean(row?.pin),
    renewal_linked: Boolean(row?.pin && pin && clean(row.pin) !== clean(pin)),
    vendor_name: clean(row?.vendor_name),
    contract_amount: row?.contract_amount != null ? Number(row.contract_amount) : null,
    due_date: isoDate(row?.due_date) || null,
    row,
  };
}

/**
 * Registration milestone from lifecycle reg detail.
 * @param {object|null} regDetail
 * @param {object|null} [regEntry] - raw timeline entry when unmatched
 */
export function registrationToMilestone(regDetail, regEntry = null) {
  if (regDetail && regDetail.registration_date) {
    return {
      kind: "registered",
      stage: "registered",
      date: isoDate(regDetail.registration_date),
      source: "checkbook-contracts",
      title: clean(regDetail.contract_id) || "registered",
      contract_id: clean(regDetail.contract_id),
      current_amount: regDetail.current_amount != null ? Number(regDetail.current_amount) : null,
      spent_to_date: regDetail.spent_to_date != null ? Number(regDetail.spent_to_date) : null,
      start_date: isoDate(regDetail.start_date),
      end_date: isoDate(regDetail.end_date),
      agid: regDetail.agid || regDetail.checkbook_agid || null,
      document_code: regDetail.document_code || regDetail.doctype || null,
      checkbook_detail_url: regDetail.checkbook_detail_url || null,
      status: "matched",
      detail: regDetail,
    };
  }
  if (regEntry && regEntry.status === "unmatched") {
    return {
      kind: "registered",
      stage: "registered",
      date: null,
      source: "checkbook-contracts",
      title: "registered",
      status: "unmatched",
      detail: null,
    };
  }
  return null;
}

/**
 * Paid-to-date milestone from registration spend (matter spine ownership).
 * @param {object|null} regDetail
 */
export function paymentToMilestone(regDetail) {
  if (!regDetail) return null;
  const spent = regDetail.spent_to_date != null ? Number(regDetail.spent_to_date) : 0;
  const current = regDetail.current_amount != null ? Number(regDetail.current_amount) : 0;
  return {
    kind: "payment",
    stage: "payment",
    date: null,
    source: "checkbook-spending",
    title: "paid_to_date",
    spent_to_date: spent,
    current_amount: current,
    contract_id: clean(regDetail.contract_id),
    start_date: isoDate(regDetail.start_date),
    end_date: isoDate(regDetail.end_date),
    agid: regDetail.agid || regDetail.checkbook_agid || null,
    document_code: regDetail.document_code || regDetail.doctype || null,
    checkbook_detail_url: regDetail.checkbook_detail_url || null,
    status: "matched",
    detail: regDetail,
  };
}

/**
 * Build phase-grouped matter timeline view model.
 *
 * @param {object[]} rows - City Record notice rows for the PIN (and renewals)
 * @param {object} [opts]
 * @param {string} [opts.pin]
 * @param {object|null} [opts.regDetail]
 * @param {object|null} [opts.lifecycle] - full /contract-lifecycle payload
 * @param {object|null} [opts.pay] - payment timeline entry (optional; spend comes from regDetail)
 */
export function buildMatterPhaseView(rows, opts = {}) {
  const pin = clean(opts.pin) || null;
  const list = Array.isArray(rows) ? rows.slice() : [];
  const milestones = list.map((r) => noticeToMilestone(r, pin));

  let regDetail = opts.regDetail || null;
  const lifecycle = opts.lifecycle || null;
  if (!regDetail && lifecycle && Array.isArray(lifecycle.timeline)) {
    const reg = lifecycle.timeline.find(
      (e) => e && e.stage === "registered" && e.status === "matched" && e.detail,
    );
    if (reg) regDetail = reg.detail;
  }

  const regMilestone = registrationToMilestone(
    regDetail,
    lifecycle && Array.isArray(lifecycle.timeline)
      ? lifecycle.timeline.find((e) => e && e.stage === "registered")
      : null,
  );
  if (regMilestone) milestones.push(regMilestone);

  const payMilestone = paymentToMilestone(regDetail);
  if (payMilestone) milestones.push(payMilestone);

  const byPhase = Object.fromEntries(MATTER_PROCUREMENT_PHASES.map((id) => [id, []]));
  for (const m of milestones) {
    const phaseId = mapStageToPhase(m.stage);
    (byPhase[phaseId] || byPhase.solicitation).push(m);
  }

  for (const id of MATTER_PROCUREMENT_PHASES) {
    byPhase[id].sort((a, b) => {
      const oa = STAGE_ORDER[a.stage] ?? 99;
      const ob = STAGE_ORDER[b.stage] ?? 99;
      if (oa !== ob) return oa - ob;
      return String(isoDate(a.date) || "9999").localeCompare(String(isoDate(b.date) || "9999"));
    });
  }

  // Current = latest phase with material (payments if spend/reg present, else last notice phase).
  let currentPhaseId = null;
  if (payMilestone) {
    currentPhaseId = "payments";
  } else if (regMilestone && regMilestone.status === "matched") {
    currentPhaseId = "award_registration";
  } else {
    for (let i = MATTER_PROCUREMENT_PHASES.length - 1; i >= 0; i--) {
      const id = MATTER_PROCUREMENT_PHASES[i];
      if ((byPhase[id] || []).length) {
        currentPhaseId = id;
        break;
      }
    }
  }
  if (!currentPhaseId) currentPhaseId = "solicitation";

  const curIdx = MATTER_PROCUREMENT_PHASES.indexOf(currentPhaseId);

  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = MATTER_PROCUREMENT_PHASES.indexOf(id);
    const has = (byPhase[id] || []).length > 0;
    if (idx < curIdx) return "passed";
    if (has && idx > curIdx) return "passed";
    return "future";
  }

  // Latest actionable notice for the lead CTA (prefer open solicitation, else newest row).
  const noticeMilestones = milestones.filter((m) => m.kind === "notice" && m.request_id);
  let latestNotice = null;
  let openSolicitation = null;
  for (const m of noticeMilestones) {
    if (!latestNotice) latestNotice = m;
    else if (String(m.date || "") >= String(latestNotice.date || "")) latestNotice = m;
    if (m.stage === "solicitation") {
      if (!openSolicitation || String(m.date || "") >= String(openSolicitation.date || "")) {
        openSolicitation = m;
      }
    }
  }
  const actionNotice =
    currentPhaseId === "solicitation" && openSolicitation ? openSolicitation : latestNotice;

  const phases = MATTER_PROCUREMENT_PHASES.map((id) => {
    const state = phaseState(id);
    const all = byPhase[id] || [];
    // Future empty: no panel body. Current/passed: show all material.
    const display = state === "future" ? [] : all;
    const dates = display
      .map((m) => isoDate(m.date))
      .filter(Boolean)
      .sort();
    const dupes = countDuplicateSourceLinks(display);

    return {
      id,
      short: MATTER_PHASE_META[id].short,
      label_key: MATTER_PHASE_META[id].label_key,
      action_key: MATTER_PHASE_META[id].action_key,
      state,
      event_count: display.length,
      total_count: all.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      aggregates: aggregatePhaseMilestones(display),
      milestones: display,
      all_milestones: all,
      source_links_dropped: dupes,
    };
  });

  let nextPhase = null;
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (phases[i].state === "future") {
      nextPhase = phases[i];
      break;
    }
  }

  // Chronological: notices by date, then reg, then pay at end.
  const chronological = milestones.slice().sort((a, b) => {
    const da = a.date || (a.kind === "payment" ? "9999-99-99" : "9999");
    const db = b.date || (b.kind === "payment" ? "9999-99-99" : "9999");
    if (da !== db) return String(da).localeCompare(String(db));
    return (STAGE_ORDER[a.stage] ?? 99) - (STAGE_ORDER[b.stage] ?? 99);
  });

  // Current milestone label for the lead.
  let currentMilestoneLabel = null;
  let currentSince = null;
  let currentStage = null;
  const curPhase = phases.find((p) => p.id === currentPhaseId);
  if (curPhase && curPhase.milestones.length) {
    const last = curPhase.milestones[curPhase.milestones.length - 1];
    currentStage = last.stage;
    currentSince = last.date;
    if (last.kind === "payment") currentMilestoneLabel = "paid_to_date";
    else if (last.kind === "registered") currentMilestoneLabel = last.contract_id || "registered";
    else currentMilestoneLabel = last.notice_type || last.title;
  }

  const checkbookTarget = regDetail
    ? {
        contractId: regDetail.contract_id || null,
        pin,
        agid: regDetail.agid || regDetail.checkbook_agid || null,
        documentCode: regDetail.document_code || regDetail.doctype || null,
        detailUrl: regDetail.checkbook_detail_url || null,
      }
    : pin
      ? { pin }
      : null;

  return {
    schema_version: MATTER_PHASE_SPINE_SCHEMA_VERSION,
    pin,
    current: {
      phase_id: currentPhaseId,
      label_key: MATTER_PHASE_META[currentPhaseId]?.label_key || "matter_phase_solicitation",
      action_key: MATTER_PHASE_META[currentPhaseId]?.action_key || "matter_phase_action_respond",
      stage: currentStage,
      milestone_label: currentMilestoneLabel,
      since: currentSince,
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
        }
      : null,
    phases,
    chronological,
    event_count: milestones.length,
    notice_count: noticeMilestones.length,
    duplicate_link_candidates: countDuplicateSourceLinks(milestones),
    // At most one City Record outbound + one Checkbook outbound on the page chrome.
    action_notice_id: actionNotice?.request_id || null,
    latest_notice_id: latestNotice?.request_id || null,
    checkbook: checkbookTarget,
    reg_detail: regDetail,
    has_registration: Boolean(regMilestone && regMilestone.status === "matched"),
    registration_unmatched: Boolean(regMilestone && regMilestone.status === "unmatched"),
  };
}
