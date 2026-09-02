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

// The Notice primary boundary keeps its own bounded diagnostic namespace so a
// cold trace shows when the primary owner reported relative to the deferred
// owners. Like the notice-context marks these are browser timeline entries, not
// RUM dimensions, and they carry no identifiers.
export function noticePrimaryTimingMark(phase) {
  const value = String(phase || "");
  if (!/^[a-z0-9-]+$/.test(value)) return { state: "invalid" };
  try {
    globalThis.performance?.mark?.(`cityscroll.notice-primary.${value}`);
    return { state: "recorded" };
  } catch {
    return { state: "unavailable" };
  }
}

// Optional-branch durations stay on the Performance timeline. They are not a
// second production RUM identity and must not carry record identifiers.
export function noticeContextTimingMeasure(phase) {
  const value = String(phase || "");
  if (!/^[a-z0-9-]+$/.test(value)) return { state: "invalid" };
  const name = `cityscroll.notice-context.${value}`;
  try {
    globalThis.performance?.measure?.(name, `${name}-start`, `${name}-end`);
    const entries = globalThis.performance?.getEntriesByName?.(name, "measure") || [];
    const last = entries[entries.length - 1];
    const duration = Number(last?.duration);
    return {
      state: "recorded",
      branch: value,
      duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
    };
  } catch {
    return { state: "unavailable", branch: value, duration_ms: null };
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

// Owner-call time for the Notice primary boundary. Reading it at the boundary
// keeps `content_ready_ms` the owner's clock even when the production reporter
// installs later, so a before/after comparison stays comparable.
export function noticePrimaryOwnerNow(runtime = globalThis) {
  try {
    const value = runtime?.performance?.now?.();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function noticePrimaryReady(rum, { resultState } = {}, ownerTimestamp = null) {
  const bounded = boundedTerminalState(resultState);
  if (!bounded) return { state: "not_ready" };
  return rum.surfaceReady({
    surfaceId: "notice",
    resultState: bounded,
  }, ownerTimestamp);
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
