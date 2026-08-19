import {
  SEMANTIC_READINESS_MARKERS,
  boundedTerminalState,
  createRumSemanticMilestones,
} from "./rum_semantic_milestones.mjs";

const DISABLED_RUM = createRumSemanticMilestones();

/**
 * The pilot card will install the page-local reporter. Until then this accessor
 * keeps owner instrumentation present while production collection stays off.
 */
export function runtimeRumSemanticMilestones(runtime = globalThis) {
  const candidate = runtime?.CROLRumSemanticMilestones;
  if (
    candidate
    && typeof candidate.surfaceReady === "function"
    && typeof candidate.componentReady === "function"
  ) return candidate;
  return DISABLED_RUM;
}

export function homeEntryReady(rum, state = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.home;
  if (
    state.primaryContext !== marker.context_value
    || state.homeReady !== marker.ready_value
    || state.primaryCtaVisible !== true
    || state.topicInputVisible !== true
  ) return { state: "not_ready" };

  const surface = rum.surfaceReady({
    surfaceId: "home",
    resultState: "content",
  });
  const component = rum.componentReady({
    surfaceId: "home",
    componentId: "home-topic-entry",
    resultState: "content",
  });
  return {
    state: surface.state === "recorded" || component.state === "recorded"
      ? "recorded"
      : surface.state,
    surface,
    component,
  };
}

export function noticePrimaryOutcomeFromEdge(edgeRendered) {
  return SEMANTIC_READINESS_MARKERS.notice_primary.result_states[edgeRendered] || null;
}

export function noticePrimaryReady(rum, { resultState } = {}) {
  const bounded = boundedTerminalState(resultState);
  if (!bounded) return { state: "not_ready" };
  return rum.surfaceReady({
    surfaceId: "notice",
    resultState: bounded,
  });
}

export function noticeContextReady(rum, { resultState } = {}) {
  const mapped = SEMANTIC_READINESS_MARKERS.notice_context.result_states[resultState];
  const bounded = boundedTerminalState(mapped);
  if (!bounded) return { state: "not_ready" };
  return rum.componentReady({
    surfaceId: "notice",
    componentId: SEMANTIC_READINESS_MARKERS.notice_context.component_id,
    resultState: bounded,
  });
}
