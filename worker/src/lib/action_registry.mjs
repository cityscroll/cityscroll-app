export const OUTCOME_ENUM = Object.freeze(["submitted", "attended", "bid", "won", "not_useful"]);

const ACTION_TYPES = Object.freeze([
  "watch",
  "calendar",
  "document",
  "contact",
  "rsvp",
  "comment",
  "attend",
  "bid_checklist",
  "official_application",
  "return_to_matter",
  "local_note"
]);
const ACTION_DELIVERIES = Object.freeze(["local", "official_handoff", "unavailable"]);
const OFFICIAL_HANDOFF_CONFIRMATION_ACTIONS = new Set([
  "rsvp",
  "comment",
  "official_application"
]);

export function validateAction(action) {
  if (!ACTION_TYPES.includes(action.type)) throw new TypeError(`unknown action type: ${action.type}`);
  if (!ACTION_DELIVERIES.includes(action.delivery)) throw new TypeError(`unknown action delivery: ${action.delivery}`);
  if (typeof action.confirmation_required !== "boolean") throw new TypeError("action confirmation must be boolean");
  if (action.delivery === "unavailable" && action.destination_label) {
    throw new TypeError("unavailable actions cannot include a destination label");
  }
  if (action.delivery === "official_handoff") {
    if (!action.destination?.startsWith("https://")) throw new TypeError("official handoff requires a visible HTTPS destination");
    if (!action.destination_label) throw new TypeError("official handoff requires a destination label");
  }
  if (action.delivery === "unavailable" && action.destination) {
    throw new TypeError("unavailable actions cannot include a destination");
  }
  return action;
}

function unavailableAction(type, {label, deadline = null}) {
  return {
    type,
    label,
    delivery: "unavailable",
    deadline,
    confirmation_required: false,
  };
}

function classifyDelivery(url) {
  if (!url) return "unavailable";
  try {
    return new URL(url).protocol === "https:" ? "official_handoff" : "unavailable";
  } catch (_error) {
    return "unavailable";
  }
}

function buildAction(type, {label, destination, destination_label, deadline, confirmation_required = false}) {
  const delivery = classifyDelivery(destination);
  if (delivery === "official_handoff") {
    return {
      type,
      label,
      delivery,
      destination,
      destination_label: destination_label || new URL(destination).hostname,
      deadline: deadline || null,
      confirmation_required,
    };
  }
  if (delivery === "unavailable") {
    return unavailableAction(type, {label, deadline});
  }
  return {
    type,
    label,
    delivery,
    destination: null,
    deadline,
    confirmation_required,
  };
}

export function compileActionRail(matter, {vaultEnabled = false} = {}) {
  const documentDestination = vaultEnabled && matter.document?.vault_hash
    ? `https://api.cityscroll.org/source-vault/${matter.document.vault_hash}`
    : matter.document?.official_url;
  const actions = [
    {
      type: "watch",
      label: "Watch this matter",
      delivery: "local",
      destination: "index.html#alerts",
      deadline: null,
      confirmation_required: true,
    },
    {
      type: "calendar",
      label: "Add deadline to calendar",
      delivery: matter.deadline ? "local" : "unavailable",
      destination: null,
      deadline: matter.deadline,
      confirmation_required: false,
    },
    buildAction("document", {
      label: vaultEnabled ? "View kept document" : "Open official document",
      destination: documentDestination,
      deadline: matter.deadline,
      confirmation_required: OFFICIAL_HANDOFF_CONFIRMATION_ACTIONS.has("document"),
    }),
    buildAction("contact", {
      label: "Contact the responsible office",
      destination: matter.official_contact_url,
      confirmation_required: false,
    }),
    buildAction("rsvp", {
      label: "RSVP on the official site",
      destination: matter.official_notice_url,
      deadline: matter.deadline,
      confirmation_required: OFFICIAL_HANDOFF_CONFIRMATION_ACTIONS.has("rsvp"),
    }),
    buildAction("comment", {
      label: "Testify or comment",
      destination: matter.official_notice_url,
      deadline: matter.deadline,
      confirmation_required: OFFICIAL_HANDOFF_CONFIRMATION_ACTIONS.has("comment"),
    }),
    {
      type: "attend",
      label: "Prepare to attend",
      delivery: "local",
      destination: null,
      deadline: null,
      confirmation_required: false,
    },
    {
      type: "bid_checklist",
      label: "Open bid checklist",
      delivery: "local",
      destination: null,
      deadline: null,
      confirmation_required: false,
    },
    buildAction("official_application", {
      label: "Open the official application",
      destination: matter.official_application_url,
      deadline: matter.deadline,
      confirmation_required: OFFICIAL_HANDOFF_CONFIRMATION_ACTIONS.has("official_application"),
    }),
    {
      type: "return_to_matter",
      label: "Return to matter",
      delivery: "local",
      destination: matter.matter_href,
      deadline: null,
      confirmation_required: false,
    },
    {
      type: "local_note",
      label: "Add a private note",
      delivery: "local",
      destination: null,
      deadline: null,
      confirmation_required: false,
    },
  ];
  return actions.map((action) => {
    if (action.type === "document" && action.delivery !== "official_handoff") {
      return {...action, vault_fallback: !vaultEnabled};
    }
    if (action.type === "calendar" && action.delivery === "unavailable") {
      return {...action, deadline: null};
    }
    return action;
  }).map(validateAction);
}

export function outcomeEvent(value) {
  if (!OUTCOME_ENUM.includes(value)) throw new TypeError("unknown outcome");
  return Object.freeze({
    event: "outcome_recorded",
    detail: value.replace("_", "-"),
    surface: "home"
  });
}
