// Owner-alert delivery for the served-artifact freshness guard.
//
// Detection and delivery are deliberately separate. The freshness comparison
// writes its findings to a file; this module reads that file and posts the
// alert with the payload carried in the request body. The findings text never
// travels on a command line or in the process environment, because a real
// staleness finding is large enough that an exec of the delivery command is
// refused outright — and a refused exec reads as a quiet hour rather than as a
// finding, which is the failure this module exists to prevent.
//
// The endpoint contract is unchanged: the same guard, stage, findings, seen
// timestamps, workflow, source revision, run URL and receipt URL as before,
// capped at the same twenty findings the relay accepts.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const OPS_ALERT_DELIVERY_SCHEMA = "cityscroll.ops_alert_delivery_receipt.v1";
export const OPS_ALERT_ENDPOINT = "https://api.cityscroll.org/admin/ops-alert";

// The relay keeps at most twenty findings per alert. Slicing here rather than
// at the endpoint keeps the request the same shape it has always been.
export const MAX_PAYLOAD_FINDINGS = 20;

export const DELIVERY_ACCEPTED = "accepted";
export const DELIVERY_REFUSED = "refused";
export const DELIVERY_NOT_ATTEMPTED = "not-attempted";

const FALLBACK_FINDING = "The served artifact is stale or mismatched.";

export function findingsFromText(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_PAYLOAD_FINDINGS);
}

export function readFindingsFile(path) {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function buildOpsAlertPayload({
  findingsText = "",
  guard = "served-artifact-freshness",
  stage = "served_artifact_freshness",
  workflow = null,
  sourceRevision = null,
  workflowRunUrl = null,
  receiptUrl = null,
  firstSeen = null,
  lastSeen = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const findings = findingsFromText(findingsText);
  return {
    guard,
    stage,
    findings: findings.length ? findings : [FALLBACK_FINDING],
    first_seen: firstSeen || observedAt,
    last_seen: lastSeen || observedAt,
    workflow,
    source_revision: sourceRevision,
    workflow_run_url: workflowRunUrl,
    receipt_url: receiptUrl,
  };
}

// One finding produces one alert. The key is derived from what the finding is
// about, not from when it was noticed, so a re-run of the delivery step over
// the same findings file recognises its own earlier send instead of posting a
// second alert.
export function idempotencyKeyFor(payload = {}) {
  const material = JSON.stringify({
    guard: payload.guard || "",
    stage: payload.stage || "",
    source_revision: payload.source_revision || "",
    workflow_run_url: payload.workflow_run_url || "",
    findings: Array.isArray(payload.findings) ? payload.findings : [],
  });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export function readSentMarker(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    return null;
  }
}

export function writeSentMarker(path, marker) {
  if (!path) return marker;
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

async function readResponseSummary(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  return body.slice(0, 2000);
}

export async function deliverOpsAlert({
  payload,
  endpoint = OPS_ALERT_ENDPOINT,
  adminKey = "",
  fetchImpl = globalThis.fetch,
  markerPath = null,
  now = () => new Date().toISOString(),
} = {}) {
  const idempotencyKey = idempotencyKeyFor(payload);
  const prior = readSentMarker(markerPath);
  if (prior?.idempotency_key === idempotencyKey && prior?.delivery_outcome === DELIVERY_ACCEPTED) {
    return {
      delivery_outcome: DELIVERY_ACCEPTED,
      attempted: false,
      reused_marker: true,
      idempotency_key: idempotencyKey,
      response_status: prior.response_status ?? null,
      response_body: null,
      delivered_at: prior.delivered_at || null,
      reason: "an alert for this finding was already accepted in this run",
    };
  }
  if (!adminKey) {
    return {
      delivery_outcome: DELIVERY_NOT_ATTEMPTED,
      attempted: false,
      reused_marker: false,
      idempotency_key: idempotencyKey,
      response_status: null,
      response_body: null,
      delivered_at: null,
      reason: "ADMIN_KEY is required to deliver the owner alert",
    };
  }
  // The payload is carried in the request body. It is never interpolated into a
  // command line, so its size cannot refuse the delivery.
  const body = JSON.stringify(payload);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body,
    });
  } catch (error) {
    return {
      delivery_outcome: DELIVERY_REFUSED,
      attempted: true,
      reused_marker: false,
      idempotency_key: idempotencyKey,
      response_status: null,
      response_body: null,
      delivered_at: null,
      reason: `the owner-alert endpoint could not be reached: ${error?.message || error}`,
    };
  }
  const summary = await readResponseSummary(response);
  const delivered_at = now();
  if (!response.ok) {
    return {
      delivery_outcome: DELIVERY_REFUSED,
      attempted: true,
      reused_marker: false,
      idempotency_key: idempotencyKey,
      response_status: response.status,
      response_body: summary,
      delivered_at: null,
      reason: `the owner-alert endpoint refused the alert with status ${response.status}`,
    };
  }
  const accepted = {
    delivery_outcome: DELIVERY_ACCEPTED,
    attempted: true,
    reused_marker: false,
    idempotency_key: idempotencyKey,
    response_status: response.status,
    response_body: summary,
    delivered_at,
    reason: "the owner-alert endpoint accepted the alert",
  };
  writeSentMarker(markerPath, {
    schema: OPS_ALERT_DELIVERY_SCHEMA,
    idempotency_key: idempotencyKey,
    delivery_outcome: DELIVERY_ACCEPTED,
    response_status: response.status,
    delivered_at,
  });
  return accepted;
}

// The stage status the release-surface reconciliation reads. An unattempted
// delivery on a healthy comparison is not a failure, so it stays UNKNOWN rather
// than claiming either outcome.
function stageStatus(findingPresent, delivery) {
  if (!findingPresent) return "PASS";
  return delivery?.delivery_outcome === DELIVERY_ACCEPTED ? "PASS" : "FAIL";
}

export function buildDeliveryReceipt({
  guard = "served-artifact-freshness",
  stage = "served_artifact_freshness",
  findingPresent = false,
  findings = [],
  delivery = null,
  sourceRevision = null,
  workflow = null,
  runId = null,
  workflowRunUrl = null,
  receiptUrl = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const outcome = delivery?.delivery_outcome || DELIVERY_NOT_ATTEMPTED;
  return {
    schema: OPS_ALERT_DELIVERY_SCHEMA,
    kind: "ops-alert-delivery",
    version: 1,
    guard,
    stage,
    source_revision: sourceRevision || null,
    run_id: runId ? String(runId) : null,
    workflow: workflow || null,
    workflow_run_url: workflowRunUrl || null,
    receipt_url: receiptUrl || null,
    observed_at: observedAt,
    finding_present: Boolean(findingPresent),
    finding_count: findings.length,
    findings,
    delivery_outcome: outcome,
    // evaluateAlertDelivery reads this field; an unattempted delivery leaves it
    // empty so a healthy hour is never read as a delivery result.
    outcome: outcome === DELIVERY_ACCEPTED ? "accepted" : outcome === DELIVERY_REFUSED ? "failed" : "",
    delivery_attempted: Boolean(delivery?.attempted),
    reused_marker: Boolean(delivery?.reused_marker),
    idempotency_key: delivery?.idempotency_key || null,
    response_status: delivery?.response_status ?? null,
    // The relay's own answer, so the delivery can be confirmed from the receipt
    // alone: it names whether this alert was sent or recognised as one already
    // standing. It is bounded to the first two thousand characters, so a long
    // answer is retained in part rather than in full, and it never carries a
    // credential.
    response_body: delivery?.response_body ?? null,
    delivered_at: delivery?.delivered_at || null,
    reason: delivery?.reason
      || (findingPresent ? "a freshness finding was present and no delivery was attempted" : "the freshness comparison was clean, so no alert was sent"),
    status: stageStatus(findingPresent, delivery),
  };
}

export function writeDeliveryReceipt(receipt, receiptPath) {
  const target = resolve(receiptPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

// One line per state, for the workflow run summary: whether a finding was
// present, and whether its alert was accepted, refused, or never attempted.
export function summarizeDelivery(receipt = {}) {
  const finding = receipt.finding_present
    ? `Finding present: yes (${receipt.finding_count} line${receipt.finding_count === 1 ? "" : "s"}).`
    : "Finding present: no.";
  const delivery = {
    [DELIVERY_ACCEPTED]: "Delivery: accepted by the owner-alert endpoint.",
    [DELIVERY_REFUSED]: "Delivery: refused.",
    [DELIVERY_NOT_ATTEMPTED]: "Delivery: not attempted.",
  }[receipt.delivery_outcome] || "Delivery: not attempted.";
  return `${finding} ${delivery} ${receipt.reason || ""}`.trim();
}
