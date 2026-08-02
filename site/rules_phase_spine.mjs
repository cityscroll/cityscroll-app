/**
 * Rules event spine — phase grouping view model.
 *
 * Pure view model over deriveRuleEvents rows: group the five distinct events
 * under four canonical rulemaking phases, aggregate verbatim-repeated titles
 * within a phase, and dedupe identical outbound source URLs to one per phase.
 *
 * Phases (scout Target 3 / TIME axis):
 *   proposal       → proposal_published
 *   public_process → public_hearing + comment_close  (never collapse comment_close)
 *   adoption       → adoption
 *   effective      → effective
 *
 * Multi-notice stitch (scout Target 6): when the /rules materialization stamps
 * high-confidence related_notices + rulemaking_subject_ref, merge sibling City
 * Record notices into one lifecycle for the public lens. Ambiguous joins stay
 * separate — never invent siblings.
 *
 * Same presentation shape as site/land_phase_spine.mjs and
 * site/procurement_phase_spine.mjs: lead → stepper → phase panels → disclosure.
 * Does not invent CAPA/rulemaking stages absent from the read model.
 *
 * Presentation (HTML) lives in site/index.html ruleEventSpineHTML.
 */

export const RULES_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered rulemaking phases. */
export const RULES_PHASES = Object.freeze([
  "proposal",
  "public_process",
  "adoption",
  "effective",
]);

export const RULES_PHASE_META = Object.freeze({
  proposal: {
    id: "proposal",
    short: "Propose",
    label_key: "rule_phase_proposal",
    action_key: "rule_phase_action_proposal",
  },
  public_process: {
    id: "public_process",
    short: "Public",
    label_key: "rule_phase_public_process",
    action_key: "rule_phase_action_public_process",
  },
  adoption: {
    id: "adoption",
    short: "Adopt",
    label_key: "rule_phase_adoption",
    action_key: "rule_phase_action_adoption",
  },
  effective: {
    id: "effective",
    short: "Effect",
    label_key: "rule_phase_effective",
    action_key: "rule_phase_action_effective",
  },
});

/** Event type → phase id. Unknown types fall into proposal (earliest). */
export const EVENT_TO_PHASE = Object.freeze({
  proposal_published: "proposal",
  public_hearing: "public_process",
  comment_close: "public_process",
  adoption: "adoption",
  effective: "effective",
});

/** Display order of event types within a phase (and across the spine). */
export const EVENT_ORDER = Object.freeze({
  proposal_published: 0,
  public_hearing: 1,
  comment_close: 2,
  adoption: 3,
  effective: 4,
});

/** Canonical event types in spine order (matches RULE_EVENT_CFG / deriveRuleEvents). */
export const RULE_EVENT_TYPES = Object.freeze([
  "proposal_published",
  "public_hearing",
  "comment_close",
  "adoption",
  "effective",
]);

export const RULE_EVENT_META = Object.freeze({
  proposal_published: {
    type: "proposal_published",
    label_key: "rule_event_proposal",
    date_label_key: "rule_event_published_on_html",
  },
  public_hearing: {
    type: "public_hearing",
    label_key: "rule_event_hearing",
    date_label_key: "rule_event_scheduled_for_html",
  },
  comment_close: {
    type: "comment_close",
    label_key: "rule_event_comment_close",
    date_label_key: "rule_event_due_on_html",
  },
  adoption: {
    type: "adoption",
    label_key: "rule_event_adoption",
    date_label_key: "rule_event_recorded_on_html",
  },
  effective: {
    type: "effective",
    label_key: "rule_event_effective",
    date_label_key: "rule_event_starts_on_html",
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
 * Map a rule event_type to a phase id.
 * @param {string|null|undefined} eventType
 * @returns {string}
 */
export function mapEventToPhase(eventType) {
  const id = clean(eventType);
  if (id && EVENT_TO_PHASE[id]) return EVENT_TO_PHASE[id];
  return "proposal";
}

/**
 * Prefer valid_at; adoption uses published_at when valid_at is null.
 * @param {object|null|undefined} event
 */
export function eventDate(event) {
  if (!event) return null;
  return isoDate(event.valid_at) || isoDate(event.published_at) || null;
}

/**
 * Collapse verbatim-identical titles (or same event_type) within one phase.
 * Keeps every member so dates stay recoverable under disclosure.
 * @param {object[]} events
 */
export function aggregatePhaseEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    const type = clean(event.event_type) || "";
    const title =
      clean(event.title) ||
      (type && RULE_EVENT_META[type] ? RULE_EVENT_META[type].label_key : null) ||
      type ||
      "—";
    const key = `${type}::${normalizeKey(title)}` || `__empty_${map.size}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  const out = [];
  for (const group of map.values()) {
    const dates = group
      .map((e) => eventDate(e))
      .filter(Boolean)
      .sort();
    const statuses = [
      ...new Set(group.map((e) => clean(e.status) || "—").filter(Boolean)),
    ];
    const type = clean(group[0].event_type) || null;
    const meta = type && RULE_EVENT_META[type] ? RULE_EVENT_META[type] : null;
    out.push({
      event_type: type,
      title: clean(group[0].title) || (meta ? meta.label_key : type) || "—",
      label_key: meta?.label_key || null,
      date_label_key: meta?.date_label_key || null,
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      statuses,
      members: group,
    });
  }
  out.sort((a, b) => {
    const oa = EVENT_ORDER[a.event_type] ?? 99;
    const ob = EVENT_ORDER[b.event_type] ?? 99;
    if (oa !== ob) return oa - ob;
    return String(a.first || "9999").localeCompare(String(b.first || "9999"));
  });
  return out;
}

/**
 * Normalize a URL for equality (strip trailing slash, lowercase host path).
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
 * Dedupe identical source URLs within a phase to a single outbound link.
 * @param {object[]} events
 * @returns {{ url: string|null, count: number, candidates: number }}
 */
export function dedupePhaseSourceLinks(events) {
  const urls = (events || [])
    .map((e) => clean(e.source_url) || clean(e.source?.url) || null)
    .filter(Boolean);
  const unique = new Map();
  for (const u of urls) {
    const key = normalizeSourceUrl(u);
    if (!key) continue;
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
 * Whether event has a real date / is present in the spine (not a gap slot).
 * @param {object|null|undefined} event
 */
export function eventIsMaterial(event) {
  if (!event) return false;
  if (eventDate(event)) return true;
  // Adoption can be status-occurred with published_at only (already covered) or
  // status-occurred without a calendar day — still material when present.
  if (event.event_type === "adoption" && event.status === "occurred") return true;
  return false;
}

function eventIsScheduled(event) {
  return event && event.status === "scheduled";
}

function eventIsOccurred(event) {
  return event && (event.status === "occurred" || (!eventIsScheduled(event) && eventIsMaterial(event)));
}

/** Stage progression for multi-notice “best stage” pick (later wins). */
const STAGE_RANK = Object.freeze({
  unknown: 0,
  proposed: 1,
  "comment-open": 2,
  hearing: 3,
  "comment-closed": 4,
  adopted: 5,
  effective: 6,
});

const ROLE_TO_EVENT = Object.freeze({
  proposal: "proposal_published",
  hearing: "public_hearing",
  adoption: "adoption",
});

const ROLE_LABEL_KEY = Object.freeze({
  proposal: "rule_sibling_role_proposal",
  hearing: "rule_sibling_role_hearing",
  adoption: "rule_sibling_role_adoption",
  notice: "rule_sibling_role_notice",
});

/**
 * True when the materialization join is a high-confidence multi-notice stitch.
 * Ambiguous / singleton / no-request_id rows must not pull siblings.
 * @param {object|null|undefined} rec
 */
export function isConfidentMultiNoticeRulemaking(rec) {
  const j = rec?.rulemaking_join;
  if (!j || j.matched !== true) return false;
  if (j.confidence !== "high") return false;
  return (j.notice_count || 0) > 1;
}

/**
 * True when a related_notices entry may be shown / merged.
 * Requires high-confidence pair join when present; otherwise falls back to a
 * high-confidence multi-notice parent join (backend always stamps pair join
 * when matched, so the fallback is defensive).
 * @param {object|null|undefined} rel
 * @param {object|null|undefined} parentJoin
 */
export function isConfidentRelatedNotice(rel, parentJoin = null) {
  if (!rel || !clean(rel.request_id)) return false;
  const j = rel.join;
  if (j && typeof j === "object") {
    return j.matched === true && j.confidence === "high";
  }
  return (
    parentJoin?.matched === true
    && parentJoin.confidence === "high"
    && (parentJoin.notice_count || 0) > 1
  );
}

function cityRecordNoticeUrl(requestId) {
  const id = clean(requestId);
  if (!id) return null;
  return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
}

function statusForDate(iso, nowIso) {
  const d = isoDate(iso);
  if (!d) return "occurred";
  const now = isoDate(nowIso) || new Date().toISOString().slice(0, 10);
  return d > now ? "scheduled" : "occurred";
}

/**
 * Build a minimal spine event from a related_notices role + date when the
 * sibling’s full materialization row is missing or event-empty.
 * @param {object} rel - related_notices entry
 * @param {object} [opts]
 */
export function eventFromRelatedNotice(rel, opts = {}) {
  if (!rel) return null;
  const role = clean(rel.role) || "notice";
  const type = ROLE_TO_EVENT[role];
  if (!type) return null;
  const dateRaw =
    type === "public_hearing"
      ? (rel.event_date || rel.notice_date)
      : rel.notice_date;
  const day = isoDate(dateRaw);
  if (!day && type !== "adoption") return null;
  const now = opts.now || null;
  const sourceUrl = cityRecordNoticeUrl(rel.request_id);
  const status = statusForDate(day, now);
  const event = {
    event_type: type,
    valid_at: type === "adoption" ? null : (day || null),
    published_at: type === "adoption" ? (day || null) : null,
    source_url: sourceUrl,
    source_field: type === "public_hearing" && rel.event_date
      ? "city_record.event_date"
      : "city_record.notice_date",
    source_system: "city_record",
    status: type === "adoption" ? "occurred" : status,
    request_id: clean(rel.request_id) || null,
    title: clean(rel.title) || null,
    from_related_notice: true,
  };
  if (type === "adoption" && day) {
    // Prefer a calendar day for phase dating when we only have notice_date.
    event.valid_at = day;
  }
  return event;
}

/**
 * Dedupe-key for spine events (type + calendar day + source).
 * @param {object} event
 */
export function eventMergeKey(event) {
  const type = clean(event?.event_type) || "";
  const day = eventDate(event) || "";
  const src = normalizeSourceUrl(event?.source_url || event?.source?.url) || "";
  return `${type}::${day}::${src}`;
}

/**
 * Merge event lists: first wins per type+date+source; prefers richer status.
 * @param {...object[]} lists
 */
export function mergeRulemakingEvents(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const event of list || []) {
      if (!event || !clean(event.event_type)) continue;
      const key = eventMergeKey(event);
      if (!map.has(key)) {
        map.set(key, event);
        continue;
      }
      // Prefer scheduled when same key collides (actionable); else keep first.
      const prev = map.get(key);
      if (prev.status !== "scheduled" && event.status === "scheduled") {
        map.set(key, event);
      }
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => {
    const oa = EVENT_ORDER[a.event_type] ?? 99;
    const ob = EVENT_ORDER[b.event_type] ?? 99;
    if (oa !== ob) return oa - ob;
    return String(eventDate(a) || "").localeCompare(String(eventDate(b) || ""));
  });
  return out;
}

function pickRicherNycRules(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const score = (nr) => {
    if (!nr) return 0;
    let n = 0;
    for (const k of [
      "url", "comment_url", "comment_by_date", "hearing_date",
      "adoption_published_at", "effective_date", "guid", "summary",
    ]) {
      if (nr[k]) n += 1;
    }
    return n;
  };
  return score(b) > score(a) ? b : a;
}

function pickLaterStage(a, b) {
  const ra = STAGE_RANK[clean(a) || ""] ?? 0;
  const rb = STAGE_RANK[clean(b) || ""] ?? 0;
  return rb > ra ? b : a;
}

/**
 * Sibling notice chip for the public rules lens (self + confident related).
 * @param {object} entry
 * @param {boolean} isSelf
 */
function siblingChip(entry, isSelf) {
  const role = clean(entry?.role) || "notice";
  return {
    request_id: clean(entry?.request_id) || null,
    role,
    role_label_key: ROLE_LABEL_KEY[role] || ROLE_LABEL_KEY.notice,
    title: clean(entry?.title) || null,
    notice_date: isoDate(entry?.notice_date) || null,
    event_date: isoDate(entry?.event_date) || null,
    stage: clean(entry?.stage) || null,
    is_self: !!isSelf,
  };
}

/**
 * Merge high-confidence multi-notice rulemaking siblings into one lifecycle
 * record for the public rules lens. Ambiguous notices pass through unchanged.
 *
 * @param {object|null|undefined} rec - focal /rules row
 * @param {Map<string, object>|object|null} [recordsById] - request_id → full row
 * @param {object} [opts]
 * @param {string|null} [opts.now] - ISO date for scheduled vs occurred
 * @returns {object|null}
 */
export function stitchRulemakingRecord(rec, recordsById = null, opts = {}) {
  if (!rec || typeof rec !== "object") return rec || null;

  const map = recordsById instanceof Map
    ? recordsById
    : recordsById && typeof recordsById === "object"
      ? new Map(Object.entries(recordsById))
      : new Map();

  if (!isConfidentMultiNoticeRulemaking(rec)) {
    return {
      ...rec,
      events: Array.isArray(rec.events) ? rec.events.slice() : [],
      multi_notice: false,
      sibling_notices: [],
      stitched: false,
    };
  }

  const parentJoin = rec.rulemaking_join || null;
  const related = (Array.isArray(rec.related_notices) ? rec.related_notices : [])
    .filter((rel) => isConfidentRelatedNotice(rel, parentJoin));

  const selfId = clean(rec.request_id);
  const eventLists = [Array.isArray(rec.events) ? rec.events : []];
  let nycRules = rec.nyc_rules || null;
  let stage = rec.stage || null;
  let joinMatched = !!(rec.join?.matched || nycRules);
  const siblingChips = [];

  // Self chip first.
  siblingChips.push(siblingChip({
    request_id: selfId,
    role: parentJoin?.role || "notice",
    title: rec.title || rec.city_record?.title || rec.city_record?.short_title,
    notice_date: rec.notice_date || rec.city_record?.notice_date,
    event_date: rec.city_record?.event_date || null,
    stage: rec.stage,
  }, true));

  for (const rel of related) {
    const rid = clean(rel.request_id);
    if (!rid || rid === selfId) continue;
    siblingChips.push(siblingChip(rel, false));

    const full = map.get(rid) || null;
    if (full && Array.isArray(full.events) && full.events.length) {
      eventLists.push(full.events);
    } else {
      const synthesized = eventFromRelatedNotice(rel, opts);
      if (synthesized) eventLists.push([synthesized]);
    }
    if (full) {
      nycRules = pickRicherNycRules(nycRules, full.nyc_rules);
      stage = pickLaterStage(stage, full.stage);
      if (full.join?.matched || full.nyc_rules) joinMatched = true;
    }
  }

  let merged = mergeRulemakingEvents(...eventLists);

  // Fill role-dated gaps from self + related_notices when a sibling contributes
  // later stages but an earlier City Record notice still has no spine event
  // (common when proposal/adoption rows never joined NYC Rules RSS).
  const roleSources = [
    {
      request_id: selfId,
      role: parentJoin?.role || "notice",
      title: rec.title || rec.city_record?.title || rec.city_record?.short_title,
      notice_date: rec.notice_date || rec.city_record?.notice_date || rec.city_record?.start_date,
      event_date: rec.city_record?.event_date || rec.event_date || null,
    },
    ...related,
  ];
  for (const src of roleSources) {
    const type = ROLE_TO_EVENT[clean(src.role) || ""];
    if (!type) continue;
    if (merged.some((e) => clean(e.event_type) === type)) continue;
    const synth = eventFromRelatedNotice(src, opts);
    if (synth) merged = mergeRulemakingEvents(merged, [synth]);
  }

  return {
    ...rec,
    events: merged,
    nyc_rules: nycRules,
    stage: stage || rec.stage,
    join: {
      ...(rec.join || {}),
      // Preserve original NYC Rules join; surface multi-notice stitch separately.
      multi_notice_stitched: true,
      matched: joinMatched || !!(rec.join?.matched),
    },
    rulemaking_subject_ref: rec.rulemaking_subject_ref || null,
    related_notices: related,
    multi_notice: true,
    sibling_notices: siblingChips,
    stitched: true,
    notice_count: parentJoin?.notice_count || siblingChips.length,
  };
}

/**
 * Build phase-grouped rules event spine view model.
 *
 * @param {object|null|undefined} rec - rules materialization row for one notice
 *   (events[], nyc_rules, stage, join, request_id, related_notices?)
 * @param {object} [opts]
 * @param {string|null} [opts.now] - ISO date override for tests (YYYY-MM-DD)
 * @param {Map|object|null} [opts.recordsById] - optional sibling lookup for stitch
 * @param {boolean} [opts.skipStitch] - when true, use rec.events as-is
 */
export function buildRulesPhaseView(rec, opts = {}) {
  const stitched = opts.skipStitch
    ? rec
    : stitchRulemakingRecord(rec, opts.recordsById || null, opts);
  const base = stitched || rec || {};
  const events = Array.isArray(base?.events) ? base.events.slice() : [];
  const nr = base?.nyc_rules || null;
  const joined = !!(nr || base?.join?.matched);
  const officialUrl =
    clean(nr?.url) ||
    clean(nr?.comment_url) ||
    clean(events.find((e) => e?.source_url)?.source_url) ||
    null;
  const commentUrl = clean(nr?.comment_url) || officialUrl;
  const requestId = clean(base?.request_id) || null;

  // Index material events by type (first wins; multi-notice stitch keeps all in phase arrays).
  const byType = Object.fromEntries(RULE_EVENT_TYPES.map((t) => [t, []]));
  for (const event of events) {
    const type = clean(event?.event_type);
    if (!type || !byType[type]) continue;
    byType[type].push(event);
  }

  const byPhase = Object.fromEntries(RULES_PHASES.map((id) => [id, []]));
  for (const type of RULE_EVENT_TYPES) {
    const phaseId = mapEventToPhase(type);
    for (const event of byType[type]) {
      (byPhase[phaseId] || byPhase.proposal).push(event);
    }
  }

  // Current = last phase that has material events, preferring a phase with scheduled
  // (actionable) events when one exists at or after the last-occurred phase.
  let lastOccurredIdx = -1;
  let firstScheduledIdx = -1;
  for (let i = 0; i < RULES_PHASES.length; i++) {
    const id = RULES_PHASES[i];
    const list = byPhase[id] || [];
    if (list.some(eventIsOccurred)) lastOccurredIdx = i;
    if (firstScheduledIdx < 0 && list.some(eventIsScheduled)) firstScheduledIdx = i;
  }

  let currentPhaseId;
  if (firstScheduledIdx >= 0) {
    // Actionable upcoming step wins (comment open / hearing scheduled).
    currentPhaseId = RULES_PHASES[firstScheduledIdx];
  } else if (lastOccurredIdx >= 0) {
    currentPhaseId = RULES_PHASES[lastOccurredIdx];
  } else {
    // No material events — stay on proposal (gap state).
    currentPhaseId = "proposal";
  }

  // Optional stage hint from list-view classifier when it points at a later phase.
  const stageHint = clean(base?.stage);
  if (stageHint) {
    const stageToPhase = {
      proposed: "proposal",
      "comment-open": "public_process",
      hearing: "public_process",
      "comment-closed": "public_process",
      adopted: "adoption",
      effective: "effective",
    };
    const hinted = stageToPhase[stageHint];
    if (hinted) {
      const hintIdx = RULES_PHASES.indexOf(hinted);
      const curIdx = RULES_PHASES.indexOf(currentPhaseId);
      // Prefer scheduled-derived current; only advance when no scheduled and stage is later.
      if (firstScheduledIdx < 0 && hintIdx > curIdx) currentPhaseId = hinted;
    }
  }

  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = RULES_PHASES.indexOf(id);
    const cur = RULES_PHASES.indexOf(currentPhaseId);
    const list = byPhase[id] || [];
    if (list.some(eventIsMaterial)) {
      if (idx < cur) return "passed";
      // Material after current (data quirk) still counts as passed for history.
      return "passed";
    }
    if (idx < cur) return "passed";
    return "future";
  }

  const phases = RULES_PHASES.map((id) => {
    const state = phaseState(id);
    const all = (byPhase[id] || []).slice().sort((a, b) => {
      const oa = EVENT_ORDER[a.event_type] ?? 99;
      const ob = EVENT_ORDER[b.event_type] ?? 99;
      if (oa !== ob) return oa - ob;
      return String(eventDate(a) || "").localeCompare(String(eventDate(b) || ""));
    });
    const aggregates = aggregatePhaseEvents(all);
    const dates = all
      .map((e) => eventDate(e))
      .filter(Boolean)
      .sort();
    const source = dedupePhaseSourceLinks(all);
    // Expected event types in this phase (for gap rendering of missing slots).
    const expectedTypes = RULE_EVENT_TYPES.filter((t) => mapEventToPhase(t) === id);
    const presentTypes = new Set(all.map((e) => e.event_type).filter(Boolean));
    const missingTypes = expectedTypes.filter((t) => !presentTypes.has(t));

    return {
      id,
      short: RULES_PHASE_META[id].short,
      label_key: RULES_PHASE_META[id].label_key,
      action_key: RULES_PHASE_META[id].action_key,
      state,
      event_count: all.length,
      total_count: all.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      aggregates,
      events: all,
      all_events: all,
      expected_types: expectedTypes,
      missing_types: missingTypes,
      source_url: source.url,
      source_link_count: source.count,
      source_link_candidates: source.candidates,
      has_scheduled: all.some(eventIsScheduled),
      has_occurred: all.some(eventIsOccurred),
    };
  });

  const curIdx = RULES_PHASES.indexOf(currentPhaseId);
  let nextPhase = null;
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (phases[i].state === "future") {
      nextPhase = phases[i];
      break;
    }
  }

  // Lead action: comment if open (scheduled comment_close), else hearing if scheduled,
  // else read official page for current phase.
  const commentClose = (byType.comment_close || [])[0] || null;
  const publicHearing = (byType.public_hearing || [])[0] || null;
  let leadAction = "read";
  let leadEvent = null;
  if (commentClose && eventIsScheduled(commentClose)) {
    leadAction = "comment";
    leadEvent = commentClose;
  } else if (publicHearing && eventIsScheduled(publicHearing)) {
    leadAction = "hearing";
    leadEvent = publicHearing;
  } else {
    const curPhase = phases.find((p) => p.id === currentPhaseId);
    leadEvent = (curPhase?.events || [])[0] || null;
  }

  const currentPhase = phases.find((p) => p.id === currentPhaseId);
  const milestoneEvent =
    leadEvent ||
    (currentPhase?.events || []).find(eventIsScheduled) ||
    (currentPhase?.events || [])[currentPhase?.events?.length - 1] ||
    null;
  const milestoneType = clean(milestoneEvent?.event_type) || null;
  const milestoneMeta = milestoneType ? RULE_EVENT_META[milestoneType] : null;

  // Total identical source URL candidates across all events (dedupe proof).
  const allSourceCandidates = events
    .map((e) => clean(e.source_url) || clean(e.source?.url))
    .filter(Boolean);
  const allSourceUnique = new Set(allSourceCandidates.map(normalizeSourceUrl).filter(Boolean));

  const siblingNotices = Array.isArray(base?.sibling_notices)
    ? base.sibling_notices
    : [];
  const multiNotice = !!base?.multi_notice && siblingNotices.length > 1;

  return {
    schema_version: RULES_PHASE_SPINE_SCHEMA_VERSION,
    request_id: requestId,
    joined,
    official_url: officialUrl,
    comment_url: commentUrl,
    current: {
      phase_id: currentPhaseId,
      label_key: RULES_PHASE_META[currentPhaseId]?.label_key || "rule_phase_proposal",
      action_key: RULES_PHASE_META[currentPhaseId]?.action_key || "rule_phase_action_proposal",
      milestone_label_key: milestoneMeta?.label_key || null,
      milestone_event_type: milestoneType,
      since: eventDate(milestoneEvent),
      lead_action: leadAction,
      stage: stageHint || null,
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
        }
      : null,
    phases,
    chronological: events.slice().sort((a, b) => {
      const oa = EVENT_ORDER[a.event_type] ?? 99;
      const ob = EVENT_ORDER[b.event_type] ?? 99;
      if (oa !== ob) return oa - ob;
      return String(eventDate(a) || "").localeCompare(String(eventDate(b) || ""));
    }),
    event_count: events.length,
    source_link_candidates: allSourceCandidates.length,
    source_link_unique: allSourceUnique.size,
    stage: stageHint || null,
    nyc_rules: nr,
    // Multi-notice public surface (only when join confidently holds).
    multi_notice: multiNotice,
    rulemaking_subject_ref: clean(base?.rulemaking_subject_ref) || null,
    related_notices: Array.isArray(base?.related_notices) ? base.related_notices : [],
    sibling_notices: siblingNotices,
    notice_count: multiNotice
      ? (base?.notice_count || siblingNotices.length)
      : 1,
    stitched: !!base?.stitched && multiNotice,
  };
}
