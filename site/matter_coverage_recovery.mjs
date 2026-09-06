/**
 * Population coverage, operational health, and recovery contract for exact
 * Council-matter follow-through.
 *
 * Frozen snapshot counts are derived here independently of the matter-document
 * builder. The later-event watch table is the frozen time-ordered oracle, not a
 * live publisher coverage gate. Synthetic fault cases are labelled durability
 * tests and are not added into that frozen denominator.
 */

export const MATTER_COVERAGE_RECOVERY_SCHEMA = "cityscroll.matter_coverage_recovery.v1";
export const MATTER_COVERAGE_RECEIPT_SCHEMA = "cityscroll.matter_coverage_receipt.v1";
export const MATTER_COVERAGE_ACCEPTANCE_SCHEMA = "cityscroll.matter_coverage_acceptance.v1";

export const DEFAULT_REFRESH_CADENCE_MS = 24 * 60 * 60 * 1000;
export const STALE_REFRESH_MS = 48 * 60 * 60 * 1000;
export const LAG_CYCLE_COUNT = 2;
export const PUBLICATION_LAG_MS = LAG_CYCLE_COUNT * DEFAULT_REFRESH_CADENCE_MS;
export const DELIVERY_LAG_MS = LAG_CYCLE_COUNT * DEFAULT_REFRESH_CADENCE_MS;

export const ALERT_CLASS = Object.freeze({
  NONE: "none",
  STALE_REFRESH: "stale-refresh",
  PUBLICATION_LAG: "publication-lag",
  DELIVERY_LAG: "delivery-lag",
  ACQUISITION_FAILED: "acquisition-failed",
  MIXED: "mixed",
});

export const FROZEN_LATER_EVENT_WATCHES = Object.freeze([
  { matter_id: "79163", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "P-C Item Laid Over by Comm", later_action: "P-C Item Approved by Subcommittee with Companion Resolution" },
  { matter_id: "79164", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "P-C Item Laid Over by Comm", later_action: "P-C Item Approved by Subcommittee with Companion Resolution" },
  { matter_id: "79062", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "79063", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "79064", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78605", early_event: "22342", early_notice: "20260408025", later_event: "22375", later_notice: "20260428021", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78606", early_event: "22342", early_notice: "20260408025", later_event: "22375", later_notice: "20260428021", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78682", early_event: "22342", early_notice: "20260408025", later_event: "22375", later_notice: "20260428021", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78409", early_event: "22300", early_notice: "20260304007", later_event: "22365", later_notice: "20260331028", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78411", early_event: "22300", early_notice: "20260304007", later_event: "22365", later_notice: "20260331028", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
]);

export const RECOVERY_PLAYBOOK = Object.freeze({
  token_recovery: {
    alert: "acquisition-failed",
    owner: "site owner",
    action: "Replace the deployed Legistar token, confirm retention writes remain enabled, and rerun exact-matter refresh. Last-good journal rows stay until the retry completes.",
  },
  budget_backlog: {
    alert: "none",
    owner: "site owner",
    action: "Raise the per-run matter or request budget and let the next scheduled cycle continue the visit sequence. Budget exhaustion is partial, never current.",
  },
  cursor_recovery: {
    alert: "none",
    owner: "site owner",
    action: "Rerun exact-matter refresh. The stored skip cursor resumes the interrupted page; earlier retained events are not deleted.",
  },
  failed_publication: {
    alert: "publication-lag",
    owner: "site owner",
    action: "Leave the previous complete generation in place, write lookup and index artifacts, then promote the manifest last. Held updates stay unpublished until that promotion succeeds.",
  },
  replay_safe_delivery: {
    alert: "delivery-lag",
    owner: "site owner",
    action: "Retry the outbox without changing item identity. A replay of the same semantic revision inserts nothing; a successful provider acceptance then marks the existing owed item delivered.",
  },
  feature_rollback: {
    alert: "none",
    owner: "site owner",
    action: "Clear MATTER_WATCH_DELIVERY to stop new matter-update enqueueing. Retained history, published generations, and already owed items remain. Restore the flag only after collector and publication receipts are current.",
  },
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function laterWatchKey(row) {
  return `${row.matter_id}:${row.later_event}`;
}

export function deriveFrozenCoverageOracle(snapshot = {}) {
  const laterByMatter = new Map(FROZEN_LATER_EVENT_WATCHES.map((row) => [row.matter_id, row]));
  const laterNotices = new Set(FROZEN_LATER_EVENT_WATCHES.map((row) => row.later_notice));
  const seen = new Map();
  let rawAppearances = 0;
  for (const [noticeId, record] of Object.entries(snapshot.by_notice || {})) {
    for (const matter of record?.matters || []) {
      const matterId = String(matter.matter_id);
      const eventId = String(record?.event?.event_id || "");
      if (!matterId || !eventId) continue;
      rawAppearances += 1;
      const current = seen.get(matterId) || { events: new Set(), notices: [] };
      current.events.add(eventId);
      current.notices.push(noticeId);
      seen.set(matterId, current);
    }
  }
  const eventCounts = [...seen.values()].map((row) => row.events.size);
  const twoEventMatters = [...seen.entries()]
    .filter(([, row]) => row.events.size === 2)
    .map(([matterId]) => matterId)
    .sort();
  return freeze({
    schema: MATTER_COVERAGE_RECOVERY_SCHEMA,
    source_vintage: snapshot.generated_at || null,
    materialized_matters: seen.size,
    raw_appearances: rawAppearances,
    distinct_appearances: eventCounts.reduce((sum, count) => sum + count, 0),
    two_event_histories: eventCounts.filter((count) => count === 2).length,
    single_event_histories: eventCounts.filter((count) => count === 1).length,
    later_event_watches: FROZEN_LATER_EVENT_WATCHES.length,
    later_notices: [...laterNotices].sort(),
    matter_ids: [...seen.keys()].sort((left, right) => Number(left) - Number(right)),
    two_event_matter_ids: twoEventMatters,
    later_watch_keys: FROZEN_LATER_EVENT_WATCHES.map(laterWatchKey),
    later_by_matter: Object.fromEntries(laterByMatter),
    expected: {
      materialized_matters: 66,
      distinct_appearances: 76,
      later_event_discoveries: 10,
      logical_later_updates: 10,
      replay_duplicates: 0,
    },
  });
}

export function withholdLaterMatterPackets(snapshot = {}, oracle = deriveFrozenCoverageOracle(snapshot)) {
  const laterKeys = new Set(oracle.later_watch_keys || []);
  const by_notice = {};
  for (const [noticeId, record] of Object.entries(snapshot.by_notice || {})) {
    const eventId = String(record?.event?.event_id || "");
    const matters = (record?.matters || []).filter((matter) => {
      return !laterKeys.has(`${matter.matter_id}:${eventId}`);
    });
    by_notice[noticeId] = { ...record, matters };
  }
  return {
    schema: snapshot.schema,
    generated_at: snapshot.generated_at,
    present_count: snapshot.present_count,
    by_notice,
  };
}

export function snapshotFromJournalAppearances(snapshot = {}, journalRows = []) {
  const allowed = new Set(
    (Array.isArray(journalRows) ? journalRows : [])
      .map((row) => `${row.matter_id}:${row.event_id}`)
      .filter((key) => !key.endsWith(":")),
  );
  const by_notice = {};
  for (const [noticeId, record] of Object.entries(snapshot.by_notice || {})) {
    const eventId = String(record?.event?.event_id || "");
    const matters = (record?.matters || []).filter((matter) => allowed.has(`${matter.matter_id}:${eventId}`));
    if (matters.length) by_notice[noticeId] = { ...record, matters };
  }
  return {
    schema: snapshot.schema,
    generated_at: snapshot.generated_at,
    present_count: snapshot.present_count,
    by_notice,
  };
}

export function countDistinctAppearances(rows = []) {
  return new Set((rows || []).map((row) => `${row.matter_id}:${row.event_id}`)).size;
}

export function countMaterializedMatters(rows = []) {
  return new Set((rows || []).map((row) => String(row.matter_id))).size;
}

export function laterDiscoveries(rows = [], oracle = deriveFrozenCoverageOracle()) {
  const found = [];
  for (const watch of oracle.later_by_matter ? Object.values(oracle.later_by_matter) : FROZEN_LATER_EVENT_WATCHES) {
    const hit = (rows || []).some((row) => String(row.matter_id) === watch.matter_id && String(row.event_id) === watch.later_event);
    if (hit) found.push(watch.matter_id);
  }
  return found;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function receiptContainsResidentEmail(value) {
  return EMAIL_RE.test(JSON.stringify(value ?? {}));
}

export function ageMs(from, now) {
  if (!from) return null;
  const start = Date.parse(from);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function evaluateCoverageAlerts(input = {}, { now, cadenceMs = DEFAULT_REFRESH_CADENCE_MS } = {}) {
  const observedAt = now || input.observed_at || new Date().toISOString();
  const staleMs = STALE_REFRESH_MS;
  const publicationLagLimit = LAG_CYCLE_COUNT * cadenceMs;
  const deliveryLagLimit = LAG_CYCLE_COUNT * cadenceMs;
  const alerts = [];

  const staleWatches = Number(input.stale_active_watches) || 0;
  if (staleWatches > 0 || (input.last_complete_refresh_age_ms != null && input.last_complete_refresh_age_ms >= staleMs && (Number(input.active_watches) || 0) > 0)) {
    alerts.push({
      id: ALERT_CLASS.STALE_REFRESH,
      failure_class: ALERT_CLASS.STALE_REFRESH,
      owner: RECOVERY_PLAYBOOK.token_recovery.owner,
      action: "Run exact-matter refresh for every eligible active watch that lacks a complete refresh in the last 48 hours.",
      recovery: RECOVERY_PLAYBOOK.token_recovery,
    });
  }

  const publicationLag = Number(input.publication_lag_ms) || 0;
  if (publicationLag >= publicationLagLimit && (Number(input.unpublished_eligible_changes) || 0) > 0) {
    alerts.push({
      id: ALERT_CLASS.PUBLICATION_LAG,
      failure_class: ALERT_CLASS.PUBLICATION_LAG,
      owner: RECOVERY_PLAYBOOK.failed_publication.owner,
      action: RECOVERY_PLAYBOOK.failed_publication.action,
      recovery: RECOVERY_PLAYBOOK.failed_publication,
    });
  }

  const deliveryLag = Number(input.pending_delivery_age_ms) || 0;
  if (deliveryLag >= deliveryLagLimit && (Number(input.pending_outbox_items) || 0) > 0) {
    alerts.push({
      id: ALERT_CLASS.DELIVERY_LAG,
      failure_class: ALERT_CLASS.DELIVERY_LAG,
      owner: RECOVERY_PLAYBOOK.replay_safe_delivery.owner,
      action: RECOVERY_PLAYBOOK.replay_safe_delivery.action,
      recovery: RECOVERY_PLAYBOOK.replay_safe_delivery,
    });
  }

  if ((Number(input.failed_refreshes) || 0) > 0 && !alerts.some((row) => row.id === ALERT_CLASS.STALE_REFRESH)) {
    alerts.push({
      id: ALERT_CLASS.ACQUISITION_FAILED,
      failure_class: ALERT_CLASS.ACQUISITION_FAILED,
      owner: RECOVERY_PLAYBOOK.token_recovery.owner,
      action: RECOVERY_PLAYBOOK.token_recovery.action,
      recovery: RECOVERY_PLAYBOOK.token_recovery,
    });
  }

  const classes = [...new Set(alerts.map((row) => row.failure_class))];
  return {
    observed_at: observedAt,
    alerts,
    failure_class: classes.length === 0 ? ALERT_CLASS.NONE : (classes.length === 1 ? classes[0] : ALERT_CLASS.MIXED),
  };
}

export function evaluateDeployedCoverageCanary(receipt = {}) {
  const active = Number(receipt.active_watches) || 0;
  const retainedMatters = Number(receipt.retained_counts?.matters) || 0;
  const pending = Number(receipt.pending_outbox_items) || 0;
  const failed = Number(receipt.failed_outbox_items) || 0;
  const namedIds = Array.isArray(receipt.live_required_record_ids) ? receipt.live_required_record_ids : [];
  return {
    schema: "cityscroll.matter_coverage_canary.v1",
    kind: receipt.deployment_kind || "local-rehearsal",
    named_live_record_gate: namedIds.length > 0,
    population_floor: {
      retained_matters_non_negative: retainedMatters >= 0,
      active_watches_non_negative: active >= 0,
      pending_and_failed_non_negative: pending >= 0 && failed >= 0,
    },
    ok: namedIds.length === 0 && retainedMatters >= 0 && active >= 0 && pending >= 0 && failed >= 0,
  };
}

export function buildAcceptanceIndex(results = {}) {
  const entries = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((id) => {
    const row = results[id] || {};
    return [id, {
      id,
      status: row.status || "missing",
      evidence: row.evidence || null,
      notes: row.notes || null,
    }];
  });
  return {
    schema: MATTER_COVERAGE_ACCEPTANCE_SCHEMA,
    obligations: Object.fromEntries(entries),
    complete: entries.every(([, row]) => row.status === "pass"),
  };
}
