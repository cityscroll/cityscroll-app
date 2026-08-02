/**
 * Procurement lifecycle coherence — detect orphaned / contradictory stages
 * and measure procurement_lifecycle_coherence_rate.
 *
 * Findings (closed set):
 *   - orphaned_award: matched award with no solicitation stage on the timeline
 *     (class-(a) honesty: names sources checked; never a silent gap)
 *   - payment_exceeds_commitment: paid-to-date exceeds award/registered commitment
 *   - out_of_order_dates: matched stage dates violate solicitation→…→payment order
 *     on a comparable event-time basis (not CR publication vs Checkbook registration)
 *
 * Pure module (no fetch, no env). assembleLifecycle stamps a bounded
 * `coherence` side-car; the rate is measured offline over field cases.
 *
 * Stage names are local string constants matching checkbook_lifecycle STAGES
 * (no import — avoids a circular dependency with assembleLifecycle).
 *
 * Named metrics:
 *   - procurement_lifecycle_coherence_rate
 *   - award_solicitation_recovery_rate
 */

export const LIFECYCLE_COHERENCE_VERSION = "lifecycle_coherence_v2";

/** Same succession order as checkbook_lifecycle.STAGES. */
export const STAGE_SOLICITATION = "solicitation";
export const STAGE_INTENT_TO_NEGOTIATE = "intent_to_negotiate";
export const STAGE_VENDOR_LIST = "vendor_list";
export const STAGE_INTENT_TO_AWARD = "intent_to_award";
export const STAGE_AWARD = "award";
export const STAGE_PENDING = "pending";
export const STAGE_REGISTERED = "registered";
export const STAGE_PAYMENT = "payment";
export const STAGES = Object.freeze([
  STAGE_SOLICITATION,
  STAGE_INTENT_TO_NEGOTIATE,
  STAGE_VENDOR_LIST,
  STAGE_INTENT_TO_AWARD,
  STAGE_AWARD,
  STAGE_PENDING,
  STAGE_REGISTERED,
  STAGE_PAYMENT,
]);

/**
 * Date-basis clocks for stage.date values.
 * Cross-basis pairs that commonly invert are NOT real lifecycle disorder:
 * City Record publication often lands after Checkbook registration.
 */
export const DATE_BASIS_PUBLICATION = "publication";
export const DATE_BASIS_REGISTRATION = "registration";
export const DATE_BASIS_RECEIVED = "received";
export const DATE_BASIS_PAYMENT = "payment";
export const DATE_BASIS_EVENT = "event";

/** Closed issue-kind registry for counters and tests. */
export const COHERENCE_ISSUE_KINDS = Object.freeze({
  orphaned_award: {
    id: "orphaned_award",
    summary:
      "Matched award has no solicitation stage — solicitation not recovered from City Record, PASSPort RFx, or OCP Current Solicitations",
  },
  payment_exceeds_commitment: {
    id: "payment_exceeds_commitment",
    summary: "Paid-to-date exceeds the award or registered commitment amount",
  },
  out_of_order_dates: {
    id: "out_of_order_dates",
    summary: "Matched stage dates are out of chronological order on a comparable event-time basis",
  },
});

/** Honest sources that can fill the solicitation stage (class-(a) named). */
export const SOLICITATION_RECOVERY_SOURCES = Object.freeze([
  "city-record",
  "ocp-current-solicitations",
  "passport-public-rfx",
]);

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

/**
 * Infer date_basis when the stage entry was not stamped (older cache / bare fixtures).
 * City Record intermediate + award stages use publication clock; Checkbook stages
 * use registration / received / payment clocks; solicitation from RFx/OCP is event.
 */
export function inferDateBasis(entry) {
  if (!entry || typeof entry !== "object") return null;
  const stamped = clean(entry.date_basis);
  if (stamped) return stamped;
  const stage = clean(entry.stage);
  const source = clean(entry.source);
  if (stage === STAGE_REGISTERED) return DATE_BASIS_REGISTRATION;
  if (stage === STAGE_PENDING) return DATE_BASIS_RECEIVED;
  if (stage === STAGE_PAYMENT) return DATE_BASIS_PAYMENT;
  if (stage === STAGE_SOLICITATION) {
    if (source === "passport-public-rfx" || source === "ocp-current-solicitations") {
      return DATE_BASIS_EVENT;
    }
    return DATE_BASIS_PUBLICATION;
  }
  // City Record intermediates + award: publication clock on CR rows.
  if (
    stage === STAGE_AWARD
    || stage === STAGE_INTENT_TO_AWARD
    || stage === STAGE_VENDOR_LIST
    || stage === STAGE_INTENT_TO_NEGOTIATE
  ) {
    if (source === "city-record" || !source) return DATE_BASIS_PUBLICATION;
  }
  return null;
}

/**
 * Publication clock vs Checkbook registration/received is a date-basis artifact,
 * not real stage disorder (registration often legitimately precedes CR award notice).
 */
export function datesComparableForOrder(prevEntry, curEntry) {
  const a = inferDateBasis(prevEntry);
  const b = inferDateBasis(curEntry);
  if (!a || !b) return true;
  const pub = DATE_BASIS_PUBLICATION;
  const checkbookFamily = new Set([
    DATE_BASIS_REGISTRATION,
    DATE_BASIS_RECEIVED,
    DATE_BASIS_PAYMENT,
  ]);
  if (a === pub && checkbookFamily.has(b)) return false;
  if (b === pub && checkbookFamily.has(a)) return false;
  return true;
}

/** YYYY-MM-DD or ISO prefix → day ordinal, else null. */
export function stageDay(entry) {
  if (!entry || entry.status !== "matched") return null;
  // Prefer event_date when stamped (event-time basis); else publication/source date.
  const raw = clean(entry.event_date || entry.date || entry.source_timestamp);
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
 * Build the honest solicitation-recovery side-car from a timeline + opts.
 * status matched when solicitation stage is matched from any honest source.
 */
export function buildSolicitationRecovery(lifecycle) {
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const sol = timeline.find((e) => e && e.stage === STAGE_SOLICITATION && e.status === "matched");
  const stamped = lifecycle?.solicitation_recovery && typeof lifecycle.solicitation_recovery === "object"
    ? lifecycle.solicitation_recovery
    : null;
  const sourcesChecked = Array.isArray(stamped?.sources_checked) && stamped.sources_checked.length
    ? stamped.sources_checked.slice()
    : SOLICITATION_RECOVERY_SOURCES.slice();

  if (sol) {
    const source = clean(sol.source) || stamped?.source || null;
    return {
      status: "matched",
      source,
      sources_checked: sourcesChecked,
      class: null,
      gap_kind: null,
    };
  }
  return {
    status: "unmatched",
    source: null,
    sources_checked: sourcesChecked,
    // Class-(a): public sources exist; join did not fill the stage.
    class: "not_yet_ingested",
    gap_kind: "solicitation_not_in_city_record",
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

  // 1. Award with no solicitation stage — honest class-(a) named-source gap, never silent.
  const award = stages.get(STAGE_AWARD);
  if (award?.status === "matched" && !stages.has(STAGE_SOLICITATION)) {
    const recovery = buildSolicitationRecovery(lifecycle);
    findings.push(finding("orphaned_award", [STAGE_AWARD], {
      class: recovery.class || "not_yet_ingested",
      gap_kind: recovery.gap_kind || "solicitation_not_in_city_record",
      sources_named: recovery.sources_checked,
      award_date: award.date || null,
      award_request_id: award.detail?.request_id || null,
      note:
        "Solicitation not recovered from City Record, PASSPort RFx, or OCP Current Solicitations — do not invent a notice",
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
  // Skip pairs whose clocks are not comparable (CR publication vs Checkbook registration).
  const dated = [];
  for (const stage of STAGES) {
    const entry = stages.get(stage);
    const day = stageDay(entry);
    if (day == null) continue;
    dated.push({
      stage,
      day,
      date: entry.event_date || entry.date || entry.source_timestamp || null,
      date_basis: inferDateBasis(entry),
      entry,
    });
  }
  for (let i = 1; i < dated.length; i += 1) {
    const prev = dated[i - 1];
    const cur = dated[i];
    if (prev.day <= cur.day) continue;
    if (!datesComparableForOrder(prev.entry, cur.entry)) continue;
    findings.push(finding("out_of_order_dates", [prev.stage, cur.stage], {
      earlier_stage: prev.stage,
      earlier_date: prev.date,
      earlier_date_basis: prev.date_basis,
      later_stage: cur.stage,
      later_date: cur.date,
      later_date_basis: cur.date_basis,
    }));
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
 * Also refreshes solicitation_recovery when a solicitation stage is present or absent.
 * Returns the same object for chaining.
 */
export function attachLifecycleCoherence(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return lifecycle;
  lifecycle.solicitation_recovery = buildSolicitationRecovery(lifecycle);
  lifecycle.coherence = buildLifecycleCoherence(lifecycle);
  return lifecycle;
}

function extractLifecycle(row) {
  if (!row || typeof row !== "object") return null;
  if (Array.isArray(row.timeline)) return row;
  if (row.lifecycle && typeof row.lifecycle === "object") return row.lifecycle;
  return null;
}

function isPinBearingAward(row, lifecycle) {
  const pin = clean(row?.pin) || clean(lifecycle?.pin);
  if (!pin) return false;
  const type = clean(row?.type_of_notice_description || row?.type_of_notice || row?.notice_type);
  if (/^award$/i.test(type)) return true;
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  return timeline.some((e) => e && e.stage === STAGE_AWARD && e.status === "matched");
}

function hasMatchedSolicitation(lifecycle) {
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  return timeline.some((e) => e && e.stage === STAGE_SOLICITATION && e.status === "matched");
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

/**
 * award_solicitation_recovery_rate:
 *
 *   PIN-bearing awards with a matched solicitation stage from ANY honest source
 *   / PIN-bearing awards
 *
 * Honest sources: City Record sibling, OCP Current Solicitations, PASSPort RFx.
 * Empty when RFx and OCP also miss stays unmatched (class-a) — never invented.
 *
 * @param {Array<object>} cases { id, pin?, type_of_notice_description?, lifecycle }
 */
export function measureAwardSolicitationRecoveryRate(cases = []) {
  const rows = Array.isArray(cases) ? cases : [];
  const details = [];
  let eligible = 0;
  let recovered = 0;
  const by_source = {
    "city-record": 0,
    "ocp-current-solicitations": 0,
    "passport-public-rfx": 0,
    other: 0,
  };

  for (const row of rows) {
    const id = clean(row?.id) || clean(row?.notice_id) || clean(row?.request_id) || null;
    const lifecycle = extractLifecycle(row);
    if (!lifecycle || !isPinBearingAward(row, lifecycle)) {
      details.push({ id, eligible: false, recovered: false, reason: "not_pin_bearing_award" });
      continue;
    }
    eligible += 1;
    const ok = hasMatchedSolicitation(lifecycle);
    const recovery = buildSolicitationRecovery(lifecycle);
    if (ok) {
      recovered += 1;
      const src = recovery.source || "other";
      if (Object.prototype.hasOwnProperty.call(by_source, src)) by_source[src] += 1;
      else by_source.other += 1;
    }
    details.push({
      id,
      eligible: true,
      recovered: ok,
      source: ok ? recovery.source : null,
      sources_checked: recovery.sources_checked,
    });
  }

  const rate = eligible === 0 ? 0 : recovered / eligible;
  return {
    metric: "award_solicitation_recovery_rate",
    version: LIFECYCLE_COHERENCE_VERSION,
    eligible,
    recovered,
    rate,
    by_source,
    cases: details,
  };
}
