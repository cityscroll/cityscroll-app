/**
 * Component-owned semantic RUM milestones.
 *
 * This module deliberately knows nothing about endpoints or storage. Component
 * owners report semantic facts to the injected recorder; the disabled default
 * performs no clock reads and no writes. The collector can later adapt these
 * bounded records without learning component selectors.
 */

const TERMINAL_RESULT_STATES = new Set([
  "content",
  "empty",
  "unavailable",
  "error",
]);

const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SEMANTIC_READINESS_MARKERS = Object.freeze({
  home: Object.freeze({
    contract_id: "page-content-ready-v1",
    context_attribute: "data-primary-context",
    context_value: "home",
    ready_attribute: "data-home-ready",
    ready_value: "true",
    meaning: "The Home CTA and topic input are visible and usable.",
  }),
  notice_primary: Object.freeze({
    contract_id: "page-content-ready-v1",
    ready_attribute: "data-edge-rendered",
    result_states: Object.freeze({
      notice: "content",
      "notice-unavailable": "unavailable",
    }),
    meaning: "The notice has a meaningful primary body or an honest unavailable state.",
  }),
  notice_context: Object.freeze({
    contract_id: "component-ready-v1",
    component_id: "notice-context",
    result_states: Object.freeze({
      content: "content",
      empty: "empty",
      unavailable: "unavailable",
      error: "error",
    }),
    meaning: "The asynchronous notice context has useful content or an honest terminal state.",
  }),
  land_outcome_first_paint: Object.freeze({
    contract_id: "component-ready-v1",
    component_id: "land-outcomes",
    surface_id: "browse-zoning",
    ready_attribute: "data-zap-outcomes-first-paint",
    ready_value: "1",
    state_attribute: "data-zap-outcomes-state",
    result_states: Object.freeze({
      present: "content",
      absent: "empty",
      unavailable: "unavailable",
      error: "error",
    }),
    reader_absence: "empty-html",
    meaning: "The outcome owner has meaningful content or an honest terminal state.",
  }),
  near_you_frame: Object.freeze({
    contract_id: "page-content-ready-v1",
    surface_id: "near-you",
    root_attribute: "data-near-you-root",
    map_id: "nearMapSvg",
    place_controls_id: "near-place-fields",
    meaning: "The Near You shell has a usable map frame and place controls.",
  }),
  near_you_map: Object.freeze({
    contract_id: "component-ready-v1",
    component_id: "near-you-map",
    surface_id: "near-you",
    meaning: "The Near You usable map frame is present beside place controls.",
  }),
  near_you_map_data: Object.freeze({
    contract_id: "component-ready-v1",
    component_id: "near-you-map-data",
    surface_id: "near-you",
    state_attribute: "data-near-you-map-state",
    result_states: Object.freeze({
      content: "content",
      empty: "empty",
      unavailable: "unavailable",
      error: "error",
    }),
    meaning: "The map has relevant place data or an honest empty, unavailable, or error state.",
  }),
  agency_identity: Object.freeze({
    contract_id: "page-content-ready-v1",
    component_id: "agency-identity",
    surface_id: "agency",
    kind_value: "agency-constellation",
    identity_attribute: "data-export-class",
    identity_value: "object_identity",
    meaning: "The agency constellation has a usable published identity.",
  }),
  agency_relationships: Object.freeze({
    contract_id: "component-ready-v1",
    component_id: "agency-relationships",
    surface_id: "agency",
    result_states: Object.freeze({
      content: "content",
      empty: "empty",
      unavailable: "unavailable",
      error: "error",
    }),
    meaning: "Related records are ready, honestly empty, unavailable, or failed.",
  }),
  following_shell: Object.freeze({
    contract_id: "page-content-ready-v1",
    surface_id: "following",
    root_attribute: "data-following-root",
    create_panel_attribute: "data-following-panel",
    create_panel_value: "create",
    personal_host_attribute: "data-personal-watch-list",
    meaning: "The Following shell has a usable create flow and a host for personal watches.",
  }),
  following_watch_list: Object.freeze({
    contract_id: "component-ready-v1",
    component_id: "following-watch-list",
    surface_id: "following",
    result_states: Object.freeze({
      populated: "content",
      content: "content",
      empty: "empty",
      unauthenticated: "empty",
      unavailable: "unavailable",
      error: "error",
    }),
    meaning: "Personal watches have settled as populated, empty, unauthenticated, unavailable, or error.",
  }),
});

export function boundedTerminalState(value) {
  return TERMINAL_RESULT_STATES.has(value) ? value : null;
}

function validId(value) {
  return typeof value === "string" && STABLE_ID.test(value);
}

function disabledResult() {
  return Object.freeze({ state: "disabled" });
}

const DISABLED_INTERACTION = Object.freeze({
  state: "disabled",
  visualFeedback: disabledResult,
  settled: disabledResult,
  cancel: disabledResult,
});

function safeNow(now) {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function safeRecord(record, value) {
  try {
    const result = record(value);
    if (result && typeof result.catch === "function") void result.catch(() => {});
  } catch {
    // Telemetry is observational and cannot become a rendering dependency.
  }
}

function milestoneRecord({
  milestone,
  metricId = null,
  surfaceId = null,
  componentId = "none",
  resultState = null,
  value = null,
}) {
  return Object.freeze({
    record_type: "semantic_milestone",
    schema: "cityscroll.performance.semantic_milestone.v1",
    milestone,
    metric_id: metricId,
    unit: metricId ? "ms" : null,
    value,
    surface_id: surfaceId,
    component_id: componentId,
    result_state: resultState,
  });
}

/**
 * Create a page-local semantic milestone reporter.
 *
 * `record` is the narrow waist: fixture collectors can retain records today,
 * and the future transport can validate/normalize them independently. No
 * caller can attach free-form metadata, DOM text, selectors, or record IDs.
 */
export function createRumSemanticMilestones({
  enabled = false,
  navigationStart = 0,
  now = () => globalThis.performance?.now?.(),
  record,
} = {}) {
  if (enabled !== true || typeof record !== "function") {
    return Object.freeze({
      state: "disabled",
      surfaceReady: disabledResult,
      componentReady: disabledResult,
      interactionStart: () => DISABLED_INTERACTION,
    });
  }

  const origin = Number.isFinite(navigationStart) && navigationStart >= 0
    ? navigationStart
    : 0;
  const readySurfaces = new Set();
  const readyComponents = new Set();

  function ready({ kind, id, surfaceId, resultState }) {
    const bounded = boundedTerminalState(resultState);
    if (!validId(id) || !validId(surfaceId) || !bounded) return { state: "invalid" };
    const seen = kind === "surface" ? readySurfaces : readyComponents;
    if (seen.has(id)) return { state: "duplicate" };
    const at = safeNow(now);
    if (at == null || at < origin) return { state: "out_of_order" };
    seen.add(id);
    safeRecord(record, milestoneRecord({
      milestone: kind === "surface" ? "surface-ready" : "component-ready",
      metricId: kind === "surface" ? "content_ready_ms" : "component_ready_ms",
      surfaceId,
      componentId: kind === "component" ? id : "none",
      resultState: bounded,
      value: at - origin,
    }));
    return { state: "recorded" };
  }

  function interactionStart({ surfaceId, componentId } = {}) {
    if (!validId(surfaceId) || !validId(componentId)) {
      return Object.freeze({
        state: "invalid",
        visualFeedback: () => ({ state: "invalid" }),
        settled: () => ({ state: "invalid" }),
        cancel: () => ({ state: "invalid" }),
      });
    }
    const startedAt = safeNow(now);
    if (startedAt == null) return DISABLED_INTERACTION;

    let feedbackAt = null;
    let terminal = false;
    safeRecord(record, milestoneRecord({
      milestone: "interaction-start",
      surfaceId,
      componentId,
    }));

    const interaction = {
      state: "active",
      visualFeedback() {
        if (terminal || feedbackAt != null) return { state: "duplicate" };
        const at = safeNow(now);
        if (at == null || at < startedAt) return { state: "out_of_order" };
        feedbackAt = at;
        safeRecord(record, milestoneRecord({
          milestone: "visual-feedback",
          metricId: "interaction_feedback_ms",
          surfaceId,
          componentId,
          value: feedbackAt - startedAt,
        }));
        return { state: "recorded" };
      },
      settled({ resultState } = {}) {
        if (terminal) return { state: "duplicate" };
        const bounded = boundedTerminalState(resultState);
        if (!bounded) return { state: "invalid" };
        if (feedbackAt == null) return { state: "out_of_order" };
        const settledAt = safeNow(now);
        if (settledAt == null || settledAt < feedbackAt) return { state: "out_of_order" };
        terminal = true;
        safeRecord(record, milestoneRecord({
          milestone: "settled",
          metricId: "interaction_settled_ms",
          surfaceId,
          componentId,
          resultState: bounded,
          value: settledAt - startedAt,
        }));
        safeRecord(record, milestoneRecord({
          milestone: "feedback-to-settled",
          metricId: "feedback_to_settled_ms",
          surfaceId,
          componentId,
          resultState: bounded,
          value: settledAt - feedbackAt,
        }));
        return { state: "settled" };
      },
      cancel() {
        if (terminal) return { state: "duplicate" };
        const at = safeNow(now);
        if (at == null || at < startedAt) return { state: "out_of_order" };
        terminal = true;
        safeRecord(record, milestoneRecord({
          milestone: "cancel",
          surfaceId,
          componentId,
          resultState: "cancelled",
        }));
        return { state: "cancelled" };
      },
    };
    return Object.freeze(interaction);
  }

  return Object.freeze({
    state: "enabled",
    surfaceReady({ surfaceId, resultState } = {}) {
      return ready({ kind: "surface", id: surfaceId, surfaceId, resultState });
    },
    componentReady({ surfaceId, componentId, resultState } = {}) {
      return ready({ kind: "component", id: componentId, surfaceId, resultState });
    },
    interactionStart,
  });
}
