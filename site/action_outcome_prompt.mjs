/**
 * Optional post-action self-report for the shared action rail.
 *
 * The prompt consumes only validated action-registry output. Its analytics calls
 * never attach a notice id, destination, account, or free text. Official outcomes
 * remain on their receipt-backed lifecycle panels; this module records only one
 * bounded aggregate choice after an explicit button press.
 */

const KINETIC_OUTCOMES = Object.freeze({
  official_application: Object.freeze(["submitted", "bid", "not_useful"]),
  comment: Object.freeze(["submitted", "not_useful"]),
  contact: Object.freeze(["submitted", "not_useful"]),
  rsvp: Object.freeze(["attended", "not_useful"]),
  attend: Object.freeze(["attended", "not_useful"]),
});

const PASSED_KIND_OUTCOMES = Object.freeze({
  bid: Object.freeze(["bid", "won", "not_useful"]),
  attend: Object.freeze(["attended", "not_useful"]),
  comment: Object.freeze(["submitted", "not_useful"]),
  object: Object.freeze(["submitted", "not_useful"]),
  inquire_claim: Object.freeze(["submitted", "not_useful"]),
  request_accommodation: Object.freeze(["submitted", "not_useful"]),
});

const OUTCOME_LABEL_KEYS = Object.freeze({
  submitted: "outcome_prompt_submitted",
  attended: "outcome_prompt_attended",
  bid: "outcome_prompt_bid",
  won: "outcome_prompt_won",
  not_useful: "outcome_prompt_not_useful",
});

const PROMPT_STATE = new WeakMap();

function registeredOutcomes(values, outcomeEnum) {
  const registered = new Set(Array.isArray(outcomeEnum) ? outcomeEnum : []);
  return values.filter((value) => registered.has(value));
}

function passedPropertyContext(actions, outcomeEnum) {
  for (const action of actions) {
    const guide = action?.guide;
    if (guide?.system !== "property_reader_actions" || guide.mode !== "historical") continue;
    for (const item of Array.isArray(guide.actions) ? guide.actions : []) {
      if (item?.status !== "historical") continue;
      const outcomes = registeredOutcomes(PASSED_KIND_OUTCOMES[item.kind] || [], outcomeEnum);
      if (outcomes.length) return { trigger: "passed_action", outcomes };
    }
  }
  return null;
}

function isoDay(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function passedUnavailableContext(actions, outcomeEnum, today) {
  const currentDay = isoDay(today);
  if (!currentDay) return null;
  for (const action of actions) {
    if (action?.delivery !== "unavailable" || !action.deadline) continue;
    const deadlineDay = isoDay(action.deadline);
    if (!deadlineDay || deadlineDay >= currentDay) continue;
    const base = KINETIC_OUTCOMES[action.type] || [];
    const withResult = action.type === "official_application"
      ? [...base.slice(0, 2), "won", "not_useful"]
      : base;
    const outcomes = registeredOutcomes(withResult, outcomeEnum);
    if (outcomes.length) return { trigger: "passed_action", outcomes };
  }
  return null;
}

function handoffContext(actions, outcomeEnum) {
  for (const action of actions) {
    if (action?.delivery !== "official_handoff") continue;
    const outcomes = registeredOutcomes(KINETIC_OUTCOMES[action.type] || [], outcomeEnum);
    if (outcomes.length) return { trigger: "official_handoff", outcomes };
  }
  return null;
}

/** Return a bounded prompt context, or null when the rail has no kinetic action evidence. */
export function outcomePromptContext(actions = [], outcomeEnum = [], options = {}) {
  const list = Array.isArray(actions) ? actions : [];
  return passedPropertyContext(list, outcomeEnum)
    || passedUnavailableContext(list, outcomeEnum, options.today)
    || handoffContext(list, outcomeEnum);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function outcomePromptHTML(context, options = {}) {
  if (!context?.trigger || !Array.isArray(context.outcomes) || !context.outcomes.length) return "";
  const translate = typeof options.t === "function" ? options.t : (key) => key;
  const escape = typeof options.escape === "function" ? options.escape : escapeHTML;
  const leadKey = context.trigger === "passed_action"
    ? "outcome_prompt_lead_passed"
    : "outcome_prompt_lead_handoff";
  const choices = context.outcomes.map((value) => {
    const labelKey = OUTCOME_LABEL_KEYS[value];
    if (!labelKey) return "";
    return `<button type="button" class="outcome-prompt-choice" data-outcome-choice="${escape(value)}">${escape(translate(labelKey))}</button>`;
  }).join("");
  return `<section class="outcome-prompt" data-action-outcome-prompt="${escape(context.trigger)}" aria-labelledby="outcome-prompt-heading">
    <h4 id="outcome-prompt-heading">${escape(translate("outcome_prompt_heading"))}</h4>
    <p>${escape(translate(leadKey))}</p>
    <p class="outcome-prompt-boundary">${escape(translate("outcome_prompt_self_report"))} ${escape(translate("outcome_prompt_privacy"))}</p>
    <div class="outcome-prompt-choices" role="group" aria-label="${escape(translate("outcome_prompt_choices_label"))}">${choices}</div>
    <button type="button" class="outcome-prompt-dismiss" data-outcome-dismiss>${escape(translate("outcome_prompt_not_now"))}</button>
  </section>`;
}

export function recordActionOpened(options = {}) {
  const analytics = options.analytics;
  if (!analytics || typeof analytics.record !== "function") return false;
  analytics.record("action_opened", { detail: "official-handoff", surface: "home" });
  return true;
}

function promptDetail(trigger) {
  return trigger === "passed_action" ? "passed-action" : "official-handoff";
}

export function recordOutcomePrompted(trigger, options = {}) {
  const analytics = options.analytics;
  if (!analytics || typeof analytics.record !== "function") return false;
  analytics.record("outcome_prompted", { detail: promptDetail(trigger), surface: "home" });
  return true;
}

export function recordOutcomeDismissed(trigger, options = {}) {
  const analytics = options.analytics;
  if (!analytics || typeof analytics.record !== "function") return false;
  analytics.record("outcome_dismissed", { detail: promptDetail(trigger), surface: "home" });
  return true;
}

export function recordOutcomeChoice(value, options = {}) {
  if (!value || !options.registry || typeof options.registry.outcomeEvent !== "function") return false;
  if (!options.analytics || typeof options.analytics.record !== "function") return false;
  try {
    const event = options.registry.outcomeEvent(value);
    options.analytics.record(event.event, { detail: event.detail, surface: event.surface });
    return true;
  } catch (_error) {
    return false;
  }
}

function renderPrompt(slot, context, options, state) {
  if (!slot || !context) return;
  if (state?.completed || state?.dismissed) return;
  slot.innerHTML = outcomePromptHTML(context, options);
  if (state && !state.prompted.has(context.trigger)) {
    recordOutcomePrompted(context.trigger, options);
    state.prompted.add(context.trigger);
  }
  const prompt = slot.querySelector("[data-action-outcome-prompt]");
  if (!prompt) return;
  prompt.querySelectorAll("[data-outcome-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const recorded = recordOutcomeChoice(button.dataset.outcomeChoice, options);
      if (!recorded) return;
      if (state) state.completed = true;
      slot.innerHTML = `<p class="outcome-prompt-thanks" role="status">${escapeHTML(options.t("outcome_prompt_thanks"))}</p>`;
    }, { once: true });
  });
  prompt.querySelector("[data-outcome-dismiss]")?.addEventListener("click", () => {
    recordOutcomeDismissed(context.trigger, options);
    if (state) state.dismissed = true;
    slot.replaceChildren();
  }, { once: true });
}

/** Bind one rendered action rail. Repaints receive a fresh rail and fresh binding. */
export function bindActionOutcomePrompt(container, actions = [], options = {}) {
  const slot = container?.querySelector?.("[data-action-outcome-slot]");
  const registry = options.registry;
  if (!slot || !registry || !Array.isArray(registry.OUTCOME_ENUM)) return false;
  if (!options.analytics || typeof options.analytics.record !== "function") return false;
  const shared = {
    ...options,
    registry,
    analytics: options.analytics,
    t: typeof options.t === "function" ? options.t : (key) => key,
  };
  const prior = PROMPT_STATE.get(container);
  const state = prior && prior.contextKey === options.contextKey
    ? prior
    : {
        contextKey: options.contextKey || null,
        prompted: new Set(),
        completed: false,
        dismissed: false,
      };
  PROMPT_STATE.set(container, state);
  const initial = outcomePromptContext(actions, registry.OUTCOME_ENUM, { today: options.today });
  if (initial?.trigger === "passed_action") renderPrompt(slot, initial, shared, state);

  container.querySelectorAll("a[data-action-outcome-index]").forEach((link) => {
    const index = Number(link.dataset.actionOutcomeIndex);
    const context = outcomePromptContext([actions[index]], registry.OUTCOME_ENUM, { today: options.today });
    if (context?.trigger !== "official_handoff") return;
    link.addEventListener("click", () => {
      recordActionOpened(shared);
      // Official handoffs open in a new tab. Paint behind that tab so the optional
      // response is waiting only when the reader comes back; it never blocks departure.
      renderPrompt(slot, context, shared, state);
    });
  });
  return true;
}
