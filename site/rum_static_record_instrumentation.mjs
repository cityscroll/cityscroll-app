import {
  SEMANTIC_READINESS_MARKERS,
  boundedTerminalState,
  createRumSemanticMilestones,
} from "./rum_semantic_milestones.mjs";
import { createBufferedSemanticMilestones } from "./rum_production.mjs";

const DISABLED_RUM = createRumSemanticMilestones();

// Keep the Notice owner trace visible in the browser Performance timeline without
// adding identifiers or free-form dimensions to the production RUM contract.
export function noticeContextTimingMark(phase) {
  const value = String(phase || "");
  if (!/^[a-z0-9-]+$/.test(value)) return { state: "invalid" };
  try {
    globalThis.performance?.mark?.(`cityscroll.notice-context.${value}`);
    return { state: "recorded" };
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * Owner instrumentation reports through this accessor. When the production
 * reporter is not yet installed, readiness calls buffer so first-paint
 * milestones are not lost; interactions stay disabled until install.
 */
export function runtimeRumSemanticMilestones(runtime = globalThis) {
  const candidate = runtime?.CROLRumSemanticMilestones || runtime?.CROL_RUM_SEMANTIC_MILESTONES;
  if (
    candidate
    && typeof candidate.surfaceReady === "function"
    && typeof candidate.componentReady === "function"
    && candidate.state !== "buffering"
  ) return candidate;
  if (runtime?.CROL_RUM_PRODUCTION === false) return DISABLED_RUM;
  return createBufferedSemanticMilestones(runtime);
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
