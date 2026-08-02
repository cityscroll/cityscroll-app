/**
 * Contract / procurement lifecycle — phase projection.
 *
 * Pure view model over assembleLifecycle timeline entries: group by canonical
 * procurement phases, aggregate verbatim-repeated milestones, derive current
 * status + next action, and dedupe outbound source families per phase.
 *
 * Same shape as site/land_phase_spine.mjs (ZAP/ULURP). Do not fork a parallel
 * generic phase-timeline component — when a shared one lands, migrate both.
 *
 * Presentation (HTML) lives in site/index.html lifecycleTimelineHTML.
 */

export const PROCUREMENT_PHASE_SPINE_SCHEMA_VERSION = 1;

/**
 * Ordered procurement phases. Intermediate City Record stages
 * (intent_to_negotiate / vendor_list / intent_to_award) sit in `selection`.
 */
export const PROCUREMENT_PHASES = Object.freeze([
  "solicitation",
  "selection",
  "award_registration",
  "payments",
]);

export const PROCUREMENT_PHASE_META = Object.freeze({
  solicitation: {
    id: "solicitation",
    short: "Solicit",
    label_key: "lifecycle_phase_solicitation",
    action_key: "lifecycle_phase_action_respond",
  },
  selection: {
    id: "selection",
    short: "Select",
    label_key: "lifecycle_phase_selection",
    action_key: "lifecycle_phase_action_review_selection",
  },
  award_registration: {
    id: "award_registration",
    short: "Award",
    label_key: "lifecycle_phase_award_registration",
    action_key: "lifecycle_phase_action_track_award",
  },
  payments: {
    id: "payments",
    short: "Pay",
    label_key: "lifecycle_phase_payments",
    action_key: "lifecycle_phase_action_follow_money",
  },
});

/** Stage → phase id. Unknown stages fall into solicitation (earliest). */
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

/** Display order of stages within a phase (matches LIFECYCLE_STAGE_ORDER). */
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

/** Source family for outbound-link dedupe (one per phase). */
export const SOURCE_FAMILY = Object.freeze({
  "city-record": "city-record",
  "checkbook-contracts": "checkbook",
  "checkbook-spending": "checkbook",
  "passport-public-contracts": "passport",
  "passport-public-rfx": "passport",
  "ocp-recent-awards": "ocp",
  "current-solicitations": "open-data",
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
 * Public status for a timeline entry (mirrors site lifecyclePublicStatus without DOM).
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
  // Payment with a matched registered join is display-matched.
  if (entry.stage === "payment") {
    const reg = (timeline || []).find(
      (e) => e && e.stage === "registered" && e.status === "matched" && e.detail,
    );
    if (reg) return "matched";
  }
  if (entry.status === "unknown" || entry.status === "unmatched") return "unmatched";
  return entry.status;
}

/**
 * Last matched stage key (or first ambiguous) — reader "current" step.
 * @param {object[]} timeline
 */
export function currentStageKey(timeline) {
  const raw = timeline || [];
  for (const e of raw) {
    if (publicStatus(e, raw) === "ambiguous") return e.stage;
  }
  let lastMatched = null;
  for (const e of raw) {
    if (publicStatus(e, raw) === "matched") lastMatched = e.stage;
    if (e && e.stage === "payment") {
      const reg = raw.find(
        (x) => x && x.stage === "registered" && x.status === "matched" && x.detail,
      );
      if (reg) lastMatched = "payment";
    }
  }
  return lastMatched;
}

/**
 * Collapse verbatim-identical milestones within one phase.
 * Key = stage + normalized title/vendor + public status.
 * @param {object[]} milestones - { stage, status, date, title, entry, ... }
 */
export function aggregatePhaseMilestones(milestones) {
  const map = new Map();
  for (const m of milestones || []) {
    const title = clean(m.title) || clean(m.stage) || "—";
    const key = [
      normalizeKey(m.stage),
      normalizeKey(m.public_status || m.status),
      normalizeKey(title),
    ].join("|");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  const out = [];
  for (const group of map.values()) {
    const dates = group
      .map((m) => isoDate(m.date) || null)
      .filter(Boolean)
      .sort();
    const statuses = [
      ...new Set(
        group.map((m) => clean(m.public_status) || clean(m.status) || "—").filter(Boolean),
      ),
    ];
    out.push({
      stage: group[0].stage,
      title: clean(group[0].title) || clean(group[0].stage) || "—",
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      statuses,
      members: group,
      public_status: group[0].public_status || group[0].status,
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
 * Source family for an entry's outbound link.
 * @param {string|null|undefined} source
 */
export function sourceFamily(source) {
  const s = clean(source);
  if (!s) return null;
  return SOURCE_FAMILY[s] || s;
}

/**
 * Dedupe outbound source links within a phase: keep first occurrence of each family.
 * @param {object[]} entries - timeline entries (with .source)
 * @returns {{ kept: object[], dropped: number, families: string[] }}
 */
export function dedupePhaseSourceLinks(entries) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const entry of entries || []) {
    const fam = sourceFamily(entry?.source);
    if (!fam) {
      kept.push(entry);
      continue;
    }
    if (seen.has(fam)) {
      dropped += 1;
      continue;
    }
    seen.add(fam);
    kept.push(entry);
  }
  return { kept, dropped, families: [...seen] };
}

/**
 * Milestone title for display / aggregation (not i18n — presentation labels stages).
 * @param {object} entry
 */
function milestoneTitle(entry) {
  const d = entry?.detail || {};
  if (entry?.stage === "payment" && d.total_payments != null) {
    return `Payments (${d.total_payments})`;
  }
  if (d.vendor) return clean(d.vendor) || entry.stage;
  if (d.title) return clean(d.title) || entry.stage;
  if (d.contract_id) return clean(d.contract_id) || entry.stage;
  if (d.rfx?.procurement_name) return clean(d.rfx.procurement_name) || entry.stage;
  return entry?.stage || "—";
}

/**
 * Build phase-grouped procurement lifecycle view model.
 *
 * @param {object|null|undefined} data - assembleLifecycle payload
 * @param {object} [opts]
 * @param {object|null} [opts.notice]
 * @param {boolean} [opts.no_pin]
 */
export function buildProcurementPhaseView(data, opts = {}) {
  const raw = Array.isArray(data?.timeline) ? data.timeline.slice() : [];
  const noPin =
    opts.no_pin === true ||
    !data?.pin ||
    data?.pin_strategy === "none";

  // Filter not_applicable; no-PIN keeps City Record / solicitation / award only.
  const timeline = noPin
    ? raw.filter(
        (e) =>
          e &&
          (e.source === "city-record" ||
            e.stage === "solicitation" ||
            e.stage === "award" ||
            e.stage === "intent_to_negotiate" ||
            e.stage === "vendor_list" ||
            e.stage === "intent_to_award"),
      )
    : raw.filter((e) => e && publicStatus(e, raw) !== "not_applicable");

  const byPhase = Object.fromEntries(PROCUREMENT_PHASES.map((id) => [id, []]));
  for (const entry of timeline) {
    const phaseId = mapStageToPhase(entry.stage);
    const pub = publicStatus(entry, raw);
    byPhase[phaseId].push({
      stage: entry.stage,
      status: entry.status,
      public_status: pub,
      date: entry.date || entry.source_timestamp || null,
      source: entry.source,
      title: milestoneTitle(entry),
      entry,
    });
  }

  // Sort within each phase by stage order then date.
  for (const id of PROCUREMENT_PHASES) {
    byPhase[id].sort((a, b) => {
      const oa = STAGE_ORDER[a.stage] ?? 99;
      const ob = STAGE_ORDER[b.stage] ?? 99;
      if (oa !== ob) return oa - ob;
      return String(isoDate(a.date) || "9999").localeCompare(String(isoDate(b.date) || "9999"));
    });
  }

  const stageKey = currentStageKey(raw);
  let currentPhaseId = stageKey ? mapStageToPhase(stageKey) : null;
  if (!currentPhaseId) {
    // Prefer first phase with matched/ambiguous material; else earliest with any entry.
    for (const id of PROCUREMENT_PHASES) {
      if ((byPhase[id] || []).some((m) => m.public_status === "ambiguous")) {
        currentPhaseId = id;
        break;
      }
    }
  }
  if (!currentPhaseId) {
    for (let i = PROCUREMENT_PHASES.length - 1; i >= 0; i--) {
      const id = PROCUREMENT_PHASES[i];
      if ((byPhase[id] || []).some((m) => m.public_status === "matched" || m.public_status === "passed")) {
        currentPhaseId = id;
        break;
      }
    }
  }
  if (!currentPhaseId) currentPhaseId = "solicitation";

  const curIdx = PROCUREMENT_PHASES.indexOf(currentPhaseId);

  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = PROCUREMENT_PHASES.indexOf(id);
    const milestones = byPhase[id] || [];
    const hasMaterial = milestones.some(
      (m) =>
        m.public_status === "matched" ||
        m.public_status === "passed" ||
        m.public_status === "ambiguous",
    );
    if (idx < curIdx) return "passed";
    if (hasMaterial && idx > curIdx) return "passed"; // data quirk: material after current
    return "future";
  }

  const phases = PROCUREMENT_PHASES.map((id) => {
    const state = phaseState(id);
    const all = byPhase[id] || [];
    // History/current: keep material + passed notes. Future: only matched/ambiguous
    // (rare out-of-order data) — pure unmatched empties are stepper chips only, never
    // empty phase panels with "No milestones yet".
    let display;
    if (state === "future") {
      display = all.filter(
        (m) => m.public_status === "matched" || m.public_status === "ambiguous",
      );
    } else {
      display = all.filter(
        (m) =>
          m.public_status === "matched" ||
          m.public_status === "passed" ||
          m.public_status === "ambiguous",
      );
      if (!display.length) display = all;
    }

    const dates = display
      .map((m) => isoDate(m.date))
      .filter(Boolean)
      .sort();

    const linkDedupe = dedupePhaseSourceLinks(display.map((m) => m.entry));
    // Which entry indices may emit a source link (first of each family among display).
    const linkAllowedStages = new Set(
      linkDedupe.kept
        .filter((e) => e && (e.status === "matched" || e.status === "ambiguous"))
        .map((e) => e.stage),
    );
    // Prefer a single allowed stage for the phase: last material stage in display order.
    let phaseLinkStage = null;
    for (let i = display.length - 1; i >= 0; i--) {
      const m = display[i];
      if (
        (m.public_status === "matched" || m.public_status === "ambiguous") &&
        linkAllowedStages.has(m.stage)
      ) {
        phaseLinkStage = m.stage;
        break;
      }
    }

    return {
      id,
      short: PROCUREMENT_PHASE_META[id].short,
      label_key: PROCUREMENT_PHASE_META[id].label_key,
      action_key: PROCUREMENT_PHASE_META[id].action_key,
      state,
      event_count: display.length,
      total_count: all.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      aggregates: aggregatePhaseMilestones(display),
      milestones: display,
      all_milestones: all,
      phase_link_stage: phaseLinkStage,
      source_families: linkDedupe.families,
      source_links_dropped: linkDedupe.dropped,
    };
  });

  let nextPhase = null;
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (phases[i].state === "future") {
      nextPhase = phases[i];
      break;
    }
  }

  const currentMilestone = stageKey
    ? timeline.find((e) => e.stage === stageKey) || null
    : null;

  // Count duplicate source-family occurrences across the whole timeline (pre-dedupe).
  const familyCounts = {};
  for (const e of timeline) {
    const fam = sourceFamily(e?.source);
    if (!fam) continue;
    familyCounts[fam] = (familyCounts[fam] || 0) + 1;
  }
  const duplicateLinkCandidates = Object.values(familyCounts).reduce(
    (n, c) => n + Math.max(0, c - 1),
    0,
  );

  return {
    schema_version: PROCUREMENT_PHASE_SPINE_SCHEMA_VERSION,
    pin: clean(data?.pin) || null,
    pin_strategy: clean(data?.pin_strategy) || null,
    no_pin: noPin,
    current: {
      phase_id: currentPhaseId,
      label_key: PROCUREMENT_PHASE_META[currentPhaseId]?.label_key || "lifecycle_phase_solicitation",
      action_key: PROCUREMENT_PHASE_META[currentPhaseId]?.action_key || "lifecycle_phase_action_respond",
      stage: stageKey,
      milestone_label: currentMilestone ? milestoneTitle(currentMilestone) : null,
      since: currentMilestone
        ? isoDate(currentMilestone.date || currentMilestone.source_timestamp)
        : null,
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
    event_count: timeline.length,
    duplicate_link_candidates: duplicateLinkCandidates,
    amendments: Array.isArray(data?.amendments) ? data.amendments : [],
    rfx_detail: data?.rfx_detail || null,
    ocp_award: data?.ocp_award || null,
  };
}
