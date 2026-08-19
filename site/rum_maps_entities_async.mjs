import { boundedTerminalState } from "./rum_semantic_milestones.mjs";

function reportComponent(rum, surfaceId, componentId, resultState) {
  const bounded = boundedTerminalState(resultState);
  if (!bounded || typeof rum?.componentReady !== "function") return { state: "invalid" };
  return rum.componentReady({
    surfaceId,
    componentId,
    resultState: bounded,
  });
}

/** Near You owns both milestones: a usable map/list frame, then relevant data. */
export function reportNearYouMapReadiness(rum, {
  frameReady = false,
  dataState = null,
} = {}) {
  const frame = frameReady
    ? reportComponent(rum, "near-you", "near-you-map", "content")
    : { state: "not_ready" };
  const data = frameReady && boundedTerminalState(dataState)
    ? reportComponent(rum, "near-you", "near-you-map-data", dataState)
    : { state: "not_ready" };
  return Object.freeze({ frame, data });
}

/** Agency documents report identity separately from their relationship graph. */
export function reportAgencyConstellationReadiness(rum, {
  identityState = null,
  relationshipState = null,
} = {}) {
  const identity = reportComponent(rum, "agency", "agency-identity", identityState);
  const relationships = boundedTerminalState(identityState) && boundedTerminalState(relationshipState)
    ? reportComponent(rum, "agency", "agency-relationships", relationshipState)
    : { state: "not_ready" };
  return Object.freeze({ identity, relationships });
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

/** Map the async Land response to the RUM-05 closed terminal vocabulary. */
export function landOutcomeResultState({ record = null, requestState = "ready" } = {}) {
  if (requestState === "error") return "error";
  if (requestState === "unavailable") return "unavailable";
  if (!record || record.snapshot_state === "unavailable") return "unavailable";
  if (record.snapshot_state === "absent") return "empty";
  return "content";
}

export function reportLandOutcomeReadiness(rum, state) {
  return reportComponent(
    rum,
    "browse-zoning",
    "land-outcomes",
    landOutcomeResultState(state),
  );
}
