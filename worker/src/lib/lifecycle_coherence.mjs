/**
 * Procurement lifecycle coherence — detect orphaned / contradictory stages
 * and measure procurement_lifecycle_coherence_rate.
 *
 * Findings (closed set):
 *   - orphaned_award: matched award with no solicitation stage on the timeline
 *   - payment_exceeds_commitment: paid-to-date exceeds award/registered commitment
 *   - out_of_order_dates: matched stage dates violate solicitation→…→payment order
 *
 * Pure module (no fetch, no env). assembleLifecycle stamps a bounded
 * `coherence` side-car; the rate is measured offline over field cases.
 *
 * Stage names are local string constants matching checkbook_lifecycle STAGES
 * (no import — avoids a circular dependency with assembleLifecycle).
 */

export const LIFECYCLE_COHERENCE_VERSION = "lifecycle_coherence_v1";

/** Same succession order as checkbook_lifecycle.STAGES. */
export const STAGE_SOLICITATION = "solicitation";
export const STAGE_AWARD = "award";
export const STAGE_PENDING = "pending";
export const STAGE_REGISTERED = "registered";
export const STAGE_PAYMENT = "payment";
export const STAGES = Object.freeze([
  STAGE_SOLICITATION,
  STAGE_AWARD,
  STAGE_PENDING,
  STAGE_REGISTERED,
  STAGE_PAYMENT,
]);

/** Closed issue-kind registry for counters and tests. */
export const COHERENCE_ISSUE_KINDS = Object.freeze({
  orphaned_award: {
    id: "orphaned_award",
    summary: "Matched award stage has no solicitation stage on the timeline",
  },
  payment_exceeds_commitment: {
    id: "payment_exceeds_commitment",
    summary: "Paid-to-date exceeds the award or registered commitment amount",
  },
  out_of_order_dates: {
    id: "out_of_order_dates",
    summary: "Matched stage dates are out of chronological order",
  },
});

const ISSUE_KIND_SET = new Set(Object.keys(COHERENCE_ISSUE_KINDS));

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function stageMap(timeline = []) {
  const map = new Map();
  for (const entry of Array.isArray(timeline) ? timeline : []) {
    if (!entry || typeof entry !== "object") continue;
    const stage = clean(entry.stage);
    if (!stage) continue;
    map.set(stage, entry);
  }
  return map;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Commitment ceiling for payment comparison.
 * Prefer registered current_amount (includes amendments), then original, then award.
 * Using max of available figures avoids flagging amendment-aware current amounts
 * against a lower City Record award line.
 */
export function resolveCommitmentAmount(stages) {
  const award = stages.get(STAGE_AWARD);
  const registered = stages.get(STAGE_REGISTERED);
  const amounts = [];
  if (award?.status === "matched") {
    const a = finiteNumber(award.detail?.amount);
    if (a != null && a > 0) amounts.push(a);
  }
  if (registered?.status === "matched") {
    const current = finiteNumber(registered.detail?.current_amount);
    const original = finiteNumber(registered.detail?.original_amount);
    if (current != null && current > 0) amounts.push(current);
    if (original != null && original > 0) amounts.push(original);
  }
  if (!amounts.length) return null;
  return Math.max(...amounts);
}

/**
 * Paid-to-date when payment stage is matched and carries a numeric total.
 * payment_state "unavailable" never yields a figure (honest gap, not a contradiction).
 */
export function resolvePaidAmount(paymentEntry) {
  if (!paymentEntry || paymentEntry.status !== "matched") return null;
  const state = clean(paymentEntry.detail?.payment_state);
  if (state === "unavailable") return null;
  return finiteNumber(paymentEntry.detail?.total_spent);
}

/** YYYY-MM-DD or ISO prefix → day ordinal, else null. */
export function stageDay(entry) {
  if (!entry || entry.status !== "matched") return null;
  const raw = clean(entry.date || entry.source_timestamp);
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return t / 86400000;
}

function finding(kind, stages, detail = {}) {
  if (!ISSUE_KIND_SET.has(kind)) {
    throw new TypeError(`unknown coherence issue kind: ${kind}`);
  }
  return {
    kind,
    stages: Array.isArray(stages) ? stages.slice() : [],
    summary: COHERENCE_ISSUE_KINDS[kind].summary,
    detail: detail && typeof detail === "object" ? detail : {},
  };
}

/**
 * Detect orphaned / contradictory stages on one assembled lifecycle.
 * @param {object} lifecycle assembleLifecycle output (or equivalent timeline shape)
 * @returns {Array<object>} findings (empty when coherent or insufficient)
 */
export function detectLifecycleCoherenceIssues(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return [];
  const timeline = Array.isArray(lifecycle.timeline) ? lifecycle.timeline : [];
  if (!timeline.length) return [];

  const stages = stageMap(timeline);
  const findings = [];

  // 1. Award with no solicitation stage (orphan — not a silent join miss rewrite).
  const award = stages.get(STAGE_AWARD);
  if (award?.status === "matched" && !stages.has(STAGE_SOLICITATION)) {
    findings.push(finding("orphaned_award", [STAGE_AWARD], {
      award_date: award.date || null,
      award_request_id: award.detail?.request_id || null,
    }));
  }

  // 2. Payment exceeds commitment (award and/or registered amount).
  const payment = stages.get(STAGE_PAYMENT);
  const paid = resolvePaidAmount(payment);
  const commitment = resolveCommitmentAmount(stages);
  if (paid != null && commitment != null && paid > commitment) {
    findings.push(finding("payment_exceeds_commitment", [STAGE_PAYMENT, STAGE_AWARD, STAGE_REGISTERED], {
      paid,
      commitment,
      excess: Math.round((paid - commitment) * 100) / 100,
      payment_state: payment?.detail?.payment_state || null,
    }));
  }

  // 3. Out-of-order dates across matched stages in STAGES succession.
  const dated = [];
  for (const stage of STAGES) {
    const entry = stages.get(stage);
    const day = stageDay(entry);
    if (day == null) continue;
    dated.push({ stage, day, date: entry.date || entry.source_timestamp || null });
  }
  for (let i = 1; i < dated.length; i += 1) {
    const prev = dated[i - 1];
    const cur = dated[i];
    if (prev.day > cur.day) {
      findings.push(finding("out_of_order_dates", [prev.stage, cur.stage], {
        earlier_stage: prev.stage,
        earlier_date: prev.date,
        later_stage: cur.stage,
        later_date: cur.date,
      }));
    }
  }

  return findings;
}

/**
 * Bounded coherence side-car for public lifecycle payloads.
 * @returns {{
 *   version: string,
 *   coherent: boolean,
 *   findings: Array<object>,
 *   issue_kinds: string[],
 *   issue_count: number
 * }}
 */
export function buildLifecycleCoherence(lifecycle) {
  const findings = detectLifecycleCoherenceIssues(lifecycle);
  const kinds = [...new Set(findings.map((f) => f.kind))];
  return {
    version: LIFECYCLE_COHERENCE_VERSION,
    coherent: findings.length === 0,
    findings,
    issue_kinds: kinds,
    issue_count: findings.length,
  };
}

/**
 * Stamp (or refresh) lifecycle.coherence from the current timeline.
 * Returns the same object for chaining.
 */
export function attachLifecycleCoherence(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return lifecycle;
  lifecycle.coherence = buildLifecycleCoherence(lifecycle);
  return lifecycle;
}

function extractLifecycle(row) {
  if (!row || typeof row !== "object") return null;
  if (Array.isArray(row.timeline)) return row;
  if (row.lifecycle && typeof row.lifecycle === "object") return row.lifecycle;
  return null;
}

/**
 * procurement_lifecycle_coherence_rate:
 *
 *   coherent_lifecycles / eligible_lifecycles
 *
 * Eligible: non-empty timeline with at least one matched stage that is not
 * solely not_applicable scaffolding. Coherent: zero findings among the closed
 * issue-kind set (orphaned award, payment over commitment, out-of-order dates).
 *
 * @param {Array<object>} cases lifecycle objects or { id, lifecycle }
 * @returns {{
 *   metric: string,
 *   version: string,
 *   eligible: number,
 *   coherent: number,
 *   rate: number,
 *   issue_counts: object,
 *   cases: Array<object>
 * }}
 */
export function measureProcurementLifecycleCoherenceRate(cases = []) {
  const rows = Array.isArray(cases) ? cases : [];
  const details = [];
  let eligible = 0;
  let coherent = 0;
  const issue_counts = {
    orphaned_award: 0,
    payment_exceeds_commitment: 0,
    out_of_order_dates: 0,
  };

  for (const row of rows) {
    const id = clean(row?.id) || clean(row?.notice_id) || clean(row?.request_id) || null;
    const lifecycle = extractLifecycle(row);
    if (!lifecycle) {
      details.push({ id, eligible: false, coherent: false, reason: "no_lifecycle" });
      continue;
    }
    const timeline = Array.isArray(lifecycle.timeline) ? lifecycle.timeline : [];
    if (!timeline.length) {
      details.push({ id, eligible: false, coherent: false, reason: "empty_timeline" });
      continue;
    }
    const hasMatched = timeline.some(
      (e) => e && e.status === "matched" && e.stage !== undefined,
    );
    if (!hasMatched) {
      details.push({ id, eligible: false, coherent: false, reason: "no_matched_stage" });
      continue;
    }

    eligible += 1;
    const findings = detectLifecycleCoherenceIssues(lifecycle);
    const ok = findings.length === 0;
    if (ok) coherent += 1;
    for (const f of findings) {
      if (Object.prototype.hasOwnProperty.call(issue_counts, f.kind)) {
        issue_counts[f.kind] += 1;
      }
    }
    details.push({
      id,
      eligible: true,
      coherent: ok,
      issue_count: findings.length,
      issue_kinds: [...new Set(findings.map((f) => f.kind))],
      findings,
    });
  }

  const rate = eligible === 0 ? 0 : coherent / eligible;
  return {
    metric: "procurement_lifecycle_coherence_rate",
    version: LIFECYCLE_COHERENCE_VERSION,
    eligible,
    coherent,
    rate,
    issue_counts,
    cases: details,
  };
}
