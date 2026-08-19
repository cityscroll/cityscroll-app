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

export function nearYouMapOutcomeFromView({ mapped, resultCount } = {}) {
  if (mapped === false) return "unavailable";
  if (Number(resultCount) > 0) return "content";
  if (mapped === true) return "empty";
  return null;
}

export function agencyRelationshipResultState(categories) {
  const rows = Array.isArray(categories) ? categories : [];
  if (rows.some((category) => category?.status === "matched" && Number(category?.count) > 0)) {
    return "content";
  }
  if (rows.some((category) => category?.status === "error")) return "error";
  if (rows.some((category) => ["unavailable", "unknown", "not_yet_ingested"].includes(category?.status))) {
    return "unavailable";
  }
  return "empty";
}

export function agencyRelationshipsOutcomeFromView(view) {
  if (!view || view.kind !== "agency-constellation") return null;
  const matched = Number(view.summary?.matched_categories) || 0;
  if (matched > 0) return "content";
  if (Array.isArray(view.categories) && view.categories.length) {
    return agencyRelationshipResultState(view.categories);
  }
  return "empty";
}

export function landOutcomesOutcomeFromSnapshot(record, {
  fetchFailed = false,
  responseOk = true,
} = {}) {
  if (fetchFailed) return "error";
  if (responseOk === false) return "unavailable";
  const snapshot = record?.snapshot_state;
  if (snapshot === "present") return "content";
  if (snapshot === "absent") return "empty";
  if (snapshot === "unavailable") return "unavailable";
  if (!record) return "unavailable";
  if (record.filled) return "content";
  return "empty";
}

export function landOutcomeResultState({ record = null, requestState = "ready" } = {}) {
  if (requestState === "error") {
    return landOutcomesOutcomeFromSnapshot(record, { fetchFailed: true });
  }
  if (requestState === "unavailable") {
    return landOutcomesOutcomeFromSnapshot(record, { responseOk: false });
  }
  return landOutcomesOutcomeFromSnapshot(record);
}

/** Near You frame: surface-ready plus the usable-map component. */
export function nearYouFrameReady(rum, state = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.near_you_frame;
  const frameMarker = SEMANTIC_READINESS_MARKERS.near_you_map;
  if (
    state.hasRoot !== true
    || state.hasMapSvg !== true
    || state.hasPlaceControls !== true
  ) return { state: "not_ready" };
  const surface = reportSurface(rum, marker.surface_id, "content");
  const frame = reportComponent(
    rum,
    frameMarker.surface_id,
    frameMarker.component_id,
    "content",
  );
  return Object.freeze({
    state: surface.state === "recorded" || frame.state === "recorded"
      ? "recorded"
      : surface.state,
    surface,
    frame,
  });
}

/** Near You relevant-data or honest absence, after the frame is usable. */
export function nearYouMapReady(rum, { resultState } = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.near_you_map_data;
  const bounded = mappedResultState(marker, resultState);
  if (!bounded) return { state: "not_ready" };
  return reportComponent(rum, marker.surface_id, marker.component_id, bounded);
}

export function reportNearYouMapReadiness(rum, {
  frameReady = false,
  dataState = null,
  hasRoot,
  hasMapSvg,
  hasPlaceControls,
} = {}) {
  const frame = nearYouFrameReady(rum, {
    hasRoot: hasRoot ?? frameReady === true,
    hasMapSvg: hasMapSvg ?? frameReady === true,
    hasPlaceControls: hasPlaceControls ?? frameReady === true,
  });
  const data = frame.state === "not_ready"
    ? { state: "not_ready" }
    : nearYouMapReady(rum, { resultState: dataState });
  return Object.freeze({
    frame: { state: frame.state },
    data,
  });
}

/** Agency identity: surface-ready plus the identity component. */
export function agencyIdentityReady(rum, state = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.agency_identity;
  if (state.kind !== marker.kind_value || state.hasIdentityHeading !== true) {
    return { state: "not_ready" };
  }
  const surface = reportSurface(rum, marker.surface_id, "content");
  const identity = reportComponent(
    rum,
    marker.surface_id,
    marker.component_id,
    "content",
  );
  return Object.freeze({
    state: surface.state === "recorded" || identity.state === "recorded"
      ? "recorded"
      : surface.state,
    surface,
    identity,
  });
}

export function agencyRelationshipsReady(rum, { resultState } = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.agency_relationships;
  const bounded = mappedResultState(marker, resultState);
  if (!bounded) return { state: "not_ready" };
  return reportComponent(rum, marker.surface_id, marker.component_id, bounded);
}

export function reportAgencyConstellationReadiness(rum, {
  identityState = null,
  relationshipState = null,
  kind = "agency-constellation",
  hasIdentityHeading,
} = {}) {
  const identity = agencyIdentityReady(rum, {
    kind,
    hasIdentityHeading: hasIdentityHeading ?? identityState === "content",
  });
  const relationships = agencyRelationshipsReady(rum, { resultState: relationshipState });
  return Object.freeze({
    identity: { state: identity.state },
    relationships,
  });
}

export function landOutcomesReady(rum, { resultState } = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.land_outcome_first_paint;
  const bounded = mappedResultState(marker, resultState);
  if (!bounded) return { state: "not_ready" };
  return reportComponent(rum, marker.surface_id, marker.component_id, bounded);
}

export function reportLandOutcomeReadiness(rum, state) {
  return landOutcomesReady(rum, { resultState: landOutcomeResultState(state) });
}
