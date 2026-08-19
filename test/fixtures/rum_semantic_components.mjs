import {
  SEMANTIC_READINESS_MARKERS,
  boundedTerminalState,
} from "../../site/rum_semantic_milestones.mjs";

/** Representative owner code: Home reports only after its established marker
 * and meaningful controls agree. The collector never inspects those controls. */
export function fixtureHomeReady(rum, state) {
  const marker = SEMANTIC_READINESS_MARKERS.home;
  if (
    state?.primaryContext !== marker.context_value
    || state?.homeReady !== marker.ready_value
    || state?.primaryCtaVisible !== true
    || state?.topicInputVisible !== true
  ) return { state: "not_ready" };
  return rum.surfaceReady({ surfaceId: "home", resultState: "content" });
}

/** Representative async owner: private telemetry can report honest absence
 * while the reader contract continues to render no absence announcement. */
export function fixtureLandOutcome(rum, { outcome } = {}) {
  const marker = SEMANTIC_READINESS_MARKERS.land_outcome_first_paint;
  const resultState = boundedTerminalState(marker.result_states[outcome]);
  return {
    readerHtml: outcome === "present" ? "<section>Outcome</section>" : "",
    report: rum.componentReady({
      surfaceId: "browse-zoning",
      componentId: "land-outcomes-fixture",
      resultState,
    }),
  };
}

/** Representative interaction owner with distinct feedback and settlement. */
export function fixtureInteraction(rum, {
  surfaceId = "search",
  componentId,
  resultState = "content",
  cancel = false,
} = {}) {
  const interaction = rum.interactionStart({ surfaceId, componentId });
  if (cancel) return interaction.cancel();
  const feedback = interaction.visualFeedback();
  if (feedback.state !== "recorded") return feedback;
  return interaction.settled({ resultState });
}
