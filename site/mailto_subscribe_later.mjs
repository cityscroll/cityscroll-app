/**
 * Bounded later mailto subscribe experiment (FS-10).
 *
 * Encodes a reviewed Following sentence to the configured inbound address and
 * reuses the existing inbound parser plus single-opt-in enrollment. Public
 * surfaces stay closed until a named FS-05 routing, delivery-ownership, reply,
 * and composer evidence record is proven. Mailto is never a default or fallback.
 */

export const MAILTO_SUBSCRIBE_LATER_SCHEMA = "cityscroll.mailto_subscribe_later.v1";
export const MAILTO_SUBSCRIBE_LATER_VERSION = 1;
export const FS05_PREREQUISITE_SCHEMA = "cityscroll.fs05_email_domain_prerequisite.v1";
export const DEFAULT_SUBSCRIBE_ADDRESS = "subscribe@crol-list.org";
export const INBOUND_BODY_CHAR_LIMIT = 2000;
export const MAILTO_HREF_CHAR_LIMIT = 1800;
export const PREREQUISITE_MAX_AGE_DAYS = 90;
export const MAILTO_LATER_HARNESS_SHIPPED = false;

export const PREREQUISITE_AXES = Object.freeze([
  "routing",
  "delivery_ownership",
  "reply_handling",
  "composer_behavior",
]);

export const ENROLLMENT_REUSE = Object.freeze({
  parser: "worker/src/inbound.mjs#pickLens",
  interpreter: "worker/src/nl.mjs#parseLensFilter",
  enroll: "worker/src/subscribe.mjs#enrollAndWelcome",
  source: "inbound_email",
  welcome: "worker/src/subscribe.mjs#sendWelcome",
  manage: "worker/src/prefs.mjs",
  unsubscribe: "worker/src/unsubscribe.mjs",
  loop_guard: "worker/src/inbound.mjs#shouldIgnore",
  actor_cap_per_day: 5,
  surface_cap_env: "INBOUND_MAX_PER_DAY",
  opt_in: "single_opt_in",
});

export const PRIVACY_COPY_ENABLED =
  "Your mail app will send this reviewed sentence only to the CityScroll subscribe address. CityScroll does not open your inbox or add other recipients.";

export const CASE_SPECS = Object.freeze([
  {
    id: "desktop_mail_client",
    required_behavior: "external_composer_handoff; completion_unobserved",
  },
  {
    id: "mobile_mail_client",
    required_behavior: "may_lack_handler; honest_failure_no_auto_enroll",
  },
  {
    id: "webmail",
    required_behavior: "composer_handoff_unreliable; not_a_supported_fallback",
  },
  {
    id: "no_handler",
    required_behavior: "honest_failure; no_auto_enroll; no_form_bypass",
  },
  {
    id: "encoded_content",
    required_behavior: "rfc6068_subject_and_body; reviewed_destination_only",
  },
  {
    id: "completion_cap",
    required_behavior: "reuse_inbound_actor_and_surface_caps; client_cannot_count_sends",
  },
  {
    id: "loop_guard",
    required_behavior: "reuse_shouldIgnore; no_reply_to_own_domains_or_auto_submitted",
  },
  {
    id: "privacy_copy",
    required_behavior: "name_subscribe_destination_only; no_copy_when_disabled",
  },
  {
    id: "reply",
    required_behavior: "inbound_welcome_and_degraded_reply_only_after_fs05_proof",
  },
  {
    id: "routing",
    required_behavior: "named_fs05_routing_record_required; mail_leg_canary_is_not_proof",
  },
]);

export const PRIMARY_JOURNEY_FILES = Object.freeze([
  "site/following_view.mjs",
  "site/app/following.mjs",
  "site/home_entry.mjs",
  "site/following/index.html",
  "site/index.html",
]);

const DAY_MS = 86_400_000;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const FORBIDDEN_RECEIPT_TERMS = [
  "TOKEN_SECRET",
  "RESEND_API_KEY",
  "ADMIN_KEY",
  "Bearer ",
  "password",
];

function clean(value, max = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function normalizeAddress(value) {
  return clean(value, 320).toLowerCase();
}

function instant(value) {
  const parsed = Date.parse(clean(value, 80));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageDays(observedAt, now) {
  const then = instant(observedAt);
  const clock = instant(now);
  if (then == null || clock == null) return null;
  return (clock - then) / DAY_MS;
}

export function evaluatePrerequisiteAxis(axis, { now = null } = {}) {
  if (!axis || typeof axis !== "object") {
    return { status: "absent", evidence_id: null, reason: "missing_axis_record" };
  }
  const recorded = clean(axis.status, 40).toLowerCase();
  const evidenceId = clean(axis.evidence_id, 200) || null;
  const observedAt = axis.observed_at || null;
  const reason = clean(axis.reason, 500) || null;
  const age = ageDays(observedAt, now);
  if (recorded === "proven") {
    if (!evidenceId) {
      return { status: "incomplete", evidence_id: null, reason: "proven_without_named_evidence_record" };
    }
    if (age != null && age > PREREQUISITE_MAX_AGE_DAYS) {
      return { status: "stale", evidence_id: evidenceId, reason: "evidence_older_than_max_age" };
    }
    if (observedAt == null) {
      return { status: "incomplete", evidence_id: evidenceId, reason: "proven_without_observed_at" };
    }
    return { status: "proven", evidence_id: evidenceId, reason: reason || null };
  }
  if (recorded === "stale" || recorded === "absent" || recorded === "incomplete") {
    return { status: recorded, evidence_id: evidenceId, reason };
  }
  return { status: "incomplete", evidence_id: evidenceId, reason: reason || "unrecognized_axis_status" };
}

export function evaluateMailtoSubscribeLater(prerequisite, { now = null } = {}) {
  const schemaOk = clean(prerequisite?.schema, 120) === FS05_PREREQUISITE_SCHEMA;
  const axes = {};
  const stopReasons = [];
  if (!schemaOk) stopReasons.push("prerequisite:absent_or_unrecognized_schema");
  for (const id of PREREQUISITE_AXES) {
    const axis = evaluatePrerequisiteAxis(prerequisite?.axes?.[id], { now });
    axes[id] = axis;
    if (axis.status !== "proven") stopReasons.push(`${id}:${axis.status}`);
  }
  const enabled = schemaOk && stopReasons.length === 0;
  return {
    schema: MAILTO_SUBSCRIBE_LATER_SCHEMA,
    state: enabled ? "enabled_for_measurement" : "disabled_prerequisites_unproven",
    enabled,
    stop_reasons: stopReasons,
    axes,
    subscribe_address: DEFAULT_SUBSCRIBE_ADDRESS,
    removable_harness: enabled && MAILTO_LATER_HARNESS_SHIPPED,
  };
}

export function encodeReviewedSentenceMailto({
  sentence,
  subscribeAddress = DEFAULT_SUBSCRIBE_ADDRESS,
  subject = "CityScroll watch",
} = {}) {
  const destination = normalizeAddress(subscribeAddress);
  if (destination !== DEFAULT_SUBSCRIBE_ADDRESS) {
    return { ok: false, href: null, reason: "unreviewed_destination" };
  }
  const body = clean(sentence, INBOUND_BODY_CHAR_LIMIT + 1);
  const topic = clean(subject, 200);
  if (!body) return { ok: false, href: null, reason: "empty_sentence" };
  if (/[\r\n]/.test(String(sentence ?? "")) || /[\r\n]/.test(String(subject ?? ""))) {
    return { ok: false, href: null, reason: "header_injection" };
  }
  if (body.length > INBOUND_BODY_CHAR_LIMIT) {
    return { ok: false, href: null, reason: "oversized_body" };
  }
  if (!topic) return { ok: false, href: null, reason: "empty_subject" };
  const href = `mailto:${destination}?subject=${encodeURIComponent(topic)}&body=${encodeURIComponent(body)}`;
  if (href.length > MAILTO_HREF_CHAR_LIMIT) {
    return { ok: false, href: null, reason: "oversized_href" };
  }
  return { ok: true, href, destination, subject: topic, body };
}

export function projectPublicMailtoSurface({
  experiment,
  sentence,
  role = "explicit_measurement",
} = {}) {
  const withheld = {
    presented: false,
    href: null,
    default: false,
    fallback: false,
    role: role === "explicit_measurement" ? null : role,
    privacy_copy: null,
    auto_enroll: false,
  };
  if (!experiment?.enabled) {
    return { ...withheld, reason: experiment?.stop_reasons?.[0] || "prerequisites_unproven" };
  }
  if (role === "default" || role === "fallback") {
    return { ...withheld, role, reason: "mailto_is_not_a_default_or_fallback" };
  }
  if (role !== "explicit_measurement") {
    return { ...withheld, role, reason: "unsupported_presentation_role" };
  }
  const encoded = encodeReviewedSentenceMailto({ sentence });
  if (!encoded.ok) {
    return { ...withheld, reason: encoded.reason };
  }
  return {
    presented: true,
    href: encoded.href,
    default: false,
    fallback: false,
    role,
    privacy_copy: PRIVACY_COPY_ENABLED,
    auto_enroll: false,
    reason: null,
  };
}

export function findSubscribeMailtoAddresses(sourceText) {
  const text = String(sourceText ?? "");
  const found = [];
  const pattern = /mailto:([^"'?\s>]+)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const address = decodeURIComponent(match[1]).toLowerCase();
    if (address.includes("subscribe@")) found.push(address);
  }
  return found;
}

export function specifiedCases(experimentEnabled) {
  return Object.fromEntries(CASE_SPECS.map((spec) => [spec.id, {
    specified: true,
    measured: false,
    result: experimentEnabled ? "awaiting_measurement" : "not_run",
    required_behavior: spec.required_behavior,
  }]));
}

function receiptEmails(receipt) {
  return [...JSON.stringify(receipt).matchAll(EMAIL_RE)].map((row) => row[0].toLowerCase());
}

export function validateMailtoSubscribeLaterReceipt(receipt) {
  const errors = [];
  if (receipt?.schema !== MAILTO_SUBSCRIBE_LATER_SCHEMA) errors.push("schema");
  if (receipt?.version !== MAILTO_SUBSCRIBE_LATER_VERSION) errors.push("version");
  if (receipt?.workstream_card !== "FS-10") errors.push("workstream_card");
  if (receipt?.auto_enrollment !== false) errors.push("auto_enrollment");
  if (receipt?.email_sent !== false) errors.push("email_sent");
  if (receipt?.dns_altered !== false) errors.push("dns_altered");
  if (receipt?.deliverability_claimed !== false) errors.push("deliverability_claimed");
  if (receipt?.removable_harness_shipped !== false) errors.push("removable_harness_shipped");
  if (receipt?.ui?.default !== false || receipt?.ui?.fallback !== false || receipt?.ui?.presented !== false) {
    errors.push("ui_must_stay_closed");
  }
  if (receipt?.subscribe_address !== DEFAULT_SUBSCRIBE_ADDRESS) errors.push("subscribe_address");
  if (!Array.isArray(receipt?.primary_journey_subscribe_mailto) || receipt.primary_journey_subscribe_mailto.length) {
    errors.push("primary_journey_must_omit_subscribe_mailto");
  }
  for (const spec of CASE_SPECS) {
    const row = receipt?.cases?.[spec.id];
    if (!row?.specified || row.required_behavior !== spec.required_behavior) errors.push(`case:${spec.id}`);
  }
  const serialized = JSON.stringify(receipt || {});
  for (const term of FORBIDDEN_RECEIPT_TERMS) {
    if (serialized.includes(term)) errors.push(`credential_term:${term.trim()}`);
  }
  const extra = receiptEmails(receipt).filter((address) => address !== DEFAULT_SUBSCRIBE_ADDRESS);
  if (extra.length) errors.push("address_leakage");
  if (receipt?.enabled === true && receipt?.experiment_state !== "enabled_for_measurement") {
    errors.push("enabled_state_mismatch");
  }
  if (receipt?.enabled === true) errors.push("committed_receipt_must_remain_disabled_until_fs05");
  return { ok: errors.length === 0, errors };
}

export function buildMailtoSubscribeLaterReceipt({
  prerequisite,
  primaryJourneyHits = [],
  now = null,
} = {}) {
  const experiment = evaluateMailtoSubscribeLater(prerequisite, { now });
  const stopReasons = experiment.enabled
    ? ["committed_receipt_refuses_to_enable_without_shipping_a_harness"]
    : experiment.stop_reasons;
  return {
    schema: MAILTO_SUBSCRIBE_LATER_SCHEMA,
    version: MAILTO_SUBSCRIBE_LATER_VERSION,
    workstream_card: "FS-10",
    generated_at: clean(prerequisite?.observed_at, 80) || null,
    experiment_state: "disabled_prerequisites_unproven",
    enabled: false,
    removable_harness_shipped: MAILTO_LATER_HARNESS_SHIPPED,
    subscribe_address: DEFAULT_SUBSCRIBE_ADDRESS,
    encoding: {
      method: "rfc6068_mailto_subject_body",
      destination_allowlist: [DEFAULT_SUBSCRIBE_ADDRESS],
      inbound_body_char_limit: INBOUND_BODY_CHAR_LIMIT,
      href_char_limit: MAILTO_HREF_CHAR_LIMIT,
    },
    enrollment_reuse: { ...ENROLLMENT_REUSE },
    ui: {
      default: false,
      fallback: false,
      presented: false,
    },
    auto_enrollment: false,
    email_sent: false,
    dns_altered: false,
    deliverability_claimed: false,
    primary_journey_subscribe_mailto: [...primaryJourneyHits],
    prerequisites: {
      schema: FS05_PREREQUISITE_SCHEMA,
      axes: experiment.axes,
      stop_reasons: experiment.stop_reasons,
    },
    cases: specifiedCases(false),
    privacy: {
      credentials_present: false,
      resident_addresses_present: false,
      destination_addresses: [DEFAULT_SUBSCRIBE_ADDRESS],
      sentence_copied_to_mail_client: false,
    },
    measured_stop: {
      reason: "fs05_routing_delivery_reply_and_composer_prerequisites_unproven",
      details: stopReasons,
    },
  };
}
