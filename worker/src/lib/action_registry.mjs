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

export function validateAction(action) {
  if (!ACTION_TYPES.includes(action.type)) throw new TypeError(`unknown action type: ${action.type}`);
  if (action.boundary === "official_handoff") {
    if (!action.destination?.startsWith("https://")) throw new TypeError("official handoff requires a visible HTTPS destination");
    if (!action.destination_label) throw new TypeError("official handoff requires a destination label");
  }
  if (action.handled === "local" && action.destination?.startsWith("https://")) {
    throw new TypeError("local actions cannot silently become external handoffs");
  }
  return action;
}

export function compileActionRail(matter, {vaultEnabled = false} = {}) {
  const documentDestination = vaultEnabled && matter.document?.vault_hash
    ? `https://api.cityscroll.org/source-vault/${matter.document.vault_hash}`
    : matter.document?.official_url;
  const actions = [
    {type: "watch", label: "Watch this matter", handled: "local", boundary: "direct", destination: "index.html#alerts"},
    {type: "calendar", label: "Add deadline to calendar", handled: "local", boundary: "direct", destination: null, deadline: matter.deadline},
    {type: "document", label: vaultEnabled ? "View kept document" : "Open official document", handled: "handoff", boundary: "official_handoff", destination: documentDestination, destination_label: new URL(documentDestination).hostname, vault_fallback: !vaultEnabled},
    {type: "contact", label: "Contact the responsible office", handled: "handoff", boundary: "official_handoff", destination: matter.official_contact_url, destination_label: new URL(matter.official_contact_url).hostname},
    {type: "rsvp", label: "RSVP on the official site", handled: "handoff", boundary: "official_handoff", destination: matter.official_notice_url, destination_label: new URL(matter.official_notice_url).hostname},
    {type: "comment", label: "Testify or comment", handled: "handoff", boundary: "official_handoff", destination: matter.official_notice_url, destination_label: new URL(matter.official_notice_url).hostname},
    {type: "attend", label: "Prepare to attend", handled: "local", boundary: "direct", destination: null},
    {type: "bid_checklist", label: "Open bid checklist", handled: "local", boundary: "direct", destination: null},
    {type: "official_application", label: "Open the official application", handled: "handoff", boundary: "official_handoff", destination: matter.official_application_url, destination_label: new URL(matter.official_application_url).hostname},
    {type: "return_to_matter", label: "Return to matter", handled: "local", boundary: "direct", destination: matter.matter_href},
    {type: "local_note", label: "Add a private note", handled: "local", boundary: "direct", destination: null}
  ];
  return actions.map(validateAction);
}

export function outcomeEvent(value) {
  if (!OUTCOME_ENUM.includes(value)) throw new TypeError("unknown outcome");
  return Object.freeze({
    event: "outcome_recorded",
    detail: value.replace("_", "-"),
    surface: "home"
  });
}
