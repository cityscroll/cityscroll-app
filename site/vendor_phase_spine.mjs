/**
 * Vendor profile “On the record” — procurement phase grouping.
 *
 * Pure view model over the vendor’s recent City Record notices (up to 15): group under
 * award → registration → payments (the vendor-facing slice of the procurement lifecycle),
 * aggregate same-year awards, derive current status + next action, and count outbound
 * Checkbook link candidates so the UI can emit one vendor Checkbook handoff (not one per
 * award row). City Record notice links stay per-notice behind disclosure (internal #notice
 * routes, not portal spam).
 *
 * Presentation shape matches site/matter_phase_spine.mjs and site/procurement_phase_spine.mjs
 * (lead → stepper → phase panels → chronological disclosure). When a shared phase-timeline
 * helper lands, migrate — do not fork a third presentation.
 *
 * HTML lives in site/index.html vendorProfileHTML / vendorPhaseTimelineHTML.
 *
 * Checkbook registration/payment joins are not on the vendor profile payload yet; those
 * phases stay future with a single Checkbook action rather than N repeated links or a
 * “join coming” note on every row.
 */

export const VENDOR_PHASE_SPINE_SCHEMA_VERSION = 1;

/**
 * Ordered vendor-facing procurement phases.
 * Solicitations rarely name a vendor; selection (intent to award) rolls into award when
 * present. Registration and payments are Checkbook stages (not yet edge-joined here).
 */
export const VENDOR_PROCUREMENT_PHASES = Object.freeze([
  "award",
  "registration",
  "payments",
]);

export const VENDOR_PHASE_META = Object.freeze({
  award: {
    id: "award",
    short: "Award",
    label_key: "vendor_phase_award",
    action_key: "vendor_phase_action_review_awards",
  },
  registration: {
    id: "registration",
    short: "Register",
    label_key: "vendor_phase_registration",
    action_key: "vendor_phase_action_track_registration",
  },
  payments: {
    id: "payments",
    short: "Pay",
    label_key: "vendor_phase_payments",
    action_key: "vendor_phase_action_follow_money",
  },
});

/** City Record type_of_notice_description → vendor phase id. */
export const NOTICE_TYPE_TO_VENDOR_PHASE = Object.freeze({
  Award: "award",
  "Intent to Award": "award",
  "Intent to Negotiate": "award",
  "Vendor List": "award",
  Solicitation: "award",
});

export const SOURCE_FAMILY = Object.freeze({
  "city-record": "city-record",
  checkbook: "checkbook",
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

function yearOf(value) {
  const d = isoDate(value);
  return d ? d.slice(0, 4) : null;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function amountOf(row) {
  if (row == null || row.contract_amount == null || row.contract_amount === "") return null;
  const n = Number(row.contract_amount);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a City Record notice type to a vendor phase id.
 * @param {string|null|undefined} typeOfNotice
 * @returns {string}
 */
export function mapNoticeTypeToVendorPhase(typeOfNotice) {
  const raw = clean(typeOfNotice);
  if (raw && NOTICE_TYPE_TO_VENDOR_PHASE[raw]) return NOTICE_TYPE_TO_VENDOR_PHASE[raw];
  if (!raw) return "award";
  const lower = raw.toLowerCase();
  if (lower.includes("award") || lower.includes("solicit") || lower.includes("intent") || lower.includes("vendor")) {
    return "award";
  }
  return "award";
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
 * Count how many Checkbook (or other family) links would repeat if every row linked.
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
 * Build a milestone from a City Record notice row on a vendor profile.
 * @param {object} row
 */
export function noticeToVendorMilestone(row) {
  const phase = mapNoticeTypeToVendorPhase(row?.type_of_notice_description);
  const title =
    clean(row?.short_title) ||
    clean(row?.type_of_notice_description) ||
    clean(row?.request_id) ||
    "—";
  return {
    kind: "notice",
    phase,
    stage: phase === "award" ? "award" : phase,
    date: isoDate(row?.start_date) || isoDate(row?.event_date) || null,
    year: yearOf(row?.start_date) || yearOf(row?.event_date) || null,
    source: "city-record",
    title,
    notice_type: clean(row?.type_of_notice_description),
    request_id: clean(row?.request_id),
    agency_name: clean(row?.agency_name),
    contract_amount: amountOf(row),
    // Hypothetical per-row Checkbook handoff — UI must not emit N of these.
    checkbook_candidate: true,
    row,
  };
}

/**
 * Aggregate award milestones by calendar year (year-cycle presentation).
 * @param {object[]} milestones
 */
export function aggregateByYear(milestones) {
  const map = new Map();
  for (const m of milestones || []) {
    const y = m.year || yearOf(m.date) || "unknown";
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(m);
  }
  const out = [];
  for (const [year, group] of map.entries()) {
    const dates = group
      .map((m) => isoDate(m.date) || null)
      .filter(Boolean)
      .sort();
    const amounts = group.map((m) => m.contract_amount).filter((a) => a != null);
    const agencies = [
      ...new Set(group.map((m) => clean(m.agency_name)).filter(Boolean)),
    ];
    out.push({
      key: year,
      year: year === "unknown" ? null : year,
      title: year === "unknown" ? "—" : year,
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      amount_sum: amounts.length ? amounts.reduce((a, b) => a + b, 0) : null,
      agency_count: agencies.length,
      agencies,
      members: group.slice().sort((a, b) =>
        String(b.date || "").localeCompare(String(a.date || "")),
      ),
    });
  }
  out.sort((a, b) => String(b.year || "0000").localeCompare(String(a.year || "0000")));
  return out;
}

/**
 * Aggregate identical titles within a year group (optional second-level collapse).
 * @param {object[]} milestones
 */
export function aggregateByTitle(milestones) {
  const map = new Map();
  for (const m of milestones || []) {
    const title = clean(m.title) || clean(m.notice_type) || "—";
    const key = normalizeKey(title);
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
      title: clean(group[0].title) || clean(group[0].notice_type) || "—",
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      members: group,
    });
  }
  out.sort((a, b) => String(b.first || "").localeCompare(String(a.first || "")));
  return out;
}

/**
 * Build phase-grouped vendor “On the record” view model.
 *
 * @param {object[]} rows - recent City Record notices naming this vendor
 * @param {object} [opts]
 * @param {string} [opts.vendorName] - display name for Checkbook search
 * @param {string} [opts.stem] - vendor stem (identity)
 * @param {boolean} [opts.hasRegistration] - when a future Checkbook join lands
 * @param {boolean} [opts.hasPayments]
 * @param {object|null} [opts.checkbook] - optional prebuilt checkbook target
 */
export function buildVendorPhaseView(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const vendorName = clean(opts.vendorName) || clean(opts.display) || null;
  const stem = clean(opts.stem) || null;

  const milestones = list.map((r) => noticeToVendorMilestone(r));

  const byPhase = Object.fromEntries(VENDOR_PROCUREMENT_PHASES.map((id) => [id, []]));
  for (const m of milestones) {
    const phaseId = m.phase || "award";
    (byPhase[phaseId] || byPhase.award).push(m);
  }

  // Optional future joins (not on vendor profile payload today).
  if (opts.hasRegistration) {
    byPhase.registration.push({
      kind: "registered",
      phase: "registration",
      stage: "registered",
      date: null,
      source: "checkbook-contracts",
      title: "registered",
      status: "matched",
    });
  }
  if (opts.hasPayments) {
    byPhase.payments.push({
      kind: "payment",
      phase: "payments",
      stage: "payment",
      date: null,
      source: "checkbook-spending",
      title: "paid_to_date",
      status: "matched",
    });
  }

  for (const id of VENDOR_PROCUREMENT_PHASES) {
    byPhase[id].sort((a, b) =>
      String(isoDate(b.date) || "").localeCompare(String(isoDate(a.date) || "")),
    );
  }

  // Current = latest phase with material. Today that is almost always award.
  let currentPhaseId = null;
  for (let i = VENDOR_PROCUREMENT_PHASES.length - 1; i >= 0; i--) {
    const id = VENDOR_PROCUREMENT_PHASES[i];
    if ((byPhase[id] || []).length) {
      currentPhaseId = id;
      break;
    }
  }
  if (!currentPhaseId) currentPhaseId = "award";
  const curIdx = VENDOR_PROCUREMENT_PHASES.indexOf(currentPhaseId);

  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = VENDOR_PROCUREMENT_PHASES.indexOf(id);
    const has = (byPhase[id] || []).length > 0;
    if (idx < curIdx) return "passed";
    if (has && idx > curIdx) return "passed";
    return "future";
  }

  const noticeMilestones = milestones.filter((m) => m.kind === "notice" && m.request_id);
  let latestNotice = null;
  for (const m of noticeMilestones) {
    if (!latestNotice || String(m.date || "") >= String(latestNotice.date || "")) {
      latestNotice = m;
    }
  }

  // Synthetic Checkbook candidates: one per award notice if we linked each row.
  const checkbookCandidates = noticeMilestones.map((m) => ({
    ...m,
    source: "checkbook",
  }));
  const duplicateCheckbookLinks = countDuplicateSourceLinks(checkbookCandidates);

  const phases = VENDOR_PROCUREMENT_PHASES.map((id) => {
    const state = phaseState(id);
    const all = byPhase[id] || [];
    // Future empty: no panel body. Current/passed: show material. Substance stays behind
    // disclosure in the HTML layer; the view still carries the rows.
    const display = state === "future" ? [] : all;
    const dates = display
      .map((m) => isoDate(m.date))
      .filter(Boolean)
      .sort();
    const yearAggs = id === "award" ? aggregateByYear(display) : [];
    const titleAggs = id === "award" ? aggregateByTitle(display) : [];

    return {
      id,
      short: VENDOR_PHASE_META[id].short,
      label_key: VENDOR_PHASE_META[id].label_key,
      action_key: VENDOR_PHASE_META[id].action_key,
      state,
      event_count: display.length,
      total_count: all.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      year_aggregates: yearAggs,
      title_aggregates: titleAggs,
      milestones: display,
      all_milestones: all,
      source_links_dropped: id === "award" ? Math.max(0, display.length - 1) : 0,
    };
  });

  let nextPhase = null;
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (phases[i].state === "future" || phases[i].state === "passed") {
      nextPhase = phases[i];
      if (phases[i].state === "future") break;
    }
  }
  // Prefer the immediate next ontology step.
  if (curIdx + 1 < phases.length) {
    nextPhase = phases[curIdx + 1];
  }

  const chronological = milestones.slice().sort((a, b) => {
    const da = a.date || "0000";
    const db = b.date || "0000";
    if (da !== db) return String(da).localeCompare(String(db));
    return String(a.request_id || "").localeCompare(String(b.request_id || ""));
  });

  const curPhase = phases.find((p) => p.id === currentPhaseId);
  let currentMilestoneLabel = null;
  let currentSince = null;
  if (curPhase && curPhase.milestones.length) {
    const newest = curPhase.milestones[0]; // already sorted desc
    currentSince = newest.date;
    currentMilestoneLabel = newest.notice_type || newest.title;
  }

  const checkbookTarget = opts.checkbook || (vendorName
    ? { vendor: vendorName }
    : stem
      ? { vendor: stem }
      : null);

  const awardCount = (byPhase.award || []).length;
  const awardAmounts = (byPhase.award || [])
    .map((m) => m.contract_amount)
    .filter((a) => a != null);
  const awardTotal = awardAmounts.length
    ? awardAmounts.reduce((a, b) => a + b, 0)
    : null;

  return {
    schema_version: VENDOR_PHASE_SPINE_SCHEMA_VERSION,
    vendor_name: vendorName,
    stem,
    current: {
      phase_id: currentPhaseId,
      label_key: VENDOR_PHASE_META[currentPhaseId]?.label_key || "vendor_phase_award",
      action_key: VENDOR_PHASE_META[currentPhaseId]?.action_key || "vendor_phase_action_review_awards",
      milestone_label: currentMilestoneLabel,
      since: currentSince,
      award_count: awardCount,
      award_total: awardTotal,
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
          state: nextPhase.state,
        }
      : null,
    phases,
    chronological,
    event_count: milestones.length,
    notice_count: noticeMilestones.length,
    // N award rows × Checkbook → N-1 duplicates if every row linked.
    duplicate_link_candidates: duplicateCheckbookLinks,
    default_checkbook_links: checkbookTarget ? 1 : 0,
    action_notice_id: latestNotice?.request_id || null,
    latest_notice_id: latestNotice?.request_id || null,
    checkbook: checkbookTarget,
    has_registration: Boolean(opts.hasRegistration),
    has_payments: Boolean(opts.hasPayments),
  };
}
