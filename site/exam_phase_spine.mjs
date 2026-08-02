/**
 * Civil-service exam process timeline — phase presentation over the process spine.
 *
 * Pure view model over exam stages (application → list_establishment →
 * certification → appointment): compact stepper, current + next, one action lead.
 * Same shape as site/franchise_phase_spine.mjs / site/property_phase_spine.mjs.
 * Does not invent events — empty stages stay class-(a) not_yet_ingested slots.
 *
 * Presentation (HTML) lives in site/index.html examProcessSpineHTML.
 */

import { EXAM_PROCESS_STAGES } from "./exam_process_spine.mjs";

export const EXAM_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered exam hiring phases (1:1 with EXAM_PROCESS_STAGES). */
export const EXAM_PHASES = Object.freeze([...EXAM_PROCESS_STAGES]);

export const EXAM_PHASE_META = Object.freeze({
  application: {
    id: "application",
    short: "Apply",
    label_key: "exam_stage_application",
    action_key: "exam_phase_action_application",
  },
  list_establishment: {
    id: "list_establishment",
    short: "List",
    label_key: "exam_stage_list_establishment",
    action_key: "exam_phase_action_list_establishment",
  },
  certification: {
    id: "certification",
    short: "Certify",
    label_key: "exam_stage_certification",
    action_key: "exam_phase_action_certification",
  },
  appointment: {
    id: "appointment",
    short: "Hire",
    label_key: "exam_stage_appointment",
    action_key: "exam_phase_action_appointment",
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

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map a process stage kind onto a presentation phase id.
 * @param {string} kind
 */
export function examStageToPhase(kind) {
  const k = clean(kind);
  if (k && EXAM_PHASE_META[k]) return k;
  return null;
}

/**
 * Collapse verbatim-identical titles within one phase.
 * @param {object[]} events
 */
export function aggregatePhaseEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    const title = clean(event.title) || clean(event.exam_number) || "—";
    const key = normalizeKey(title) || `__empty_${map.size}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  const out = [];
  for (const group of map.values()) {
    const dates = group
      .map((e) => isoDate(e.time?.value || e.when))
      .filter(Boolean)
      .sort();
    out.push({
      title: clean(group[0].title) || clean(group[0].exam_number) || "—",
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      members: group,
    });
  }
  out.sort((a, b) => String(a.first || "9999").localeCompare(String(b.first || "9999")));
  return out;
}

/**
 * Dedupe identical source URLs within a phase to a single outbound link.
 * @param {object[]} events
 */
export function dedupePhaseSourceLinks(events) {
  const urls = (events || [])
    .map((e) => clean(e.source?.url) || clean(e.source_url) || null)
    .filter(Boolean);
  const unique = new Map();
  for (const u of urls) {
    const key = u.replace(/\/+$/, "").toLowerCase();
    if (!unique.has(key)) unique.set(key, u);
  }
  const first = unique.size ? [...unique.values()][0] : null;
  return {
    url: first,
    count: unique.size,
    candidates: urls.length,
  };
}

/**
 * Derive current phase = latest matched stage in process order; next = first unmatched after.
 * @param {object} spine — buildExamProcessSpine result
 * @returns {object|null}
 */
export function buildExamPhaseView(spine) {
  if (!spine || typeof spine !== "object") return null;
  const stages = Array.isArray(spine.stages) ? spine.stages : [];
  if (!stages.length && !Array.isArray(spine.events)) return null;

  const byKind = new Map(stages.map((s) => [s.kind, s]));
  const phases = EXAM_PHASES.map((id) => {
    const meta = EXAM_PHASE_META[id];
    const stage = byKind.get(id) || {
      kind: id,
      matched: false,
      count: null,
      events: [],
      detail: null,
    };
    const events = Array.isArray(stage.events) ? stage.events : [];
    const primary = events[0] || null;
    const aggregates = aggregatePhaseEvents(events);
    const source = dedupePhaseSourceLinks(events);
    const whenFrom = primary?.time?.value || null;
    const whenTo = primary?.time?.value_to || null;
    return {
      id,
      short: meta.short,
      label_key: meta.label_key,
      action_key: meta.action_key,
      matched: !!stage.matched,
      count: stage.count ?? primary?.count ?? null,
      events,
      aggregates,
      source_url: source.url,
      source_link_count: source.count,
      detail: stage.detail || null,
      primary: primary
        ? {
            exam_number: primary.exam_number || spine.exam_number || null,
            title: clean(primary.title),
            when: isoDate(whenFrom) || null,
            when_to: isoDate(whenTo) || null,
            count: primary.count ?? stage.count ?? null,
            source_url: primary.source?.url || primary.source_url || source.url || null,
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
  if (!current.matched) {
    next = phases.find((p, i) => i > 0 && !p.matched) || null;
  }

  const matchedCount = phases.filter((p) => p.matched).length;

  return {
    schema_version: EXAM_PHASE_SPINE_SCHEMA_VERSION,
    subject_ref: spine.subject_ref || null,
    exam_number: spine.exam_number || null,
    join: spine.join || null,
    phases,
    current: current || null,
    next: next || null,
    action: current
      ? {
          phase_id: current.id,
          action_key: current.action_key,
          when: current.primary?.when || null,
          when_to: current.primary?.when_to || null,
          exam_number: current.primary?.exam_number || spine.exam_number || null,
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
