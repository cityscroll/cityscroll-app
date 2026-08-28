import { objectCardInteractionProjection } from "./affordance_grammar.mjs";

function text(value) {
  return String(value ?? "").trim();
}

/**
 * CAPA lifecycle states used by the rulemaking action matrix. These are
 * deliberately separate from the older list-view stage values (comment-open
 * and hearing), which describe individual observations rather than the whole
 * proceeding.
 */
export const RULEMAKING_LIFECYCLE_STATES = Object.freeze([
  "proposed",
  "comment_hearing_open",
  "comment_closed_awaiting_action",
  "adopted",
  "effective",
]);

function isoDay(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function eventDay(events, type) {
  const event = (Array.isArray(events) ? events : [])
    .filter((candidate) => candidate?.event_type === type)
    .map((candidate) => ({
      day: isoDay(candidate.valid_at) || isoDay(candidate.published_at),
      status: text(candidate.status).toLowerCase(),
    }))
    .find((candidate) => candidate.day);
  return event || null;
}

function firstDay(...values) {
  return values.map(isoDay).find(Boolean) || null;
}

function dateIsFuture(day, now) {
  if (!day || !now) return false;
  const today = isoDay(now);
  return Boolean(today && day > today);
}

function dateIsPastOrToday(day, now) {
  if (!day || !now) return false;
  const today = isoDay(now);
  return Boolean(today && day <= today);
}

function dateIsScheduled(day, event, now) {
  if (event?.status === "scheduled") return true;
  if (event?.status === "occurred") return false;
  if (day && !now) return true;
  return dateIsFuture(day, now);
}

function sourceUrl(value) {
  const href = text(value);
  if (!/^https:\/\//i.test(href)) return null;
  try {
    const parsed = new URL(href, "https://cityscroll.org");
    return /^https?:$/.test(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

function sourceDocumentUrl(sourceDocuments, predicate) {
  for (const document of Array.isArray(sourceDocuments) ? sourceDocuments : []) {
    if (!predicate(document)) continue;
    const href = sourceUrl(document.source_url) || sourceUrl(document.url) || sourceUrl(document.href);
    if (href) return href;
  }
  return null;
}

function action({ id, label, href, kind = "document", primary = false, date = null } = {}) {
  const destination = sourceUrl(href);
  if (!destination || !text(label)) return null;
  return {
    id,
    label: text(label),
    href: destination,
    kind,
    primary,
    context_ready: true,
    source_url: destination,
    ...(date ? { date } : {}),
  };
}

function internalAction({ id, label, href, kind = "follow", primary = false } = {}) {
  const destination = text(href);
  if (!destination || !text(label)) return null;
  return {
    id,
    label: text(label),
    href: destination,
    kind,
    primary,
    context_ready: true,
  };
}

function actionLabels({ commentLabel, hearingLabel } = {}) {
  return {
    comment: text(commentLabel) || "Comment",
    hearing: text(hearingLabel) || "Attend hearing",
  };
}

/**
 * Derive the current CAPA state from dated source observations. A supplied
 * `now` enables date comparison; without it, scheduled/occurred event status
 * and the legacy stage hint preserve list-card compatibility.
 */
export function deriveRulemakingLifecycleState({
  fine_stage = null,
  stage = null,
  nyc_rules = null,
  events = [],
  now = null,
} = {}) {
  const rules = nyc_rules && typeof nyc_rules === "object" ? nyc_rules : {};
  const adoptionEvent = eventDay(events, "adoption");
  const effectiveEvent = eventDay(events, "effective");
  const commentEvent = eventDay(events, "comment_close");
  const hearingEvent = eventDay(events, "public_hearing");
  const effectiveDate = firstDay(rules.effective_date, effectiveEvent?.day);
  const adoptionDate = firstDay(rules.adoption_published_at, adoptionEvent?.day);
  const commentDeadline = firstDay(rules.comment_by_date, commentEvent?.day);
  const hearingDate = firstDay(rules.hearing_date, hearingEvent?.day);
  const hint = text(fine_stage || stage).toLowerCase();
  const compareDates = Boolean(now);

  if ((effectiveDate && (compareDates ? dateIsPastOrToday(effectiveDate, now) : effectiveEvent?.status === "occurred"))
      || hint === "effective") {
    return {
      state: "effective",
      effective_date: effectiveDate,
      adoption_date: adoptionDate,
      comment_deadline: commentDeadline,
      hearing_date: hearingDate,
    };
  }
  if (adoptionDate || rules.rule_status === "1" || rules.notice_type === "adoption" || hint === "adopted") {
    return {
      state: "adopted",
      effective_date: effectiveDate,
      adoption_date: adoptionDate,
      comment_deadline: commentDeadline,
      hearing_date: hearingDate,
    };
  }

  const commentOpen = commentDeadline
    ? (compareDates ? dateIsFuture(commentDeadline, now) : dateIsScheduled(commentDeadline, commentEvent, now))
    : hint === "comment-open";
  const hearingOpen = hearingDate
    ? (compareDates ? dateIsFuture(hearingDate, now) : dateIsScheduled(hearingDate, hearingEvent, now))
    : hint === "hearing";
  if (commentOpen || hearingOpen) {
    return {
      state: "comment_hearing_open",
      effective_date: effectiveDate,
      adoption_date: adoptionDate,
      comment_deadline: commentDeadline,
      hearing_date: hearingDate,
    };
  }

  const commentClosed = commentDeadline
    ? (compareDates ? dateIsPastOrToday(commentDeadline, now) : commentEvent?.status === "occurred" || hint === "comment-closed")
    : hint === "comment-closed";
  if (commentClosed || (hearingDate && compareDates && dateIsPastOrToday(hearingDate, now) && hint === "hearing")) {
    return {
      state: "comment_closed_awaiting_action",
      effective_date: effectiveDate,
      adoption_date: adoptionDate,
      comment_deadline: commentDeadline,
      hearing_date: hearingDate,
    };
  }
  return {
    state: "proposed",
    effective_date: effectiveDate,
    adoption_date: adoptionDate,
    comment_deadline: commentDeadline,
    hearing_date: hearingDate,
  };
}

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter(Boolean).filter((item) => {
    const key = `${item.id || item.kind}:${item.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Project the five-state resident action matrix. Official actions are only
 * emitted from retained source URLs. `follow_href` is the exact
 * `rules.request_ids` Following wire from CAP-2; until that replay contract
 * is supplied, no broad subject/agency watch is invented here.
 */
export function rulemakingActionMatrix({
  lifecycle = null,
  fine_stage = null,
  stage = null,
  nyc_rules = null,
  events = [],
  source_documents = [],
  now = null,
  proposed_rule_url = null,
  final_rule_url = null,
  hearing_url = null,
  hearing_record_url = null,
  comments_url = null,
  comment_channel_url = null,
  testimony_url = null,
  petition_url = null,
  follow_href = null,
  history_url = null,
  comment_label = "Comment",
  hearing_label = "Attend hearing",
} = {}) {
  const rules = nyc_rules && typeof nyc_rules === "object" ? nyc_rules : {};
  const state = lifecycle || deriveRulemakingLifecycleState({ fine_stage, stage, nyc_rules: rules, events, now });
  const labels = actionLabels({ commentLabel: comment_label, hearingLabel: hearing_label });
  const proposedUrl = sourceUrl(proposed_rule_url)
    || sourceUrl(rules.proposed_rule_url)
    || sourceDocumentUrl(source_documents, (item) => item.kind === "proposed_rule" || item.role === "proposed_rule")
    || sourceUrl(rules.url);
  const finalUrl = sourceUrl(final_rule_url)
    || sourceUrl(rules.final_rule_url)
    || sourceUrl(rules.adopted_rule_url)
    || sourceDocumentUrl(source_documents, (item) => item.kind === "final_rule")
    || ((state.state === "adopted" || state.state === "effective") ? sourceUrl(rules.url) : null);
  const hearingUrl = sourceUrl(hearing_url)
    || sourceDocumentUrl(source_documents, (item) => item.kind === "hearing_information" || item.role === "hearing")
    || ((state.hearing_date || text(fine_stage).toLowerCase() === "hearing") ? sourceUrl(rules.url) : null);
  const hearingRecordUrl = sourceUrl(hearing_record_url)
    || sourceDocumentUrl(source_documents, (item) => item.kind === "hearing_record" || item.role === "hearing_record");
  const commentUrl = sourceUrl(rules.comment_url) || sourceUrl(comments_url) || sourceUrl(rules.url);
  const testimonyUrlValue = sourceUrl(testimony_url) || sourceUrl(comment_channel_url);
  const followUrl = text(follow_href);
  const watch = followUrl ? internalAction({ id: "watch_rulemaking", label: "Watch this rulemaking", href: followUrl }) : null;
  const out = [];
  const add = (item) => { if (item) out.push(item); };

  if (state.state === "proposed") {
    add(action({ id: "read_proposed", label: "Read proposed rule", href: proposedUrl, primary: true }));
    add(watch);
  } else if (state.state === "comment_hearing_open") {
    const commentAvailable = state.comment_deadline && (!now || dateIsFuture(state.comment_deadline, now));
    const hearingAvailable = state.hearing_date && (!now || dateIsFuture(state.hearing_date, now));
    const comment = commentAvailable && commentUrl
      ? action({ id: "comment", label: labels.comment, href: commentUrl, kind: "comment", primary: true, date: state.comment_deadline })
      : null;
    const hearing = hearingAvailable && hearingUrl
      ? action({ id: "attend_hearing", label: labels.hearing, href: hearingUrl, kind: "attend", primary: !comment, date: state.hearing_date })
      : null;
    add(comment);
    add(hearing);
    add(state.hearing_date && testimonyUrlValue
      ? action({ id: "testify", label: "Submit testimony", href: testimonyUrlValue, kind: "testify", primary: false, date: state.hearing_date })
      : null);
    // List cards without a date/event payload retain the old quiet behavior
    // when the open-stage evidence is incomplete. Full rulemaking pages pass
    // the event spine and an explicit `now`, so they still show the read step.
    if (state.comment_deadline || state.hearing_date || now != null || events.length || source_documents.length) {
      add(action({ id: "read_proposed", label: "Read proposed rule", href: proposedUrl }));
    }
    add(watch);
  } else if (state.state === "comment_closed_awaiting_action") {
    add(watch ? { ...watch, label: "Watch for adoption", id: "watch_adoption" } : null);
    add(action({ id: "hearing_record", label: "View hearing record", href: hearingRecordUrl }));
    add(action({ id: "comments", label: "Read public comments", href: comments_url || sourceDocumentUrl(source_documents, (item) => item.kind === "comments" || item.kind === "public_comments" || item.role === "comments") }));
    add(action({ id: "read_proposed", label: "Read proposed rule", href: proposedUrl, primary: !watch }));
  } else if (state.state === "adopted") {
    add(action({ id: "read_final", label: "Read final rule", href: finalUrl, primary: true }));
    add(action({ id: "read_proposed", label: "Open proposed rule", href: proposedUrl }));
    if (finalUrl && proposedUrl && finalUrl !== proposedUrl) {
      add(action({ id: "open_final", label: "Open final rule", href: finalUrl }));
    }
    add(watch ? { ...watch, label: "Watch for effective date", id: "watch_effective" } : null);
  } else if (state.state === "effective") {
    add(action({ id: "read_final", label: "Read final rule", href: finalUrl, primary: true }));
    add(internalAction({ id: "rulemaking_history", label: "View rulemaking history", href: history_url }));
    add(action({ id: "petition", label: "Petition agency to amend or repeal", href: petition_url, kind: "petition" }));
  }

  const missing = [];
  if (state.state === "comment_hearing_open" && !state.comment_deadline) missing.push("comment_deadline");
  if (["comment_hearing_open", "comment_closed_awaiting_action"].includes(state.state) && !state.hearing_date) missing.push("hearing_date");
  if ((state.state === "adopted" || state.state === "effective") && !finalUrl) missing.push("final_rule");
  if (state.state === "effective" && !sourceUrl(petition_url)) missing.push("petition_workflow");

  return {
    state: state.state,
    dates: {
      comment_deadline: state.comment_deadline || null,
      hearing_date: state.hearing_date || null,
      adoption_date: state.adoption_date || null,
      effective_date: state.effective_date || null,
    },
    actions: uniqueActions(out),
    missing,
  };
}

/**
 * Map Rules producer fields into the shared object-card interaction contract.
 * A rule card has one canonical rulemaking target when the materialization has
 * a grounded multi-notice subject. Unjoined records retain their notice target.
 * Only dated, destination-backed comment and hearing transitions qualify as
 * kinetic actions.
 */
export function rulesCardInteractionProjection({
  request_id,
  rulemaking_id = null,
  title,
  fine_stage = null,
  rule_url = null,
  comment_url = null,
  comment_by_date = null,
  hearing_date = null,
  events = [],
  now = null,
  nyc_rules = null,
  source_documents = [],
  proposed_rule_url = null,
  final_rule_url = null,
  hearing_url = null,
  hearing_record_url = null,
  comments_url = null,
  comment_channel_url = null,
  testimony_url = null,
  petition_url = null,
  follow_href = null,
  history_url = null,
  canonical_href = null,
  comment_label = "Comment",
  hearing_label = "Follow hearing",
  official_source_label = "Official rule",
  relations = [],
} = {}) {
  const requestId = text(request_id);
  const rulemakingId = text(rulemaking_id);
  const ruleHref = text(rule_url);
  const commentHref = text(comment_url) || ruleHref;
  const commentDate = text(comment_by_date);
  const hearingDate = text(hearing_date);
  const lifecycle = deriveRulemakingLifecycleState({
    fine_stage,
    nyc_rules: nyc_rules || { comment_by_date: commentDate, hearing_date: hearingDate, url: ruleHref, comment_url: commentHref },
    events,
    now,
  });
  const matrix = rulemakingActionMatrix({
    lifecycle,
    fine_stage,
    nyc_rules: nyc_rules || { comment_by_date: commentDate, hearing_date: hearingDate, url: ruleHref, comment_url: commentHref },
    events,
    source_documents,
    now,
    proposed_rule_url,
    final_rule_url,
    hearing_url,
    hearing_record_url,
    comments_url,
    comment_channel_url,
    testimony_url,
    petition_url,
    follow_href,
    history_url,
    comment_label,
    hearing_label,
  });
  const kineticActions = matrix.actions.map((item) => ({
    ...item,
    attributes: {
      ...(item.date ? { "data-card-fact": `${item.id === "comment" ? "comment-deadline" : item.id === "attend_hearing" ? "hearing-date" : "action-date"}:${item.date}` } : {}),
    },
  }));

  const primaryAction = kineticActions.find((item) => item.primary);
  const officialHandoffs = ruleHref && ruleHref !== primaryAction?.href
    ? [{ label: text(official_source_label), href: ruleHref, kind: "official_source" }]
    : [];
  const projection = objectCardInteractionProjection({
    target: text(title) && (text(canonical_href) || rulemakingId || requestId)
      ? {
        href: text(canonical_href) || (rulemakingId
          ? `/rules/${encodeURIComponent(rulemakingId)}`
          : `/notices/${encodeURIComponent(requestId)}`),
        label: text(title),
      }
      : null,
    relations,
    external_handoffs: officialHandoffs,
    kinetic_actions: kineticActions,
  });
  return Object.freeze({
    ...projection,
    lifecycle_state: matrix.state,
    lifecycle_dates: Object.freeze({ ...matrix.dates }),
    unavailable_actions: Object.freeze(matrix.missing.map((field) => Object.freeze({ field, state: "unknown" }))),
  });
}
