import {
  SEMANTIC_READINESS_MARKERS,
  boundedTerminalState,
} from "./rum_semantic_milestones.mjs";

function mappedResultState(marker, resultState) {
  if (marker?.result_states && resultState in marker.result_states) {
    return boundedTerminalState(marker.result_states[resultState]);
  }
  return boundedTerminalState(resultState);
}

function reportSurface(rum, surfaceId, resultState) {
  const bounded = boundedTerminalState(resultState);
  if (!bounded || typeof rum?.surfaceReady !== "function") return { state: "invalid" };
  return rum.surfaceReady({ surfaceId, resultState: bounded });
}

function reportComponent(rum, surfaceId, componentId, resultState) {
  const bounded = boundedTerminalState(resultState);
  if (!bounded || typeof rum?.componentReady !== "function") return { state: "invalid" };
  return rum.componentReady({
    surfaceId,
    componentId,
    resultState: bounded,
  });
}

/**
 * Map a personal-watch fetch onto a catalog terminal.
 *
 * Unauthenticated is a definite zero-item outcome, not missing telemetry:
 * it publishes catalog `empty`. Fetch failure stays `error`; a non-OK
 * response stays `unavailable`. Callers must not pass account, watch,
 * session, or location identifiers.
 */
export function followingPersonalResultState({
  sessionRecognized = null,
  watchCount = 0,
  fetchFailed = false,
  responseOk = true,
} = {}) {
  if (fetchFailed) return "error";
  if (responseOk === false) return "unavailable";
  if (sessionRecognized === false) return "empty";
  if (Number(watchCount) > 0) return "content";
  if (sessionRecognized === true) return "empty";
  return null;
}

export function followingPersonalOutcomeFromHost(host) {
  if (!host || typeof host.querySelector !== "function") return null;
  const session = host.querySelector("[data-session-recognized]");
  if (!session) return null;
  return followingPersonalResultState({
    sessionRecognized: session.getAttribute("data-session-recognized") === "true",
    watchCount: host.querySelectorAll("[data-watch-key]").length,
    responseOk: true,
  });
}

/** Following shell: surface-ready when create flow and personal host exist. */
export function followingShellReady(rum, state = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.following_shell;
  if (
    state.hasRoot !== true
    || state.hasCreatePanel !== true
    || state.hasPersonalHost !== true
  ) return { state: "not_ready" };
  return reportSurface(rum, marker.surface_id, "content");
}

/** Personal watch list: catalog terminal after retrieval settles. */
export function followingWatchListReady(rum, { resultState } = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.following_watch_list;
  const bounded = mappedResultState(marker, resultState);
  if (!bounded) return { state: "not_ready" };
  return reportComponent(rum, marker.surface_id, marker.component_id, bounded);
}

/**
 * Page-local retrieval landmark. It records no catalog row and no token;
 * a later `followingWatchListReady` is the settled duration.
 */
export function followingPersonalRetrievalStart(rum, state = {}) {
  if (!rum || rum.state === "disabled" || typeof rum.componentReady !== "function") {
    return { state: "disabled" };
  }
  if (state.alreadyStarted === true) return { state: "duplicate" };
  if (typeof state.markStarted === "function") state.markStarted();
  return { state: "started" };
}

export function reportFollowingReadiness(rum, {
  shellReady = false,
  retrievalStarted = false,
  personalState = null,
  hasRoot,
  hasCreatePanel,
  hasPersonalHost,
} = {}) {
  const shell = followingShellReady(rum, {
    hasRoot: hasRoot ?? shellReady === true,
    hasCreatePanel: hasCreatePanel ?? shellReady === true,
    hasPersonalHost: hasPersonalHost ?? shellReady === true,
  });
  const retrieval = retrievalStarted || personalState != null
    ? followingPersonalRetrievalStart(rum)
    : { state: "not_started" };
  const personal = shell.state === "not_ready"
    ? { state: "not_ready" }
    : followingWatchListReady(rum, { resultState: personalState });
  return Object.freeze({
    shell: { state: shell.state },
    retrieval,
    personal,
  });
}

/**
 * Per-page ephemeral timing handle. Retrieval start lives only on this
 * object; it is never written to storage or copied across reporters.
 */
export function createFollowingRumInstrumentation({ rum } = {}) {
  let retrievalStarted = false;

  return Object.freeze({
    shellReady(state) {
      return followingShellReady(rum, state);
    },
    retrievalStart() {
      const result = followingPersonalRetrievalStart(rum, {
        alreadyStarted: retrievalStarted,
        markStarted() { retrievalStarted = true; },
      });
      return result;
    },
    watchListReady(state) {
      return followingWatchListReady(rum, state);
    },
  });
}
