/**
 * Procedure-aware "Follow next decision" watch (LDP-16).
 *
 * A watch is an event subscription, not a prediction. This module accepts a
 * precomputed Land authority summary (LDP-05) and a precomputed
 * observed-outcomes array (LDP-10) — it never fetches, never resolves a
 * procedure, and never re-parses a raw disposition. Three responsibilities
 * live here, kept structurally separate:
 *
 *   1. `measureNextDecisionReliability` — a corpus-wide coverage measurement
 *      that gates the capability as a whole, mirroring the LDP-11 Council
 *      bridge's measured usefulness bar.
 *   2. `nextDecisionEligibility` — a single project's eligibility to expose
 *      "Follow next decision" at all, with an explicit ineligible/unknown
 *      reason.
 *   3. `evaluateNextDecisionWatchFiring` — whether an already-eligible watch
 *      should fire, comparing a prior snapshot to the current one. Firing
 *      keys off a changed materialized transition (current stage/actor) or a
 *      new exact observed/published event id — never off `expected_next_stage`
 *      (the normative profile successor), elapsed time, or display text.
 */

import { resolveLandAuthoritySourceBasis } from "./land_authority_summary.mjs";

export const LAND_NEXT_DECISION_RELIABILITY_SCHEMA = "cityscroll.land_next_decision_reliability.v1";
export const LAND_NEXT_DECISION_WATCH_KEY_SCHEMA = "cityscroll.land_next_decision_watch_key.v1";
export const LAND_NEXT_DECISION_FIRE_RECEIPT_SCHEMA = "cityscroll.land_next_decision_fire_receipt.v1";
export const LAND_NEXT_DECISION_DIGEST_COPY_SCHEMA = "cityscroll.land_next_decision_digest_copy.v1";

// Same 30% usefulness bar established for the exact-identifier Council bridge
// (LDP-11, `warehouse/lib/council_land_bridge.mjs`): a bounded stop is safer
// than shipping a resident-facing affordance over a corpus that is mostly
// unresolved actor/stage identity.
export const NEXT_DECISION_RELIABILITY_THRESHOLD = 0.3;

export const NEXT_DECISION_INELIGIBLE_REASONS = Object.freeze({
  RELIABILITY_BELOW_THRESHOLD: "reliability_below_threshold",
  ACTOR_UNRESOLVED: "actor_unresolved",
  STAGE_UNRESOLVED: "stage_unresolved",
  NO_EXPECTED_TRANSITION: "no_expected_transition",
});

export const NEXT_DECISION_FIRE_TRIGGERS = Object.freeze({
  TRANSITION_CHANGE: "transition_change",
  OBSERVED_EVENT: "observed_event",
  PUBLISHED_EVENT: "published_event",
});

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function asSummaryList(summaries) {
  if (Array.isArray(summaries)) return summaries;
  if (summaries && typeof summaries === "object") return Object.values(summaries);
  return [];
}

function summaryIsNormalized(summary) {
  return summary?.status === "resolved"
    && Array.isArray(summary.current_actor_refs)
    && summary.current_actor_refs.length > 0
    && Boolean(summary.current_stage?.stage_id);
}

/**
 * Measure how much of the materialized Land authority-summary corpus resolves
 * a normalized actor AND stage (not stage alone). Below the threshold, the
 * capability stays disabled for every project regardless of that project's
 * own resolved state — an honest stop, not a per-project guess.
 */
export function measureNextDecisionReliability(summaries, { threshold, generatedAt = null } = {}) {
  const bar = Number.isFinite(threshold) ? threshold : NEXT_DECISION_RELIABILITY_THRESHOLD;
  const rows = asSummaryList(summaries);
  const universe = rows.length;
  const normalized = rows.filter(summaryIsNormalized).length;
  const rate = universe ? normalized / universe : 0;
  const result = universe > 0 && rate >= bar ? "GO" : "STOP";
  return Object.freeze({
    schema: LAND_NEXT_DECISION_RELIABILITY_SCHEMA,
    generated_at: generatedAt,
    threshold: bar,
    coverage: Object.freeze({ universe, normalized, rate: Number(rate.toFixed(6)) }),
    gate: Object.freeze({
      result,
      rationale: result === "GO"
        ? `${normalized} of ${universe} materialized projects (${(rate * 100).toFixed(2)}%) resolve a normalized actor and stage; at or above the ${Math.round(bar * 100)}% reliability bar.`
        : `${normalized} of ${universe} materialized projects (${(rate * 100).toFixed(2)}%) resolve a normalized actor and stage; below the ${Math.round(bar * 100)}% reliability bar.`,
    }),
  });
}

/**
 * The materialized transition identity: normalized stage + actor(s) as
 * actually observed on the current authority summary. Never reads
 * `expected_next_stage` — that field is the profile's normative successor,
 * kept separate so it can never itself mint or change a transition identity.
 */
export function buildTransitionIdentity(summary = {}) {
  const projectId = clean(summary.project_id);
  const procedureId = clean(summary.procedure_id);
  const stageId = clean(summary.current_stage?.stage_id);
  const actorRefs = Object.freeze(
    (Array.isArray(summary.current_actor_refs) ? [...summary.current_actor_refs] : [])
      .map(clean)
      .filter(Boolean)
      .sort(),
  );
  // The registry version is shared provenance published once on the payload, so
  // it is resolved rather than read off the summary; the watch's dedupe key
  // depends on it, and an undefined version would collapse distinct keys.
  const profileVersion = clean(resolveLandAuthoritySourceBasis(summary)?.profile?.registry_version);
  const role = clean(summary.current_role);
  const known = summary.status === "resolved" && Boolean(stageId) && actorRefs.length > 0;
  return Object.freeze({
    known,
    project_id: projectId,
    procedure_id: procedureId,
    stage_id: stageId,
    actor_refs: actorRefs,
    profile_version: profileVersion,
    role,
    transition_key: known
      ? `project:${projectId}|procedure:${procedureId || ""}|stage:${stageId}|actors:${actorRefs.join(",")}|v:${profileVersion || "unversioned"}`
      : null,
  });
}

function hasExpectedTransition(summary) {
  const next = summary?.expected_next_stage;
  return Boolean(next?.stage_id || next?.group_id);
}

/**
 * A single project's eligibility to expose "Follow next decision". Always
 * returns an explicit reason when ineligible so a resident sees why the
 * watch is unavailable rather than a silent absence. `expected_next_stage`
 * is used only as a boundary precondition here (is there a modeled next
 * transition at all) — never as firing input.
 */
export function nextDecisionEligibility({ summary, reliability } = {}) {
  if (!reliability || reliability.gate?.result !== "GO") {
    return Object.freeze({ eligible: false, reason: NEXT_DECISION_INELIGIBLE_REASONS.RELIABILITY_BELOW_THRESHOLD });
  }
  if (!summary || summary.status !== "resolved") {
    return Object.freeze({ eligible: false, reason: summary?.reason || "authority_unresolved" });
  }
  const transition = buildTransitionIdentity(summary);
  if (!transition.actor_refs.length) {
    return Object.freeze({ eligible: false, reason: NEXT_DECISION_INELIGIBLE_REASONS.ACTOR_UNRESOLVED });
  }
  if (!transition.stage_id) {
    return Object.freeze({ eligible: false, reason: NEXT_DECISION_INELIGIBLE_REASONS.STAGE_UNRESOLVED });
  }
  if (!hasExpectedTransition(summary)) {
    return Object.freeze({ eligible: false, reason: NEXT_DECISION_INELIGIBLE_REASONS.NO_EXPECTED_TRANSITION });
  }
  return Object.freeze({ eligible: true, reason: null });
}

/**
 * The watch event key: project/action id, normalized stage, actor ref(s),
 * transition version, and an observed/published event id where one applies.
 * `dedupe_key` is the stable string a subscription store keys on.
 */
export function buildNextDecisionWatchKey({ summary, eventId = null } = {}) {
  const transition = buildTransitionIdentity(summary);
  const dedupeKey = [
    "watch",
    transition.project_id || "",
    transition.stage_id || "",
    transition.actor_refs.join(","),
    transition.profile_version || "",
    eventId || "",
  ].join("|");
  return Object.freeze({
    schema: LAND_NEXT_DECISION_WATCH_KEY_SCHEMA,
    project_id: transition.project_id,
    procedure_id: transition.procedure_id,
    stage_id: transition.stage_id,
    actor_refs: transition.actor_refs,
    transition_version: transition.profile_version,
    event_id: eventId,
    dedupe_key: dedupeKey,
  });
}

function observedEventKeys(observedOutcomes) {
  return Object.freeze(
    (Array.isArray(observedOutcomes) ? observedOutcomes : [])
      .map((outcome) => clean(outcome?.action_key))
      .filter(Boolean),
  );
}

function publishedEventId(summary) {
  const published = summary?.published_next_opportunity;
  return published?.status === "published" ? clean(published.source_id) : null;
}

function snapshotVintage(summary) {
  return clean(summary?.freshness?.generated_at) || clean(summary?.freshness?.as_of);
}

/**
 * Build the comparable snapshot for one evaluation. This is what a caller
 * persists as `previous` for the next check — never a timer, never a display
 * string.
 */
export function buildNextDecisionSnapshot({ summary, observedOutcomes = [] } = {}) {
  const transition = buildTransitionIdentity(summary);
  return Object.freeze({
    transition_key: transition.transition_key,
    stage_id: transition.stage_id,
    actor_refs: transition.actor_refs,
    profile_version: transition.profile_version,
    observed_event_keys: observedEventKeys(observedOutcomes),
    published_source_id: publishedEventId(summary),
    snapshot_vintage: snapshotVintage(summary),
  });
}

/**
 * Evaluate whether an eligible watch should fire. A fire requires either (a)
 * a changed materialized transition — both the prior and current transition
 * identity are stable/known and differ — or (b) a new exact observed or
 * published event id not present in the prior snapshot. First evaluation
 * (`previous` absent) never fires: it only establishes the baseline snapshot,
 * so subscribing never itself reads as a notification.
 *
 * Negative rule, structurally enforced: elapsed time, a statutory deadline,
 * `expected_next_stage` (profile successor), a draft-only disposition (LDP-10
 * never emits an `action_key` for one), a meeting/hearing not tied to this
 * project by exact identifier (never reaches `published_next_opportunity` or
 * `observed_outcomes`), and a changed display string alone are none of them
 * inputs to `transition_key`, `observed_event_keys`, or `published_source_id`
 * — so none of them can move the comparison.
 */
export function evaluateNextDecisionWatchFiring({
  previous = null,
  summary,
  observedOutcomes = [],
  reliability,
} = {}) {
  const eligibility = nextDecisionEligibility({ summary, reliability });
  const snapshot = buildNextDecisionSnapshot({ summary, observedOutcomes });

  if (!eligibility.eligible) {
    return Object.freeze({ fired: false, trigger: null, reason: eligibility.reason, eligibility, receipt: null, snapshot });
  }
  if (!previous) {
    return Object.freeze({ fired: false, trigger: null, reason: "baseline_snapshot", eligibility, receipt: null, snapshot });
  }

  const previousEventKeys = new Set(previous.observed_event_keys || []);
  const newEventKeys = (snapshot.observed_event_keys || []).filter((key) => !previousEventKeys.has(key));
  const transitionChanged = Boolean(previous.transition_key)
    && Boolean(snapshot.transition_key)
    && previous.transition_key !== snapshot.transition_key;
  const newPublishedEvent = Boolean(snapshot.published_source_id)
    && snapshot.published_source_id !== (previous.published_source_id || null);

  let trigger = null;
  if (transitionChanged) trigger = NEXT_DECISION_FIRE_TRIGGERS.TRANSITION_CHANGE;
  else if (newEventKeys.length) trigger = NEXT_DECISION_FIRE_TRIGGERS.OBSERVED_EVENT;
  else if (newPublishedEvent) trigger = NEXT_DECISION_FIRE_TRIGGERS.PUBLISHED_EVENT;

  if (!trigger) {
    return Object.freeze({ fired: false, trigger: null, reason: "no_change", eligibility, receipt: null, snapshot });
  }

  const eventId = trigger === NEXT_DECISION_FIRE_TRIGGERS.OBSERVED_EVENT
    ? newEventKeys[0]
    : trigger === NEXT_DECISION_FIRE_TRIGGERS.PUBLISHED_EVENT
      ? snapshot.published_source_id
      : null;

  const watchKey = buildNextDecisionWatchKey({ summary, eventId });

  const receipt = Object.freeze({
    schema: LAND_NEXT_DECISION_FIRE_RECEIPT_SCHEMA,
    project_id: watchKey.project_id,
    trigger,
    old_stage: previous.transition_key
      ? Object.freeze({ stage_id: previous.stage_id || null, actor_refs: previous.actor_refs || [] })
      : null,
    new_stage: Object.freeze({ stage_id: snapshot.stage_id, actor_refs: snapshot.actor_refs }),
    profile_version: snapshot.profile_version,
    snapshot_vintage: snapshot.snapshot_vintage,
    event_id: eventId,
    dedupe_key: watchKey.dedupe_key,
  });

  return Object.freeze({ fired: true, trigger, reason: null, eligibility, receipt, snapshot });
}

const ADVISORY_ROLE = "advisory_reviewer";

/**
 * Source-backed digest copy for a fired watch. Distinguishes an advisory
 * recommendation from a statutory decision role from a published (not yet
 * decided) opportunity, never collapsing one into another. Returns null for
 * a non-fired result — there is nothing to say about a subscription that has
 * not fired.
 */
export function buildNextDecisionDigestCopy({ fireResult, summary, observedOutcomes = [] } = {}) {
  if (!fireResult?.fired) return null;
  const projectId = clean(summary?.project_id);
  const role = clean(summary?.current_role);
  const roleKind = role === ADVISORY_ROLE ? "advisory" : (role ? "decisional" : "unknown");

  if (fireResult.trigger === NEXT_DECISION_FIRE_TRIGGERS.TRANSITION_CHANGE) {
    return Object.freeze({
      schema: LAND_NEXT_DECISION_DIGEST_COPY_SCHEMA,
      trigger: fireResult.trigger,
      role_kind: roleKind,
      role,
      headline: `Project ${projectId} reached a new reviewed stage.`,
      detail: roleKind === "advisory"
        ? "The current reviewing body issues an advisory recommendation; it does not decide the outcome."
        : "The current reviewing body holds a statutory decision role for this stage.",
      source: Object.freeze({
        type: "authority_summary",
        stage_id: fireResult.receipt.new_stage.stage_id,
        profile_version: fireResult.receipt.profile_version,
      }),
    });
  }

  if (fireResult.trigger === NEXT_DECISION_FIRE_TRIGGERS.OBSERVED_EVENT) {
    const outcome = (Array.isArray(observedOutcomes) ? observedOutcomes : [])
      .find((row) => row?.action_key === fireResult.receipt.event_id) || null;
    const advisory = outcome ? outcome.is_advisory === true : roleKind === "advisory";
    return Object.freeze({
      schema: LAND_NEXT_DECISION_DIGEST_COPY_SCHEMA,
      trigger: fireResult.trigger,
      role_kind: advisory ? "advisory" : "decisional",
      role,
      headline: advisory
        ? `A reviewing body issued an advisory recommendation on project ${projectId}.`
        : `A reviewing body recorded a statutory action on project ${projectId}.`,
      detail: advisory
        ? "The reviewing body recommends; a later statutory reviewer decides."
        : "This reflects the publisher's own recorded action.",
      source: Object.freeze({
        type: "observed_outcome",
        event_id: fireResult.receipt.event_id,
        source_ids: Object.freeze(outcome?.source_ids ? [...outcome.source_ids] : []),
      }),
    });
  }

  if (fireResult.trigger === NEXT_DECISION_FIRE_TRIGGERS.PUBLISHED_EVENT) {
    return Object.freeze({
      schema: LAND_NEXT_DECISION_DIGEST_COPY_SCHEMA,
      trigger: fireResult.trigger,
      role_kind: "published_event",
      role,
      headline: `A new published hearing or opportunity was recorded for project ${projectId}.`,
      detail: "The publisher scheduled this opportunity; no outcome has been recorded yet.",
      source: Object.freeze({
        type: "published_opportunity",
        event_id: fireResult.receipt.event_id,
        source: clean(summary?.published_next_opportunity?.source),
      }),
    });
  }

  return null;
}
