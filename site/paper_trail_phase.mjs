/**
 * Money notice paper trail (PIN siblings) — phase grouping view model.
 *
 * Pure view model over loadChain() rows: group by contract-lifecycle notice phases,
 * aggregate same-day same-type pools (blanket PINs), derive current stage + next,
 * and count City Record link candidates so the UI can emit one outbound link by default.
 *
 * Same shape as site/land_phase_spine.mjs and site/procurement_phase_spine.mjs
 * (ZAP / Money lifecycle). Do not fork a parallel generic phase-timeline component —
 * when a shared one lands, migrate all three. Presentation lives in site/index.html
 * chainHTML / paperTrailPhaseHTML.
 */

export const PAPER_TRAIL_PHASE_SCHEMA_VERSION = 1;

/**
 * Ordered City Record notice phases for a PIN chain.
 * Aligns with procurement lifecycle ontology (solicitation → selection → award);
 * payments live on the contract lifecycle / Follow-the-Dollars, not this trail.
 */
export const PAPER_TRAIL_PHASES = Object.freeze([
  "solicitation",
  "selection",
  "award",
]);

export const PAPER_TRAIL_PHASE_META = Object.freeze({
  solicitation: {
    id: "solicitation",
    short: "Solicit",
    label_key: "paper_trail_phase_solicitation",
    action_key: "paper_trail_action_respond",
  },
  selection: {
    id: "selection",
    short: "Select",
    label_key: "paper_trail_phase_selection",
    action_key: "paper_trail_action_review_selection",
  },
  award: {
    id: "award",
    short: "Award",
    label_key: "paper_trail_phase_award",
    action_key: "paper_trail_action_track_award",
  },
});

/** City Record type_of_notice_description → phase id. */
export const NOTICE_TYPE_TO_PHASE = Object.freeze({
  Solicitation: "solicitation",
  "Intent to Negotiate": "selection",
  "Vendor List": "selection",
  "Intent to Award": "selection",
  Award: "award",
});

/** Display rank within a phase (matches STAGE_RANK on the site). */
export const NOTICE_TYPE_ORDER = Object.freeze({
  Solicitation: 0,
  "Intent to Negotiate": 1,
  "Vendor List": 2,
  "Intent to Award": 3,
  Award: 4,
});

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDate(value) {
  if (!value) return null;
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
 * Map a City Record notice type to a paper-trail phase id.
 * @param {string|null|undefined} type
 * @returns {string}
 */
export function mapNoticeTypeToPhase(type) {
  const t = clean(type);
  if (t && NOTICE_TYPE_TO_PHASE[t]) return NOTICE_TYPE_TO_PHASE[t];
  // Unknown procurement-adjacent types land in selection; pure noise → solicitation.
  if (t && /intent|vendor|negotiat|award/i.test(t)) return "selection";
  if (t && /award/i.test(t)) return "award";
  return "solicitation";
}

/**
 * True when the chain is a simultaneous multi-vendor award pool under one PIN
 * (not sequential rebid history). Mirrors site isBlanketChain.
 * @param {object[]} chain
 */
export function isBlanketPaperTrail(chain) {
  const rows = Array.isArray(chain) ? chain : [];
  return rows.length > 5 && rows.every((c) => c && c.type_of_notice_description === "Award");
}

/**
 * Collapse same-type same-day notices within one phase (blanket pools, multi-vendor
 * awards, same-day re-posts). Members keep full row payloads for disclosure.
 * @param {object[]} notices
 */
export function aggregatePaperTrailNotices(notices) {
  const map = new Map();
  for (const n of notices || []) {
    const type = clean(n.type_of_notice_description) || "Notice";
    const date = isoDate(n.start_date) || "nodate";
    const key = `${normalizeKey(type)}|${date}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(n);
  }
  const out = [];
  for (const group of map.values()) {
    const dates = group
      .map((n) => isoDate(n.start_date) || null)
      .filter(Boolean)
      .sort();
    const vendors = [
      ...new Set(group.map((n) => clean(n.vendor_name)).filter(Boolean)),
    ];
    const amounts = group
      .map((n) => {
        const a = n.contract_amount;
        if (a == null || a === "") return null;
        const num = Number(a);
        return Number.isFinite(num) ? num : null;
      })
      .filter((a) => a != null);
    const title =
      clean(group[0].short_title) ||
      clean(group[0].type_of_notice_description) ||
      "—";
    out.push({
      type: clean(group[0].type_of_notice_description) || "Notice",
      title,
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      vendors,
      vendor_count: vendors.length,
      amount_sum: amounts.length ? amounts.reduce((a, b) => a + b, 0) : null,
      members: group.slice().sort((a, b) => {
        const va = String(a.vendor_name || a.request_id || "");
        const vb = String(b.vendor_name || b.request_id || "");
        return va.localeCompare(vb);
      }),
    });
  }
  out.sort((a, b) => {
    const da = String(a.first || "9999");
    const db = String(b.first || "9999");
    if (da !== db) return da.localeCompare(db);
    return (NOTICE_TYPE_ORDER[a.type] ?? 9) - (NOTICE_TYPE_ORDER[b.type] ?? 9);
  });
  return out;
}

/**
 * How many City Record RequestDetail URLs a flat chainHTML would emit (one per row).
 * @param {object[]} chain
 */
export function countCityRecordLinkCandidates(chain) {
  return (Array.isArray(chain) ? chain : []).filter((c) => c && c.request_id).length;
}

/**
 * Build phase-grouped paper-trail view model.
 *
 * @param {object[]} chain - loadChain rows (PIN siblings, possibly renewal-widened)
 * @param {object|null} opened - the notice the reader opened
 * @param {object} [opts]
 * @returns {object|null}
 */
export function buildPaperTrailPhaseView(chain, opened, opts = {}) {
  const rows = Array.isArray(chain) ? chain.slice() : [];
  if (!rows.length) return null;

  const openedId = clean(opened?.request_id) || clean(opts.request_id) || null;
  const openedType = clean(opened?.type_of_notice_description) || null;
  const pin = clean(opened?.pin) || clean(rows[0]?.pin) || null;
  const blanket = isBlanketPaperTrail(rows);

  // Bucket notices by phase.
  const byPhase = new Map(PAPER_TRAIL_PHASES.map((id) => [id, []]));
  for (const n of rows) {
    const phaseId = mapNoticeTypeToPhase(n?.type_of_notice_description);
    if (!byPhase.has(phaseId)) byPhase.set(phaseId, []);
    byPhase.get(phaseId).push(n);
  }

  const openedPhase = mapNoticeTypeToPhase(openedType);
  const phaseOrder = PAPER_TRAIL_PHASES;
  const openedIdx = phaseOrder.indexOf(openedPhase);

  // Current = phase of the opened notice when present; else latest phase with data.
  let currentPhaseId = openedPhase;
  if (!rows.some((n) => mapNoticeTypeToPhase(n.type_of_notice_description) === currentPhaseId)) {
    currentPhaseId = null;
    for (let i = phaseOrder.length - 1; i >= 0; i--) {
      if ((byPhase.get(phaseOrder[i]) || []).length) {
        currentPhaseId = phaseOrder[i];
        break;
      }
    }
  }
  if (!currentPhaseId) currentPhaseId = "solicitation";
  const currentIdx = phaseOrder.indexOf(currentPhaseId);

  const phases = phaseOrder.map((id) => {
    const meta = PAPER_TRAIL_PHASE_META[id];
    const notices = byPhase.get(id) || [];
    const aggregates = aggregatePaperTrailNotices(notices);
    const dates = notices
      .map((n) => isoDate(n.start_date))
      .filter(Boolean)
      .sort();
    let state = "future";
    const idx = phaseOrder.indexOf(id);
    if (notices.length) {
      if (id === currentPhaseId) state = "current";
      else if (idx < currentIdx) state = "passed";
      else state = "future";
    } else if (idx < currentIdx) {
      state = "passed";
    }
    return {
      id,
      short: meta.short,
      label_key: meta.label_key,
      action_key: meta.action_key,
      state,
      event_count: notices.length,
      aggregate_count: aggregates.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      aggregates,
      notices,
    };
  });

  const currentPhase = phases.find((p) => p.id === currentPhaseId) || phases[0];
  let next = null;
  for (let i = currentIdx + 1; i < phases.length; i++) {
    // Next ontology stage even if empty — "what's next" for the reader.
    next = {
      id: phases[i].id,
      short: phases[i].short,
      label_key: phases[i].label_key,
      has_notices: phases[i].event_count > 0,
    };
    break;
  }

  // Lead milestone: prefer the opened notice; else newest in current phase.
  let milestone = opened || null;
  if (!milestone || mapNoticeTypeToPhase(milestone.type_of_notice_description) !== currentPhaseId) {
    const sorted = (currentPhase.notices || []).slice().sort((a, b) =>
      String(b.start_date || "").localeCompare(String(a.start_date || "")),
    );
    milestone = sorted[0] || opened || null;
  }

  const linkCandidates = countCityRecordLinkCandidates(rows);
  // Default chrome: one City Record link (opened notice) — members only behind disclosure.
  const defaultLinkId =
    openedId ||
    clean(milestone?.request_id) ||
    clean(rows.find((r) => r.request_id)?.request_id) ||
    null;

  return {
    schema_version: PAPER_TRAIL_PHASE_SCHEMA_VERSION,
    pin,
    blanket,
    notice_count: rows.length,
    city_record_link_candidates: linkCandidates,
    default_city_record_links: defaultLinkId ? 1 : 0,
    default_city_record_request_id: defaultLinkId,
    current: {
      phase_id: currentPhaseId,
      label_key: currentPhase.label_key,
      action_key: currentPhase.action_key,
      short: currentPhase.short,
      notice_type: clean(milestone?.type_of_notice_description) || null,
      milestone_label:
        clean(milestone?.short_title) ||
        clean(milestone?.type_of_notice_description) ||
        null,
      since: isoDate(milestone?.start_date) || null,
      request_id: clean(milestone?.request_id) || null,
      vendor_name: clean(milestone?.vendor_name) || null,
      contract_amount:
        milestone?.contract_amount != null && milestone.contract_amount !== ""
          ? Number(milestone.contract_amount)
          : null,
      opened: !!(openedId && milestone && clean(milestone.request_id) === openedId),
    },
    next,
    phases,
    chronological: rows.slice().sort((a, b) => {
      const da = String(a.start_date || "");
      const db = String(b.start_date || "");
      if (da !== db) return da.localeCompare(db);
      return (
        (NOTICE_TYPE_ORDER[a.type_of_notice_description] ?? 9) -
        (NOTICE_TYPE_ORDER[b.type_of_notice_description] ?? 9)
      );
    }),
    // Hint for UI: multi-phase when more than one phase has notices, or blanket pool.
    multi_phase: phases.filter((p) => p.event_count > 0).length > 1,
    needs_phase_ui: rows.length > 1,
  };
}
