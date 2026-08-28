/**
 * Source-backed outcome transitions for Action Path continuations.
 *
 * This is a pure read projection. It compares a stable civic subject's
 * materialized state and exposes only a consequential event that the source
 * actually records. It never records resident behavior, creates a source
 * record, or broadens a continuation scope.
 */

export const CIVIC_OUTCOME_TRANSITION_SCHEMA = "cityscroll.civic_outcome_transition.v1";
export const CIVIC_OUTCOME_STATES = Object.freeze([
  "unknown",
  "proposed",
  "hearing",
  "comment-closed",
  "adopted",
  "effective",
  "agenda",
  "action",
  "vote",
]);

const RULE_STATE_RANK = Object.freeze({
  unknown: 0,
  proposed: 1,
  hearing: 2,
  "comment-closed": 3,
  adopted: 4,
  effective: 5,
});

const MATTER_STATE_RANK = Object.freeze({ unknown: 0, agenda: 1, action: 2, vote: 3 });
function text(value, max = 2_000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function day(value) {
  const match = text(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function httpsUrl(value) {
  try {
    const url = new URL(text(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function sourceEvidence({ source_ref = null, source_url = null, basis = null } = {}) {
  const ref = text(source_ref, 240) || null;
  const url = httpsUrl(source_url);
  if (!ref && !url) return [];
  return [{
    source_ref: ref,
    source_url: url,
    basis: text(basis, 500) || "retained publisher outcome",
  }];
}

function occurred(event, asOf) {
  if (!event) return false;
  if (event.status === "occurred") return true;
  const eventDay = day(event.valid_at || event.published_at);
  const clock = day(asOf);
  return Boolean(eventDay && clock && eventDay <= clock && event.status !== "scheduled");
}

function ruleEvent(record, type, asOf) {
  const events = Array.isArray(record?.events) ? record.events : [];
  return events
    .filter((event) => event?.event_type === type && occurred(event, asOf))
    .sort((left, right) => String(day(left.valid_at || left.published_at) || "").localeCompare(String(day(right.valid_at || right.published_at) || "")))
    .at(-1) || null;
}

function rulemakingSubject(record) {
  return text(record?.subject_ref || record?.rulemaking_subject_ref || record?.rulemaking_id, 700) || null;
}

/**
 * Project the current state of a retained rulemaking. Adoption and effective
 * are the only rule events eligible to become post-event transitions.
 */
export function projectRulemakingOutcomeSnapshot(record = {}, { asOf = null, sourceRef = null } = {}) {
  const subjectRef = rulemakingSubject(record);
  if (!subjectRef) return { subject_ref: null, state: "unknown", outcome_state: "not_yet_known", event: null, evidence: [] };
  const effective = ruleEvent(record, "effective", asOf);
  const adoption = ruleEvent(record, "adoption", asOf);
  const event = effective || adoption;
  const state = effective ? "effective" : adoption ? "adopted" : (() => {
    const stage = text(record.stage || record.fine_stage).toLowerCase();
    if (stage === "effective") return "effective";
    if (stage === "adopted") return "adopted";
    if (stage === "hearing") return "hearing";
    if (stage === "comment-open") return "hearing";
    if (stage === "comment-closed") return "comment-closed";
    return "proposed";
  })();
  const sourceUrl = event?.source_url || record?.nyc_rules?.url || record?.source_url;
  const ref = sourceRef || event?.source_ref || event?.request_id || record?.request_id;
  const evidence = event
    ? sourceEvidence({ source_ref: ref, source_url: sourceUrl, basis: `rules event ${event.event_type}` })
    : [];
  const recorded = Boolean(event && evidence.length);
  return {
    schema: CIVIC_OUTCOME_TRANSITION_SCHEMA,
    subject_ref: subjectRef,
    state,
    outcome_state: recorded ? "recorded" : "not_yet_known",
    event: recorded ? {
      type: event.event_type,
      valid_at: day(event.valid_at || event.published_at),
      source_ref: ref || null,
      source_url: httpsUrl(sourceUrl),
    } : null,
    evidence,
  };
}

function matterFromRecord(record, subjectRef) {
  const matters = Array.isArray(record?.matters)
    ? record.matters
    : Array.isArray(record?.agenda_items)
      ? record.agenda_items.flatMap((item) => item?.matters || [])
      : [];
  const wanted = subjectRef ? text(subjectRef, 240).replace(/^matter:/, "") : null;
  if (wanted) return matters.find((matter) => String(matter?.matter_id || "") === wanted) || null;
  return matters.length === 1 ? matters[0] : null;
}

/** Project the retained Council matter action/vote outcome, if any. */
export function projectCouncilMatterOutcomeSnapshot(record = {}, { subjectRef = null } = {}) {
  const matter = matterFromRecord(record, subjectRef);
  const matterId = text(matter?.matter_id, 240);
  const stableRef = subjectRef || (matterId ? `matter:${matterId}` : null);
  if (!stableRef || record?.snapshot_state !== "present" || !matter) {
    return { schema: CIVIC_OUTCOME_TRANSITION_SCHEMA, subject_ref: stableRef, state: "unknown", outcome_state: "not_yet_known", event: null, evidence: [] };
  }
  const actions = Array.isArray(matter.actions) ? matter.actions.filter(Boolean) : [];
  const votes = Array.isArray(matter.votes) ? matter.votes.filter(Boolean) : [];
  const vote = votes.at(-1) || null;
  const action = text(matter.outcome || actions.at(-1), 500) || null;
  const result = text(vote?.result, 500) || null;
  const type = result ? "vote" : action ? "action" : null;
  const value = result || action;
  if (!type || !value) {
    return { schema: CIVIC_OUTCOME_TRANSITION_SCHEMA, subject_ref: stableRef, state: "agenda", outcome_state: "not_yet_known", event: null, evidence: [] };
  }
  const sourceRef = text(record.request_id, 240) ? `meeting:city_record:${text(record.request_id, 240)}` : null;
  const sourceUrl = record?.event?.url || record?.source_url || matter?.matter_url;
  const evidence = sourceEvidence({ source_ref: sourceRef, source_url: sourceUrl, basis: `Council matter ${type} recorded outcome` });
  if (!evidence.length) {
    return { schema: CIVIC_OUTCOME_TRANSITION_SCHEMA, subject_ref: stableRef, state: type, outcome_state: "not_yet_known", event: null, evidence: [] };
  }
  return {
    schema: CIVIC_OUTCOME_TRANSITION_SCHEMA,
    subject_ref: stableRef,
    state: type,
    outcome_state: "recorded",
    event: { type, value, source_ref: sourceRef, source_url: httpsUrl(sourceUrl) },
    evidence,
  };
}

function stateRank(state, kind) {
  return (kind === "rulemaking" ? RULE_STATE_RANK : MATTER_STATE_RANK)[state] ?? 0;
}

function eventIdentity(event) {
  if (!event) return null;
  return [event.type, event.value || "", event.valid_at || "", event.source_ref || ""].join(":");
}

export function outcomeTransitionKey(subjectRef, snapshot) {
  const identity = eventIdentity(snapshot?.event);
  return identity ? `civic-outcome:${subjectRef}:${identity}` : null;
}

/**
 * Compare two snapshots. A recorded current event is a transition when it is
 * new or advances the subject. Same-state refreshes have no transition.
 */
export function projectCivicOutcomeTransition({ subject_ref: subjectRef, previous = null, current = null, kind = "rulemaking" } = {}) {
  const subject = text(subjectRef || current?.subject_ref || previous?.subject_ref, 700) || null;
  const base = {
    schema: CIVIC_OUTCOME_TRANSITION_SCHEMA,
    subject_ref: subject,
    outcome_state: current?.outcome_state === "recorded" ? "recorded" : "not_yet_known",
    current_state: current?.state || "unknown",
    transition: null,
    evidence: Array.isArray(current?.evidence) ? current.evidence : [],
  };
  if (!subject || current?.outcome_state !== "recorded" || !current?.event) return base;
  const priorRank = stateRank(previous?.state, kind);
  const currentRank = stateRank(current.state, kind);
  const sameEvent = eventIdentity(previous?.event) === eventIdentity(current.event);
  if (sameEvent || currentRank < priorRank) return base;
  const transitionKey = outcomeTransitionKey(subject, current);
  return {
    ...base,
    transition: {
      transition_key: transitionKey,
      from: { state: previous?.state || "unknown" },
      to: { state: current.state, value: current.event.value || null },
      event: current.event,
    },
  };
}

/**
 * One-shot reconciliation for an exact rules follow. The source row remains
 * the delivery row; only its bounded outcome decoration is added.
 */
export function reconcileRulemakingOutcomeRows({ rows = [], rulesView = null, seen = new Set(), asOf = null } = {}) {
  const records = Array.isArray(rulesView?.rules) ? rulesView.rules : [];
  const byId = new Map(records.map((record) => [String(record?.request_id || ""), record]));
  const groups = new Map();
  for (const record of records) {
    const subject = rulemakingSubject(record);
    if (!subject) continue;
    const bucket = groups.get(subject) || [];
    bucket.push(record);
    groups.set(subject, bucket);
  }
  const candidates = [];
  const used = new Set();
  for (const row of rows || []) {
    const record = byId.get(String(row?.request_id || ""));
    const subject = rulemakingSubject(record);
    if (!subject || used.has(subject)) continue;
    used.add(subject);
    const aggregate = (groups.get(subject) || []).reduce((merged, item) => ({
      ...merged,
      ...item,
      events: [...(merged.events || []), ...(item.events || [])],
      nyc_rules: merged.nyc_rules || item.nyc_rules,
    }), {});
    const eventRecord = (groups.get(subject) || []).find((item) =>
      (item.events || []).some((event) => event?.event_type === "adoption" || event?.event_type === "effective"),
    ) || record;
    const current = projectRulemakingOutcomeSnapshot(aggregate, { asOf, sourceRef: eventRecord?.request_id });
    const transition = projectCivicOutcomeTransition({ subject_ref: subject, current, kind: "rulemaking" });
    if (!transition.transition || seen.has(transition.transition.transition_key)) continue;
    const deliveryRow = rows.find((candidate) => String(candidate?.request_id || "") === String(eventRecord?.request_id || "")) || row;
    candidates.push({
      row: { ...deliveryRow, post_event_outcome: transition },
      transition_key: transition.transition.transition_key,
    });
  }
  return {
    rows: candidates.map((candidate) => candidate.row),
    markSeenIds: candidates.map((candidate) => candidate.transition_key),
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

export function renderCivicOutcomeTransition(outcome) {
  const transition = outcome?.transition;
  if (outcome?.outcome_state !== "recorded" || !transition?.event) return "";
  const event = transition.event;
  const labels = {
    adoption: "Rulemaking adopted",
    effective: "Rulemaking effective",
    action: "Council action recorded",
    vote: "Council vote recorded",
  };
  const value = event.value ? `: ${escapeHtml(event.value)}` : "";
  const dateText = event.valid_at ? ` on ${escapeHtml(event.valid_at)}` : "";
  const source = outcome.evidence?.[0]?.source_url
    ? ` <a href="${escapeHtml(outcome.evidence[0].source_url)}">Source</a>`
    : "";
  return `<div class="civic-outcome-transition" data-civic-outcome="recorded"><strong>Update:</strong> ${escapeHtml(labels[event.type] || "Outcome recorded")}${value}${dateText}.${source}</div>`;
}

export const projectRulemakingOutcome = projectRulemakingOutcomeSnapshot;
export const projectCouncilMatterOutcome = projectCouncilMatterOutcomeSnapshot;
