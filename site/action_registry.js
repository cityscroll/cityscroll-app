(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CrolActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OUTCOME_ENUM = Object.freeze(["submitted", "attended", "bid", "won", "not_useful"]);
  const ACTION_TYPES = Object.freeze([
    "watch", "calendar", "document", "contact", "rsvp", "comment", "attend",
    "bid_checklist", "official_application", "return_to_matter", "local_note",
  ]);
  const ACTION_DELIVERIES = Object.freeze(["local", "official_handoff", "unavailable"]);
  const CONFIRMATION_ACTIONS = new Set(["rsvp", "comment", "official_application"]);
  const PASSPORT_RFX_URL = "https://a0333-passportpublic.nyc.gov/rfx.html";
  const NYCHA_ISUPPLIER_URL = "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page";

  function httpsUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : null;
    } catch (_error) {
      return null;
    }
  }

  function validateAction(action) {
    if (!ACTION_TYPES.includes(action.type)) throw new TypeError(`unknown action type: ${action.type}`);
    if (!ACTION_DELIVERIES.includes(action.delivery)) throw new TypeError(`unknown action delivery: ${action.delivery}`);
    if (typeof action.confirmation_required !== "boolean") throw new TypeError("action confirmation must be boolean");
    if (action.delivery === "official_handoff") {
      if (!httpsUrl(action.destination)) throw new TypeError("official handoff requires a visible HTTPS destination");
      if (!action.destination_label) throw new TypeError("official handoff requires a destination label");
    }
    if (action.delivery === "unavailable") {
      if (action.destination || action.destination_label) throw new TypeError("unavailable actions cannot include a destination");
      if (action.confirmation_required) throw new TypeError("unavailable actions cannot require confirmation");
    }
    return action;
  }

  function official(type, labelKey, fallbackLabel, destination, deadline, extra) {
    const safe = httpsUrl(destination);
    if (!safe) return unavailable(type, "next_action_unavailable_handoff", "The official action link is not published here.", deadline);
    return validateAction({
      type,
      label_key: labelKey,
      label: fallbackLabel,
      delivery: "official_handoff",
      destination: safe,
      destination_label: new URL(safe).hostname,
      deadline: deadline || null,
      confirmation_required: CONFIRMATION_ACTIONS.has(type),
      ...(extra || {}),
    });
  }

  function local(type, labelKey, fallbackLabel, destination, deadline) {
    return validateAction({
      type,
      label_key: labelKey,
      label: fallbackLabel,
      delivery: "local",
      destination: destination || null,
      deadline: deadline || null,
      confirmation_required: type === "watch",
    });
  }

  function unavailable(type, labelKey, fallbackLabel, deadline) {
    return validateAction({
      type,
      label_key: labelKey,
      label: fallbackLabel,
      delivery: "unavailable",
      deadline: deadline || null,
      confirmation_required: false,
    });
  }

  function kindFor(matter) {
    if (matter.kind) return matter.kind;
    const section = String(matter.section_name || "");
    const type = String(matter.type_of_notice_description || "");
    if (section === "Agency Rules") return "rule";
    if (section === "Public Hearings and Meetings" || /hearing|meeting/i.test(type)) return "hearing";
    if (type === "Solicitation") return "solicitation";
    if (/Award/.test(type)) return "award";
    return "notice";
  }

  function isPast(date, today) {
    if (!date) return false;
    const d = String(date).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today;
  }

  function passportShaped(value) {
    return /^\d{5}[A-Z]\d{4}(?:\d{3})?$/i.test(String(value || "").replace(/[^a-z0-9]/gi, ""));
  }

  function noticeNamedPortal(body) {
    const systems = [
      {name: "OpenGov", token: /\bOpenGov\b/i, hosts: ["procurement.opengov.com"]},
      {name: "Bonfire", token: /\bBonfire\b/i, hosts: ["bonfirehub.com"]},
      {name: "BidNet", token: /\bBidNet(?:\s+Direct)?\b/i, hosts: ["bidnetdirect.com"]},
    ];
    const urls = String(body || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
    for (const system of systems) {
      if (!system.token.test(body)) continue;
      for (const raw of urls) {
        const cleaned = raw.replace(/&amp;/gi, "&").replace(/[),.;]+$/g, "");
        const safe = httpsUrl(cleaned);
        if (!safe) continue;
        const host = new URL(safe).hostname.toLowerCase();
        if (system.hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) {
          return {name: system.name, destination: safe};
        }
      }
    }
    return null;
  }

  // A solicitation handoff is an evidence record, not a guessed deep link. PASSPort Public
  // exposes a searchable RFx browse surface but no stable per-RFx URL, so matched and unmatched
  // records both carry the exact search terms the reader needs. Agency-specific systems only win
  // when the notice itself names the system.
  function solicitationHandoff(matter) {
    const body = String(matter.notice_text || "");
    const agency = String(matter.agency_name || "");
    const pin = String(matter.pin || "").trim() || null;
    const title = String(matter.title || "").trim() || null;
    const rfx = matter.rfx_detail || null;
    const detail = rfx && rfx.status === "matched" ? (rfx.detail || {}) : null;
    const explicitUrl = httpsUrl(matter.official_application_url);

    if (/housing authority|\bnycha\b/i.test(agency) && /\bisupplier\b/i.test(body)) {
      return {
        system: "nycha_isupplier",
        mode: "notice_named",
        destination: NYCHA_ISUPPLIER_URL,
        label_key: "open_nycha_isupplier",
        label: "Open NYCHA iSupplier guide",
        identifier: pin,
        procurement_name: title,
        status: null,
        approval_delay: /24\s*(?:to|–|-)\s*72\s*hours/i.test(body),
      };
    }

    const namedPortal = noticeNamedPortal(body);
    if (namedPortal) {
      return {
        system: "notice_portal",
        system_name: namedPortal.name,
        mode: "notice_named",
        destination: namedPortal.destination,
        label_key: "open_notice_submission_portal",
        label: "Open the submission portal",
        identifier: pin,
        procurement_name: title,
        status: null,
      };
    }

    if (detail) {
      return {
        system: "passport",
        mode: "matched",
        destination: httpsUrl(rfx.portal) || PASSPORT_RFX_URL,
        label_key: "search_passport_rfx",
        label: "Find this RFx in PASSPort",
        identifier: String(detail.epin || pin || "").trim() || null,
        procurement_name: String(detail.procurement_name || title || "").trim() || null,
        status: String(detail.rfx_status || "").trim() || null,
      };
    }

    const passportEvidence = passportShaped(pin)
      || /\bpassport\b/i.test(body)
      || (explicitUrl && /(^|\.)passport\./i.test(new URL(explicitUrl).hostname));
    if (passportEvidence) {
      return {
        system: "passport",
        mode: "search_only",
        destination: PASSPORT_RFX_URL,
        label_key: "search_passport_rfx",
        label: "Search PASSPort RFx",
        identifier: pin,
        procurement_name: title,
        status: null,
      };
    }

    return {
      system: null,
      mode: "notice_only",
      destination: null,
      label_key: "next_action_response_instructions",
      label: "Use the response instructions in the official notice.",
      identifier: pin,
      procurement_name: title,
      status: null,
    };
  }

  function compileActionRail(matter, options) {
    const opts = options || {};
    const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const kind = kindFor(matter || {});
    const stage = String(matter.lifecycle_stage || "").toLowerCase();
    const deadline = matter.deadline || null;
    const watch = local("watch", "next_action_watch", "Watch this notice", "#alerts", null);
    const calendar = local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, deadline);
    const notice = () => official("document", "read_official_notice", "Read the official notice", matter.official_notice_url, deadline);
    let actions;

    if (kind === "solicitation") {
      const closed = stage === "closed" || (!matter.rolling_deadline && isPast(deadline, today));
      const handoff = solicitationHandoff(matter);
      actions = closed
        ? [unavailable("official_application", "next_action_bid_closed", "The response deadline has passed.", deadline), notice(), watch]
        : handoff.destination
          ? [official("official_application", handoff.label_key, handoff.label, handoff.destination, deadline, {guide: handoff})]
          : [unavailable("official_application", handoff.label_key, handoff.label, deadline)];
      if (!closed && deadline && !matter.rolling_deadline) actions.push(calendar);
      if (!closed) actions.push(watch);
    } else if (kind === "rule") {
      const open = stage === "comment-open" && !isPast(deadline, today);
      actions = open
        ? [official("comment", "rule_comment_btn", "Comment on the official rule page", matter.comment_url || matter.official_notice_url, deadline), calendar, watch]
        : [unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", deadline), notice(), watch];
    } else if (kind === "hearing") {
      const past = stage === "past" || isPast(deadline, today);
      actions = past
        ? [unavailable("attend", "next_action_event_passed", "This event has passed.", deadline), notice(), watch]
        : [matter.participation_url
          ? official("attend", "join_online", "Join online", matter.participation_url, deadline)
          : unavailable("attend", "next_action_participation_missing", "No online participation link is published in this notice.", deadline)];
      if (!past && deadline) actions.push(calendar);
      if (!past) actions.push(watch);
    } else if (kind === "zoning") {
      const active = !stage || ["active", "public-review", "hearing"].includes(stage);
      actions = active
        ? [official("comment", "view_comment_zap", "View and comment on ZAP", matter.project_url, deadline), watch]
        : [unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", deadline), notice(), watch];
    } else if (kind === "exam") {
      const open = stage === "open";
      actions = open
        ? [official("official_application", "career_apply_oasys", "Apply in OASys", matter.official_application_url, deadline), calendar, notice()]
        : [unavailable("official_application", stage === "closed" ? "next_action_exam_closed" : "next_action_exam_not_open", stage === "closed" ? "The application window has closed." : "Applications are not open yet.", deadline), notice()];
    } else {
      actions = [notice(), watch];
    }

    return actions.slice(0, 3).map(validateAction);
  }

  function outcomeEvent(value) {
    if (!OUTCOME_ENUM.includes(value)) throw new TypeError("unknown outcome");
    return Object.freeze({event: "outcome_recorded", detail: value.replace("_", "-"), surface: "home"});
  }

  return {OUTCOME_ENUM, compileActionRail, solicitationHandoff, validateAction, outcomeEvent};
});
