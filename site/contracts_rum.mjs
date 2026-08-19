import {
  boundedTerminalState,
  createRumSemanticMilestones,
} from "./rum_semantic_milestones.mjs";

export const CONTRACTS_RUM_IDS = Object.freeze({
  surface: "browse-contracts",
  results: "browse-contracts-results",
  filter: "browse-contracts-filter-apply",
});

function browserAfterNextPaint(callback) {
  const schedule = globalThis.requestAnimationFrame?.bind(globalThis);
  if (schedule) {
    // The first callback runs before paint. The second callback is therefore
    // the first timestamp after the browser had a chance to show native input
    // or select feedback from the qualifying action.
    schedule(() => schedule(callback));
    return;
  }
  globalThis.setTimeout?.(callback, 0);
}

/**
 * Contracts owns these milestones: the collector never inspects selectors,
 * query text, result records, or event targets. An opaque in-memory action is
 * used only to keep overlapping async renders from settling the wrong input.
 */
export function createContractsRumInstrumentation({
  rum = createRumSemanticMilestones(),
  afterNextPaint = browserAfterNextPaint,
} = {}) {
  let active = null;

  function cancel(action) {
    if (!action || action.state !== "active") return { state: "duplicate" };
    action.state = "cancelled";
    if (active === action) active = null;
    return action.milestones.cancel();
  }

  function settle(action) {
    if (!action || action.state !== "active" || !action.resultState || !action.feedbackReady) {
      return { state: "pending" };
    }
    action.state = "settled";
    if (active === action) active = null;
    return action.milestones.settled({ resultState: action.resultState });
  }

  function beginInteraction({ reusePending = false } = {}) {
    if (reusePending && active?.state === "active" && active.claimed !== true) return active;
    if (active?.state === "active") cancel(active);

    const action = {
      claimed: false,
      feedbackReady: false,
      resultState: null,
      state: "active",
      milestones: rum.interactionStart({
        surfaceId: CONTRACTS_RUM_IDS.surface,
        componentId: CONTRACTS_RUM_IDS.filter,
      }),
    };
    active = action;
    try {
      afterNextPaint(() => {
        if (action.state !== "active") return;
        const feedback = action.milestones.visualFeedback();
        if (!["recorded", "disabled", "duplicate"].includes(feedback.state)) return;
        action.feedbackReady = true;
        settle(action);
      });
    } catch {
      // Missing paint scheduling is missing feedback, never a zero-duration
      // measurement and never a rendering failure.
    }
    return action;
  }

  function claimInteraction() {
    if (!active || active.state !== "active" || active.claimed) return null;
    active.claimed = true;
    return active;
  }

  function resultsRendered(action, resultState) {
    const bounded = boundedTerminalState(resultState);
    if (!bounded) return { state: "invalid" };

    rum.surfaceReady({ surfaceId: CONTRACTS_RUM_IDS.surface, resultState: bounded });
    rum.componentReady({
      surfaceId: CONTRACTS_RUM_IDS.surface,
      componentId: CONTRACTS_RUM_IDS.results,
      resultState: bounded,
    });

    if (!action || action.state !== "active") return { state: "ready" };
    action.resultState = bounded;
    return settle(action);
  }

  return Object.freeze({
    beginInteraction,
    cancelInteraction: cancel,
    claimInteraction,
    resultsRendered,
  });
}
