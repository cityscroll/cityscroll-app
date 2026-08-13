// Cross-spine agreement checks over pure fixture subject bundles.
// Compares ER identity keys, process-spine join confidence, lifecycle stages,
// and civic-time subject refs without selecting a "winner".

export const CROSS_SPINE_SCHEMA = "cityscroll.cross_spine_bundle.v0";

// This is the public confidence vocabulary. Keep it closed: a cross-spine
// check compares claims, but does not choose a winner or merge identities.
export const CROSS_SPINE_CONFIDENCE = Object.freeze(["confirmed", "review", "unmatched"]);
const CONFIDENCE = new Set(CROSS_SPINE_CONFIDENCE);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeCrossSpineConfidence(value) {
  const candidate = typeof value === "object" && value !== null
    ? value.confidence || value.join_confidence || value.status
    : value;
  const normalized = clean(candidate).toLowerCase();
  return CONFIDENCE.has(normalized) ? normalized : null;
}

function normId(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * @param {object} bundle — one subject with optional spines
 * @returns {{ subject_ref, checks: Array, contradictions: number, ok: boolean }}
 */
export function validateCrossSpineBundle(bundle = {}) {
  if (!bundle || typeof bundle !== "object") {
    throw new TypeError("cross-spine bundle must be an object");
  }
  if (bundle.schema && bundle.schema !== CROSS_SPINE_SCHEMA) {
    throw new TypeError(`expected schema ${CROSS_SPINE_SCHEMA}`);
  }
  const subjectRef = clean(bundle.subject_ref);
  if (!subjectRef) throw new TypeError("subject_ref is required");

  const checks = [];
  const er = bundle.er || {};
  const process = bundle.process_spine || {};
  const lifecycle = bundle.lifecycle || {};
  const civicTime = Array.isArray(bundle.civic_time_events) ? bundle.civic_time_events : [];
  const actions = bundle.actions || {};

  // 1. PIN/EPIN identity agreement
  const erPin = normId(er.pin || er.epin);
  const lifePin = normId(lifecycle.pin || lifecycle.epin);
  if (erPin && lifePin) {
    const pass = erPin === lifePin;
    checks.push({
      id: "pin_identity",
      pass,
      left: { spine: "er", value: er.pin || er.epin },
      right: { spine: "lifecycle", value: lifecycle.pin || lifecycle.epin },
      detail: pass ? "ER and lifecycle share the same PIN/EPIN key" : "Disjoint hard PIN/EPIN identifiers",
    });
  }

  // 2. Vendor stem agreement when both present
  const erVendor = clean(er.vendor_stem || er.vendor_name).toLowerCase();
  const lifeVendor = clean(lifecycle.vendor_stem || lifecycle.vendor_name).toLowerCase();
  if (erVendor && lifeVendor) {
    const pass = erVendor === lifeVendor
      || erVendor.includes(lifeVendor)
      || lifeVendor.includes(erVendor);
    checks.push({
      id: "vendor_identity",
      pass,
      left: { spine: "er", value: er.vendor_stem || er.vendor_name },
      right: { spine: "lifecycle", value: lifecycle.vendor_stem || lifecycle.vendor_name },
      detail: pass ? "Vendor stems compatible" : "Vendor stems disagree",
    });
  }

  // 3. Process join confidence vs ER decision
  const joinConf = clean(process.join_confidence || process.join?.confidence);
  const erDecision = clean(er.decision);
  if (joinConf) {
    if (!CONFIDENCE.has(joinConf)) {
      checks.push({
        id: "process_confidence_enum",
        pass: false,
        left: { spine: "process_spine", value: joinConf },
        right: { spine: "allowlist", value: [...CONFIDENCE].join("|") },
        detail: "Unknown process join confidence",
      });
    } else if (joinConf === "confirmed" && (erDecision === "separate" || erDecision === "never_auto")) {
      checks.push({
        id: "confirmed_vs_er_separate",
        pass: false,
        left: { spine: "process_spine", value: joinConf },
        right: { spine: "er", value: erDecision },
        detail: "Process confirmed join over explicit ER separate/never_auto",
      });
    } else {
      checks.push({
        id: "process_confidence_enum",
        pass: true,
        left: { spine: "process_spine", value: joinConf },
        right: { spine: "er", value: erDecision || null },
        detail: "Process confidence compatible with ER decision",
      });
    }
  }

  // 4. Civic-time subject_ref consistency
  for (const event of civicTime) {
    const eventSubject = clean(event.subject_ref);
    const pass = !eventSubject || eventSubject === subjectRef
      || eventSubject.startsWith(subjectRef)
      || subjectRef.startsWith(eventSubject.split(":")[0] + ":");
    // stricter: must equal or share prefix kind
    const strict = !eventSubject || eventSubject === subjectRef
      || normId(eventSubject) === normId(subjectRef)
      || extractKey(eventSubject) === extractKey(subjectRef);
    checks.push({
      id: "civic_time_subject",
      pass: strict,
      left: { spine: "bundle", value: subjectRef },
      right: { spine: "civic_time", value: eventSubject || null, event_kind: event.event_kind || null },
      detail: strict ? "Civic-time event subject aligns" : "Civic-time event subject_ref mismatch",
    });
  }

  // 5. Stage ordering: registration before payment when both dated
  const regAt = clean(lifecycle.registered_at || lifecycle.award_registered_at);
  const payAt = clean(lifecycle.first_payment_at);
  if (regAt && payAt) {
    const pass = payAt >= regAt;
    checks.push({
      id: "stage_order_registration_payment",
      pass,
      left: { spine: "lifecycle", field: "registered_at", value: regAt },
      right: { spine: "lifecycle", field: "first_payment_at", value: payAt },
      detail: pass ? "Payment not before registration" : "Payment timestamp before registration without supersession",
    });
  }

  // 6. Actionability honesty: lookup_status error must not be confident empty
  const lookup = clean(actions.lookup_status || lifecycle.lookup_status);
  const handoff = clean(actions.handoff_delivery);
  if (lookup === "error" && handoff === "unavailable" && actions.confident_empty === true) {
    checks.push({
      id: "lookup_error_not_empty_miss",
      pass: false,
      left: { spine: "actions", value: "lookup_status=error" },
      right: { spine: "actions", value: "confident_empty=true" },
      detail: "Error lookup rendered as confident empty miss",
    });
  } else if (lookup) {
    checks.push({
      id: "lookup_error_not_empty_miss",
      pass: true,
      left: { spine: "actions", value: lookup },
      right: { spine: "actions", value: handoff || null },
      detail: "Lookup status / handoff presentation coherent",
    });
  }

  const contradictions = checks.filter((c) => !c.pass).length;
  return {
    schema: CROSS_SPINE_SCHEMA,
    subject_ref: subjectRef,
    checks,
    checked: checks.length,
    contradictions,
    ok: contradictions === 0,
  };
}

function extractKey(ref) {
  const text = clean(ref);
  const parts = text.split(":");
  return normId(parts.length > 1 ? parts.slice(1).join(":") : text);
}

export function validateCrossSpineFixtures(bundles) {
  const list = Array.isArray(bundles) ? bundles : [];
  const results = list.map((bundle) => validateCrossSpineBundle(bundle));
  const contradictions = results.reduce((sum, r) => sum + r.contradictions, 0);
  return {
    schema: CROSS_SPINE_SCHEMA,
    bundle_count: results.length,
    checked: results.reduce((sum, r) => sum + r.checked, 0),
    contradictions,
    ok: contradictions === 0,
    results,
  };
}
