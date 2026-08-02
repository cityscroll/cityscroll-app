/**
 * Property disposition timeline — phase presentation over the process spine.
 *
 * Pure view model over disposition stages (hearing → auction_or_rfp →
 * award_or_conveyance): compact stepper, current + next, one action lead.
 * Same shape as land_phase_spine / procurement_phase_spine. Does not invent
 * events — empty stages stay class-(a) not_yet_ingested slots.
 *
 * Presentation (HTML) lives in site/index.html propertyDispositionSpineHTML.
 */

export const PROPERTY_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered disposition phases (1:1 with DISPOSITION_STAGES process kinds). */
export const PROPERTY_DISPOSITION_PHASES = Object.freeze([
  "hearing",
  "auction_or_rfp",
  "award_or_conveyance",
]);

export const PROPERTY_PHASE_META = Object.freeze({
  hearing: {
    id: "hearing",
    short: "Hear",
    label_key: "disposition_stage_hearing",
    action_key: "disposition_phase_action_attend",
  },
  auction_or_rfp: {
    id: "auction_or_rfp",
    short: "Bid",
    label_key: "disposition_stage_auction_or_rfp",
    action_key: "disposition_phase_action_bid",
  },
  award_or_conveyance: {
    id: "award_or_conveyance",
    short: "Award",
    label_key: "disposition_stage_award_or_conveyance",
    action_key: "disposition_phase_action_conveyance",
  },
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

/**
 * Map a process stage kind onto a presentation phase id.
 * @param {string} kind
 */
export function dispositionStageToPhase(kind) {
  const k = clean(kind);
  if (k && PROPERTY_PHASE_META[k]) return k;
  return null;
}

/**
 * Derive current phase = latest matched stage in process order; next = first unmatched after.
 * @param {object} spine — buildPropertyDispositionSpine result
 * @returns {object|null}
 */
export function buildPropertyPhaseView(spine) {
  if (!spine || typeof spine !== "object") return null;
  const stages = Array.isArray(spine.stages) ? spine.stages : [];
  if (!stages.length && !Array.isArray(spine.events)) return null;

  const byKind = new Map(stages.map((s) => [s.kind, s]));
  const phases = PROPERTY_DISPOSITION_PHASES.map((id) => {
    const meta = PROPERTY_PHASE_META[id];
    const stage = byKind.get(id) || {
      kind: id,
      matched: false,
      notice_count: 0,
      request_ids: [],
      events: [],
    };
    const events = Array.isArray(stage.events) ? stage.events : [];
    const primary = events[0] || null;
    return {
      id,
      short: meta.short,
      label_key: meta.label_key,
      action_key: meta.action_key,
      matched: !!stage.matched,
      notice_count: stage.notice_count || events.length || 0,
      request_ids: stage.request_ids || [],
      events,
      primary: primary
        ? {
            request_id: primary.request_id || null,
            title: clean(primary.title),
            when: isoDate(primary.time?.value || primary.when) || null,
            source_url: primary.source?.url || null,
            status: primary.status || null,
          }
        : null,
      status: stage.matched ? "matched" : "not_yet_ingested",
    };
  });

  // Current = last matched in order; if none, first phase.
  let currentIdx = -1;
  for (let i = 0; i < phases.length; i++) {
    if (phases[i].matched) currentIdx = i;
  }
  if (currentIdx < 0) currentIdx = 0;
  const current = phases[currentIdx];
  let next = null;
  for (let i = currentIdx + 1; i < phases.length; i++) {
    if (!phases[i].matched) {
      next = phases[i];
      break;
    }
  }
  // If current is unmatched (empty spine), next is the first unmatched after first.
  if (!current.matched) {
    next = phases.find((p, i) => i > 0 && !p.matched) || null;
  }

  const matchedCount = phases.filter((p) => p.matched).length;

  return {
    schema_version: PROPERTY_PHASE_SPINE_SCHEMA_VERSION,
    subject_ref: spine.subject_ref || null,
    join: spine.join || null,
    phases,
    current: current || null,
    next: next || null,
    action: current
      ? {
          phase_id: current.id,
          action_key: current.action_key,
          when: current.primary?.when || null,
          request_id: current.primary?.request_id || null,
        }
      : null,
    metrics: {
      phase_count: phases.length,
      matched_count: matchedCount,
      fill_rate: phases.length ? matchedCount / phases.length : 0,
    },
    gaps: spine.gaps || [],
  };
}
