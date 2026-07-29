export const DELIVERY_EVIDENCE = Object.freeze({
  direct_acceptance: 4,
  published_milestone: 3,
  payment_proxy: 2,
  unknown: 1
});

export function validateDeliveryEvent(event) {
  if (!Object.hasOwn(DELIVERY_EVIDENCE, event.evidence_level)) {
    throw new TypeError(`unknown delivery evidence level: ${event.evidence_level}`);
  }
  if (!event.process_id || !event.source || !event.source_url || !event.schema_version) {
    throw new TypeError("delivery event provenance is incomplete");
  }
  if (event.evidence_level === "payment_proxy" && event.delivery_status !== "unknown") {
    throw new TypeError("payment cannot establish delivery or acceptance");
  }
  if (event.evidence_level === "unknown" && !event.missing_reason) {
    throw new TypeError("unknown delivery needs a missingness reason");
  }
  return event;
}

export function adaptMtaCapitalRow(row) {
  return validateDeliveryEvent({
    process_id: row.process_id,
    event_id: `mta:${row.project_id}:${row.milestone_id}`,
    event_type: "delivery.milestone",
    evidence_level: "published_milestone",
    delivery_status: row.status,
    planned_at: row.planned_date,
    observed_at: row.actual_date,
    label: row.milestone_name,
    source: "MTA Capital Program Dashboard",
    source_url: row.source_url,
    schema_version: row.schema_version,
    missing_reason: row.actual_date ? null : "not_published"
  });
}

export function adaptDdcProjectRow(row) {
  return validateDeliveryEvent({
    process_id: row.process_id,
    event_id: `ddc:${row.project_id}:${row.milestone_id}`,
    event_type: "delivery.milestone",
    evidence_level: "published_milestone",
    delivery_status: row.status,
    planned_at: row.planned_date,
    observed_at: row.actual_date,
    label: row.milestone_name,
    change_reason: row.delay_reason || null,
    source: "NYC DDC project data",
    source_url: row.source_url,
    schema_version: row.schema_version,
    missing_reason: row.actual_date ? null : "not_published"
  });
}

export function adaptAcceptanceRecord(row) {
  return validateDeliveryEvent({
    process_id: row.process_id,
    event_id: row.record_id,
    event_type: "delivery.accepted",
    evidence_level: "direct_acceptance",
    delivery_status: "accepted",
    planned_at: null,
    observed_at: row.accepted_at,
    label: row.scope,
    accepted_by: row.accepted_by,
    source: "Published acceptance record",
    source_url: row.source_url,
    schema_version: row.schema_version,
    missing_reason: null
  });
}

export function adaptPaymentProxy(row) {
  return validateDeliveryEvent({
    process_id: row.process_id,
    event_id: `payment-proxy:${row.source_key}`,
    event_type: "delivery.payment_proxy",
    evidence_level: "payment_proxy",
    delivery_status: "unknown",
    planned_at: null,
    observed_at: row.paid_at,
    amount: {currency: "USD", value: row.amount},
    label: "Payment recorded; delivery not established",
    source: "Checkbook NYC",
    source_url: row.source_url,
    schema_version: "checkbook-payment-v1",
    missing_reason: "not_published"
  });
}

export function unknownDelivery(row) {
  return validateDeliveryEvent({
    process_id: row.process_id,
    event_id: `delivery-unknown:${row.process_id}`,
    event_type: "delivery.unknown",
    evidence_level: "unknown",
    delivery_status: "unknown",
    planned_at: null,
    observed_at: row.checked_at,
    label: "No public delivery status found",
    sources_checked: row.sources_checked,
    source: "Coverage ledger",
    source_url: "https://cityscroll.org/data.html",
    schema_version: "coverage-ledger-v1",
    missing_reason: row.reason
  });
}

export function strongestDeliveryEvidence(events) {
  return [...events].sort((a, b) =>
    DELIVERY_EVIDENCE[b.evidence_level] - DELIVERY_EVIDENCE[a.evidence_level] ||
    String(b.observed_at || "").localeCompare(String(a.observed_at || ""))
  )[0] || null;
}
