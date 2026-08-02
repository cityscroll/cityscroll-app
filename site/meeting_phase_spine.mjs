/**
 * Council matter vote spine — phase grouping view model.
 *
 * Pure view model over server-stamped `spines[]` stages
 * (agenda → matter → action → vote → attachment). Presentation phases
 * (scout Target 4 / TIME axis):
 *   agenda    → agenda
 *   matter    → matter
 *   decision  → action + vote  (empty vote with action = voice/committee, not a gap)
 *   record    → attachment
 *
 * Same presentation shape as site/rules_phase_spine.mjs and
 * site/land_phase_spine.mjs: lead → stepper → phase panels → disclosure.
 * Does not invent stages, roll-call votes, or Legistar documents.
 *
 * Presentation (HTML) lives in site/index.html meetingOutcomesHTML /
 * meetingMatterPhaseHTML. Multi-action history still collapses via
 * collapseMeetingAgenda — this module only shapes one matter's spine.
 */

export const MEETING_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered presentation phases for one Council matter. */
export const MEETING_MATTER_PHASES = Object.freeze([
  "agenda",
  "matter",
  "decision",
  "record",
]);

export const MEETING_PHASE_META = Object.freeze({
  agenda: {
    id: "agenda",
    short: "Agenda",
    label_key: "meeting_phase_agenda",
    action_key: "meeting_phase_action_agenda",
  },
  matter: {
    id: "matter",
    short: "Matter",
    label_key: "meeting_phase_matter",
    action_key: "meeting_phase_action_matter",
  },
  decision: {
    id: "decision",
    short: "Decision",
    label_key: "meeting_phase_decision",
    action_key: "meeting_phase_action_decision",
  },
  record: {
    id: "record",
    short: "Record",
    label_key: "meeting_phase_record",
    action_key: "meeting_phase_action_record",
  },
});

/** Server spine stage kinds in path order. */
export const MEETING_STAGE_KINDS = Object.freeze([
  "agenda",
  "matter",
  "action",
  "vote",
  "attachment",
]);

/** Stage kind → presentation phase. */
export const STAGE_TO_PHASE = Object.freeze({
  agenda: "agenda",
  matter: "matter",
  action: "decision",
  vote: "decision",
  attachment: "record",
});

export const STAGE_ORDER = Object.freeze({
  agenda: 0,
  matter: 1,
  action: 2,
  vote: 3,
  attachment: 4,
});

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map a spine stage kind to a presentation phase id.
 * @param {string|null|undefined} kind
 * @returns {string}
 */
export function mapStageToPhase(kind) {
  const id = clean(kind);
  if (id && STAGE_TO_PHASE[id]) return STAGE_TO_PHASE[id];
  return "agenda";
}

/**
 * Normalize a URL for equality (strip trailing slash, lowercase).
 * @param {string|null|undefined} url
 */
export function normalizeSourceUrl(url) {
  const s = String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  return s || null;
}

/**
 * Dedupe identical document URLs within a phase / spine.
 * @param {object[]} documents
 * @returns {{ documents: object[], count: number, candidates: number }}
 */
export function dedupeDocuments(documents) {
  const unique = new Map();
  const list = Array.isArray(documents) ? documents : [];
  for (const doc of list) {
    if (!doc || !doc.url) continue;
    const key = normalizeSourceUrl(doc.url);
    if (!key) continue;
    if (!unique.has(key)) unique.set(key, doc);
  }
  return {
    documents: [...unique.values()],
    count: unique.size,
    candidates: list.filter((d) => d && d.url).length,
  };
}

/**
 * Collapse verbatim-identical action labels (multi-action history).
 * Keeps every member so history stays recoverable under disclosure.
 * @param {string[]} actions
 */
export function aggregateActionLabels(actions) {
  const map = new Map();
  for (const raw of actions || []) {
    const label = clean(raw);
    if (!label) continue;
    const key = normalizeKey(label) || `__empty_${map.size}`;
    if (!map.has(key)) map.set(key, { label, count: 0, members: [] });
    const row = map.get(key);
    row.count += 1;
    row.members.push(label);
  }
  return [...map.values()];
}

/**
 * Whether a stage is "filled" for phase progress.
 * Vote is special: empty roll-call with a matched action is voice/committee
 * (not a missing stage) — decision still counts as filled via action.
 * @param {object|null|undefined} stage
 * @param {object|null|undefined} actionStage
 */
export function stageIsMaterial(stage, actionStage) {
  if (!stage) return false;
  if (stage.matched) return true;
  if (stage.kind === "vote" && actionStage?.matched) return true;
  return false;
}

/**
 * Index stages by kind from one spine (first wins per kind).
 * @param {object|null|undefined} spine
 * @returns {Record<string, object|null>}
 */
export function stagesByKind(spine) {
  const out = Object.fromEntries(MEETING_STAGE_KINDS.map((k) => [k, null]));
  for (const stage of Array.isArray(spine?.stages) ? spine.stages : []) {
    const kind = clean(stage?.kind);
    if (!kind || !(kind in out)) continue;
    if (!out[kind]) out[kind] = stage;
  }
  return out;
}

/**
 * Merge multiple spines for the same matter (multi-action Legistar rows).
 * Prefer last matched action/vote; union documents by URL.
 * @param {object[]} spines
 */
export function mergeMatterSpines(spines) {
  const list = (Array.isArray(spines) ? spines : []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const byKind = Object.fromEntries(MEETING_STAGE_KINDS.map((k) => [k, null]));
  const actionHistory = [];
  let subjectRef = null;
  let eventId = null;
  let agendaItemId = null;
  let matterId = null;

  for (const spine of list) {
    if (!subjectRef && spine.subject_ref) subjectRef = spine.subject_ref;
    if (!eventId && spine.event_id) eventId = spine.event_id;
    if (!agendaItemId && spine.agenda_item_id) agendaItemId = spine.agenda_item_id;
    if (!matterId && spine.matter_id) matterId = spine.matter_id;
    for (const stage of Array.isArray(spine.stages) ? spine.stages : []) {
      const kind = clean(stage?.kind);
      if (!kind || !(kind in byKind)) continue;
      if (kind === "action" && stage.matched && stage.action_name) {
        actionHistory.push(stage.action_name);
      }
      // Prefer later matched stage; for unmatched keep first shell.
      if (!byKind[kind] || (stage.matched && !byKind[kind].matched) || stage.matched) {
        byKind[kind] = stage;
      }
    }
  }

  // Union documents across attachment stages.
  const docs = [];
  for (const spine of list) {
    const att = (spine.stages || []).find((s) => s?.kind === "attachment");
    for (const d of Array.isArray(att?.documents) ? att.documents : []) {
      if (d && d.url) docs.push(d);
    }
  }
  const deduped = dedupeDocuments(docs);
  if (byKind.attachment) {
    byKind.attachment = {
      ...byKind.attachment,
      matched: deduped.count > 0,
      documents: deduped.documents,
    };
  }

  const stages = MEETING_STAGE_KINDS.map((kind) => {
    return (
      byKind[kind] || {
        kind,
        matched: false,
      }
    );
  });
  const matchedCount = stages.filter((s) => s.matched).length;
  return {
    schema_version: list[0].schema_version || MEETING_PHASE_SPINE_SCHEMA_VERSION,
    subject_ref: subjectRef,
    event_id: eventId,
    agenda_item_id: agendaItemId,
    matter_id: matterId,
    stages,
    stage_fill: stages.length ? matchedCount / stages.length : 0,
    matched_stages: matchedCount,
    total_stages: stages.length,
    full: matchedCount === stages.length,
    _action_history: actionHistory,
  };
}

/**
 * Index server spines by matter_id / matter_file for collapsed list join.
 * @param {object[]} spines
 * @returns {Map<string, object[]>}
 */
export function indexSpinesByMatter(spines) {
  const map = new Map();
  for (const spine of Array.isArray(spines) ? spines : []) {
    if (!spine) continue;
    const matterStage = (spine.stages || []).find((s) => s?.kind === "matter");
    const keys = [
      clean(spine.matter_id),
      clean(matterStage?.matter_id),
      clean(matterStage?.matter_file),
    ].filter(Boolean);
    if (!keys.length) continue;
    // One list per primary key; cross-index aliases so file or id lookup works.
    const primary = keys[0];
    if (!map.has(primary)) map.set(primary, []);
    map.get(primary).push(spine);
    for (const k of keys.slice(1)) {
      if (!map.has(k)) map.set(k, map.get(primary));
    }
  }
  return map;
}

/**
 * Build a synthetic spine from a collapseMeetingAgenda entry when spines[]
 * is missing (fallback for older payloads / hermetic unit fixtures).
 * @param {object} entry - collapsed matter entry
 * @param {object} [opts]
 * @param {object[]} [opts.eventDocuments]
 * @param {string|null} [opts.eventId]
 */
export function spineFromCollapsedEntry(entry, opts = {}) {
  const eventDocs = Array.isArray(opts.eventDocuments) ? opts.eventDocuments : [];
  const matterDocs = Array.isArray(entry?.documents) ? entry.documents : [];
  const docs = dedupeDocuments([...matterDocs, ...eventDocs]).documents;
  const votes = Array.isArray(entry?.finalVotes) ? entry.finalVotes : [];
  const actionName =
    clean(entry?.finalOutcome) ||
    clean(entry?.finalPassed) ||
    clean(entry?.status) ||
    (Array.isArray(entry?.actions) && entry.actions.length
      ? clean(entry.actions[entry.actions.length - 1])
      : null);
  const matterId = clean(entry?.matter_id);
  const agendaTitle = clean(entry?.agendaTitle);
  const agendaNumber = clean(entry?.agendaNumber);

  const stages = [
    {
      kind: "agenda",
      matched: Boolean(agendaTitle || agendaNumber),
      agenda_item_id: null,
      agenda_number: agendaNumber,
      title: agendaTitle,
      body_text: null,
    },
    {
      kind: "matter",
      matched: Boolean(matterId),
      matter_id: matterId,
      matter_file: clean(entry?.matter_file),
      matter_url: clean(entry?.matter_url),
      title: clean(entry?.title),
      status: clean(entry?.status),
    },
    {
      kind: "action",
      matched: Boolean(actionName),
      action_name: actionName,
      action_text: null,
      passed: clean(entry?.finalPassed),
    },
    {
      kind: "vote",
      matched: votes.length > 0,
      votes,
      result: votes[0]?.result ?? null,
      counts: votes[0]?.counts ?? null,
      by_person: votes[0]?.by_person ?? [],
    },
    {
      kind: "attachment",
      matched: docs.length > 0,
      documents: docs,
    },
  ];
  const matchedCount = stages.filter((s) => s.matched).length;
  return {
    schema_version: MEETING_PHASE_SPINE_SCHEMA_VERSION,
    subject_ref: matterId ? `matter:${matterId}` : null,
    event_id: clean(opts.eventId),
    agenda_item_id: null,
    matter_id: matterId,
    stages,
    stage_fill: stages.length ? matchedCount / stages.length : 0,
    matched_stages: matchedCount,
    total_stages: stages.length,
    full: matchedCount === stages.length,
    _action_history: Array.isArray(entry?.actions) ? entry.actions.slice() : [],
  };
}

/**
 * Build phase-grouped Council matter spine view model.
 *
 * @param {object|null|undefined} spine - one entry from record.spines[]
 *   (or mergeMatterSpines / spineFromCollapsedEntry output)
 * @param {object} [opts]
 * @param {string[]} [opts.actionHistory] - multi-action labels from collapse
 * @param {object|null} [opts.collapsed] - collapseMeetingAgenda entry (enrichment)
 */
export function buildMeetingMatterPhaseView(spine, opts = {}) {
  if (!spine || !Array.isArray(spine.stages)) {
    return {
      schema_version: MEETING_PHASE_SPINE_SCHEMA_VERSION,
      empty: true,
      matter_id: null,
      phases: MEETING_MATTER_PHASES.map((id) => ({
        id,
        short: MEETING_PHASE_META[id].short,
        label_key: MEETING_PHASE_META[id].label_key,
        action_key: MEETING_PHASE_META[id].action_key,
        state: id === "agenda" ? "current" : "future",
        matched: false,
        stages: [],
        aggregates: [],
        documents: [],
        source_url: null,
        source_link_count: 0,
        source_link_candidates: 0,
        gap_class: null,
        voice_vote: false,
      })),
      current: {
        phase_id: "agenda",
        label_key: "meeting_phase_agenda",
        action_key: "meeting_phase_action_agenda",
        lead_action: "none",
        milestone_label: null,
      },
      next: { phase_id: "matter", label_key: "meeting_phase_matter", short: "Matter" },
      stage_fill: 0,
      full: false,
      official_url: null,
      action_history: [],
      action_aggregates: [],
    };
  }

  const byKind = stagesByKind(spine);
  const actionStage = byKind.action;
  const voteStage = byKind.vote;
  const matterStage = byKind.matter;
  const agendaStage = byKind.agenda;
  const attachmentStage = byKind.attachment;

  const actionHistory = [
    ...(Array.isArray(opts.actionHistory) ? opts.actionHistory : []),
    ...(Array.isArray(spine._action_history) ? spine._action_history : []),
    ...(Array.isArray(opts.collapsed?.actions) ? opts.collapsed.actions : []),
  ]
    .map(clean)
    .filter(Boolean);
  // Prefer explicit history; fall back to single action_name.
  if (!actionHistory.length && actionStage?.action_name) {
    actionHistory.push(actionStage.action_name);
  }
  const actionAggregates = aggregateActionLabels(actionHistory);

  const byPhase = Object.fromEntries(MEETING_MATTER_PHASES.map((id) => [id, []]));
  for (const kind of MEETING_STAGE_KINDS) {
    const stage = byKind[kind];
    if (!stage) continue;
    const phaseId = mapStageToPhase(kind);
    byPhase[phaseId].push(stage);
  }

  // Current = last phase that has material stages (decision fills via action or vote).
  let lastMaterialIdx = -1;
  for (let i = 0; i < MEETING_MATTER_PHASES.length; i++) {
    const id = MEETING_MATTER_PHASES[i];
    const list = byPhase[id] || [];
    const material = list.some((s) => stageIsMaterial(s, actionStage));
    if (material) lastMaterialIdx = i;
  }
  const currentPhaseId =
    lastMaterialIdx >= 0 ? MEETING_MATTER_PHASES[lastMaterialIdx] : "agenda";

  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = MEETING_MATTER_PHASES.indexOf(id);
    const cur = MEETING_MATTER_PHASES.indexOf(currentPhaseId);
    const list = byPhase[id] || [];
    const material = list.some((s) => stageIsMaterial(s, actionStage));
    if (material || idx < cur) return "passed";
    return "future";
  }

  function phaseMatched(id) {
    const list = byPhase[id] || [];
    return list.some((s) => stageIsMaterial(s, actionStage));
  }

  const phases = MEETING_MATTER_PHASES.map((id) => {
    const state = phaseState(id);
    const stages = (byPhase[id] || []).slice().sort((a, b) => {
      const oa = STAGE_ORDER[a.kind] ?? 99;
      const ob = STAGE_ORDER[b.kind] ?? 99;
      return oa - ob;
    });
    const matched = phaseMatched(id);

    // Gap class for empty slots — never invent data.
    // Vote empty with action matched is voice, not class-(a).
    let gapClass = null;
    let voiceVote = false;
    if (id === "decision") {
      const actionMatched = Boolean(actionStage?.matched);
      const voteMatched = Boolean(voteStage?.matched);
      if (actionMatched && !voteMatched) voiceVote = true;
      if (!actionMatched && !voteMatched) gapClass = "not_yet_ingested";
    } else if (id === "record") {
      if (!attachmentStage?.matched) gapClass = "not_yet_ingested";
    } else if (id === "agenda") {
      if (!agendaStage?.matched) gapClass = "not_yet_ingested";
    } else if (id === "matter") {
      if (!matterStage?.matched) gapClass = "not_yet_ingested";
    }

    const docs =
      id === "record"
        ? dedupeDocuments(attachmentStage?.documents || [])
        : { documents: [], count: 0, candidates: 0 };

    // Aggregate repeated action labels under decision phase.
    const aggregates =
      id === "decision"
        ? actionAggregates.map((a) => ({
            title: a.label,
            count: a.count,
            members: a.members,
            kind: "action",
          }))
        : stages
            .filter((s) => s.matched)
            .map((s) => ({
              title:
                clean(s.title) ||
                clean(s.action_name) ||
                clean(s.matter_file) ||
                clean(s.kind) ||
                "—",
              count: 1,
              members: [s],
              kind: s.kind,
            }));

    // Source link: matter legislation URL preferred; attachment first doc as fallback.
    let sourceUrl = null;
    let sourceCandidates = 0;
    let sourceCount = 0;
    if (id === "matter" || id === "agenda") {
      sourceUrl = clean(matterStage?.matter_url);
      sourceCandidates = sourceUrl ? 1 : 0;
      sourceCount = sourceUrl ? 1 : 0;
    } else if (id === "record") {
      sourceUrl = docs.documents[0]?.url || null;
      sourceCandidates = docs.candidates;
      sourceCount = docs.count;
    } else if (id === "decision") {
      // No inventing roll-call source URLs; matter file is the outbound for outcomes.
      sourceUrl = clean(matterStage?.matter_url);
      sourceCandidates = sourceUrl ? 1 : 0;
      sourceCount = sourceUrl ? 1 : 0;
    }

    const actionName =
      clean(actionStage?.action_name) ||
      (actionHistory.length ? actionHistory[actionHistory.length - 1] : null);
    const voteResult =
      clean(voteStage?.result) ||
      (Array.isArray(voteStage?.votes) && voteStage.votes[0]
        ? clean(voteStage.votes[0].result)
        : null);

    return {
      id,
      short: MEETING_PHASE_META[id].short,
      label_key: MEETING_PHASE_META[id].label_key,
      action_key: MEETING_PHASE_META[id].action_key,
      state,
      matched,
      stages,
      stage_count: stages.length,
      event_count: stages.filter((s) => stageIsMaterial(s, actionStage)).length,
      aggregates,
      documents: docs.documents,
      source_url: sourceUrl,
      source_link_count: sourceCount,
      source_link_candidates: sourceCandidates,
      gap_class: matched ? null : gapClass,
      voice_vote: voiceVote,
      action_name: id === "decision" ? actionName : null,
      vote_result: id === "decision" ? voteResult : null,
      votes: id === "decision" ? (voteStage?.votes || (voteMatchedList(voteStage))) : [],
      counts: id === "decision" ? (voteStage?.counts || voteStage?.votes?.[0]?.counts || null) : null,
      by_person:
        id === "decision"
          ? voteStage?.by_person || voteStage?.votes?.[0]?.by_person || []
          : [],
      agenda_number: id === "agenda" ? clean(agendaStage?.agenda_number) : null,
      agenda_title: id === "agenda" ? clean(agendaStage?.title) : null,
      matter_file: id === "matter" ? clean(matterStage?.matter_file) : null,
      matter_title: id === "matter" ? clean(matterStage?.title) : null,
      matter_status: id === "matter" ? clean(matterStage?.status) : null,
      matter_url: clean(matterStage?.matter_url),
    };
  });

  const curIdx = MEETING_MATTER_PHASES.indexOf(currentPhaseId);
  let nextPhase = null;
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (phases[i].state === "future") {
      nextPhase = phases[i];
      break;
    }
  }

  const matterUrl = clean(matterStage?.matter_url) || clean(opts.collapsed?.matter_url);
  const voteMatched = Boolean(voteStage?.matched);
  const actionMatched = Boolean(actionStage?.matched);
  const attachmentMatched = Boolean(attachmentStage?.matched);

  // Lead action priority: open legislation → view tally → view outcome → docs → agenda.
  let leadAction = "none";
  if (matterUrl) leadAction = "open_legislation";
  else if (voteMatched) leadAction = "view_tally";
  else if (actionMatched) leadAction = "view_outcome";
  else if (attachmentMatched) leadAction = "view_docs";
  else if (agendaStage?.matched) leadAction = "read_agenda";

  const currentPhase = phases.find((p) => p.id === currentPhaseId);
  let milestoneLabel = null;
  if (currentPhaseId === "decision") {
    milestoneLabel =
      clean(voteStage?.result) ||
      clean(actionStage?.action_name) ||
      (actionHistory.length ? actionHistory[actionHistory.length - 1] : null);
  } else if (currentPhaseId === "matter") {
    milestoneLabel =
      clean(matterStage?.matter_file) ||
      clean(matterStage?.title) ||
      clean(matterStage?.status);
  } else if (currentPhaseId === "agenda") {
    milestoneLabel =
      clean(agendaStage?.title) ||
      (agendaStage?.agenda_number ? `#${agendaStage.agenda_number}` : null);
  } else if (currentPhaseId === "record") {
    const n = currentPhase?.documents?.length || 0;
    milestoneLabel = n ? String(n) : null;
  }

  const matchedStages = MEETING_STAGE_KINDS.filter((k) => byKind[k]?.matched).length;

  return {
    schema_version: MEETING_PHASE_SPINE_SCHEMA_VERSION,
    empty: false,
    matter_id: clean(spine.matter_id) || clean(matterStage?.matter_id),
    matter_file: clean(matterStage?.matter_file) || clean(opts.collapsed?.matter_file),
    matter_title: clean(matterStage?.title) || clean(opts.collapsed?.title),
    subject_ref: clean(spine.subject_ref),
    event_id: clean(spine.event_id),
    official_url: matterUrl,
    stage_fill:
      typeof spine.stage_fill === "number"
        ? spine.stage_fill
        : matchedStages / MEETING_STAGE_KINDS.length,
    full: Boolean(spine.full) || matchedStages === MEETING_STAGE_KINDS.length,
    matched_stages: matchedStages,
    total_stages: MEETING_STAGE_KINDS.length,
    current: {
      phase_id: currentPhaseId,
      label_key: MEETING_PHASE_META[currentPhaseId].label_key,
      action_key: MEETING_PHASE_META[currentPhaseId].action_key,
      lead_action: leadAction,
      milestone_label: milestoneLabel,
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
        }
      : null,
    phases,
    action_history: actionHistory,
    action_aggregates: actionAggregates,
    stages: spine.stages,
  };
}

function voteMatchedList(voteStage) {
  if (!voteStage) return [];
  if (Array.isArray(voteStage.votes)) return voteStage.votes;
  if (voteStage.matched && (voteStage.counts || voteStage.result)) {
    return [
      {
        result: voteStage.result,
        counts: voteStage.counts,
        by_person: voteStage.by_person || [],
      },
    ];
  }
  return [];
}

/**
 * Resolve a phase view for one collapsed matter entry given the record's spines[].
 * @param {object} entry - collapseMeetingAgenda entry
 * @param {object} record - meeting-outcomes record
 */
export function buildPhaseViewForMatter(entry, record) {
  const spines = Array.isArray(record?.spines) ? record.spines : [];
  const index = indexSpinesByMatter(spines);
  const keys = [
    clean(entry?.matter_id),
    clean(entry?.matter_file),
  ].filter(Boolean);
  let matched = [];
  for (const k of keys) {
    if (index.has(k)) {
      matched = index.get(k) || [];
      break;
    }
  }
  const eventDocs = Array.isArray(record?.council_event?.documents)
    ? record.council_event.documents
    : [];
  const merged = matched.length
    ? mergeMatterSpines(matched)
    : spineFromCollapsedEntry(entry, {
        eventDocuments: eventDocs,
        eventId: record?.council_event?.event_id,
      });
  return buildMeetingMatterPhaseView(merged, {
    collapsed: entry,
    actionHistory: Array.isArray(entry?.actions) ? entry.actions : [],
  });
}
