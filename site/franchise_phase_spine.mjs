/**
 * Franchise / concession (FCRC) timeline — phase presentation over the process spine.
 *
 * Pure view model over franchise stages (solicitation → public_hearing →
 * committee_meeting → award): compact stepper, current + next, one action lead.
 * Same shape as site/property_phase_spine.mjs and site/land_phase_spine.mjs.
 * Does not invent events — empty stages stay class-(a) not_yet_ingested slots.
 *
 * Presentation (HTML) lives in site/index.html franchiseConcessionSpineHTML.
 */

export const FRANCHISE_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered franchise/concession phases (1:1 with FRANCHISE_CONCESSION_STAGES). */
export const FRANCHISE_PHASES = Object.freeze([
  "solicitation",
  "public_hearing",
  "committee_meeting",
  "award",
]);

export const FRANCHISE_PHASE_META = Object.freeze({
  solicitation: {
    id: "solicitation",
    short: "Solicit",
    label_key: "franchise_stage_solicitation",
    action_key: "franchise_phase_action_solicitation",
  },
  public_hearing: {
    id: "public_hearing",
    short: "Hear",
    label_key: "franchise_stage_public_hearing",
    action_key: "franchise_phase_action_public_hearing",
  },
  committee_meeting: {
    id: "committee_meeting",
    short: "Meet",
    label_key: "franchise_stage_committee_meeting",
    action_key: "franchise_phase_action_committee_meeting",
  },
  award: {
    id: "award",
    short: "Award",
    label_key: "franchise_stage_award",
    action_key: "franchise_phase_action_award",
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
export function franchiseStageToPhase(kind) {
  const k = clean(kind);
  if (k && FRANCHISE_PHASE_META[k]) return k;
  return null;
}

/**
 * Collapse verbatim-identical titles within one phase. Keeps every member so
 * dates stay recoverable under disclosure when the UI needs them.
 * @param {object[]} events
 */
export function aggregatePhaseEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    const title = clean(event.title) || clean(event.request_id) || "—";
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
      title: clean(group[0].title) || clean(group[0].request_id) || "—",
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
 * @param {object} spine — buildFranchiseConcessionSpine result
 * @returns {object|null}
 */
export function buildFranchisePhaseView(spine) {
  if (!spine || typeof spine !== "object") return null;
  const stages = Array.isArray(spine.stages) ? spine.stages : [];
  if (!stages.length && !Array.isArray(spine.events)) return null;

  const byKind = new Map(stages.map((s) => [s.kind, s]));
  const phases = FRANCHISE_PHASES.map((id) => {
    const meta = FRANCHISE_PHASE_META[id];
    const stage = byKind.get(id) || {
      kind: id,
      matched: false,
      notice_count: 0,
      request_ids: [],
      events: [],
    };
    const events = Array.isArray(stage.events) ? stage.events : [];
    const primary = events[0] || null;
    const aggregates = aggregatePhaseEvents(events);
    const source = dedupePhaseSourceLinks(events);
    return {
      id,
      short: meta.short,
      label_key: meta.label_key,
      action_key: meta.action_key,
      matched: !!stage.matched,
      notice_count: stage.notice_count || events.length || 0,
      request_ids: stage.request_ids || [],
      events,
      aggregates,
      source_url: source.url,
      source_link_count: source.count,
      primary: primary
        ? {
            request_id: primary.request_id || null,
            title: clean(primary.title),
            when: isoDate(primary.time?.value || primary.when) || null,
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
  // If current is unmatched (empty spine), next is the first unmatched after first.
  if (!current.matched) {
    next = phases.find((p, i) => i > 0 && !p.matched) || null;
  }

  const matchedCount = phases.filter((p) => p.matched).length;

  return {
    schema_version: FRANCHISE_PHASE_SPINE_SCHEMA_VERSION,
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
