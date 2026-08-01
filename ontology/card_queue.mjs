// Idempotent card queue: rank, dedupe, and reconcile against a ledger of
// already-open / already-fixed cards so re-runs do not re-emit noise.
//
// Ledger statuses:
//   proposed | open | in_progress | fixed | closed | wontfix
//
// Rules:
// - same id already open/in_progress/proposed → skip re-emit (or refresh evidence only)
// - fixed/closed with verify still passing → never re-emit
// - fixed/closed with verify failing again → re-emit as regression
// - wontfix → never re-emit

import { rankCards, stableHash, MULTI_FLYWHEEL_POLICY_VERSION } from "./dimensions/shared.mjs";

export const QUEUE_SCHEMA = "cityscroll.multi_flywheel_queue.v0";
export const LEDGER_SCHEMA = "cityscroll.multi_flywheel_ledger.v0";

/**
 * @param {Array<object>} cards — raw dimension cards
 * @param {object} [ledger] — { cards: { [id]: { status, verify?, last_seen_at?, content_hash? } } }
 * @param {object} [opts]
 * @param {Record<string, boolean>} [opts.verify_results] — id → pass (optional live verify)
 * @param {boolean} [opts.refresh_open=false] — when true, open cards reappear with refreshed evidence
 * @param {number} [opts.limit=50]
 */
export function reconcileQueue(cards = [], ledger = {}, opts = {}) {
  const entries = ledger?.cards && typeof ledger.cards === "object" ? ledger.cards : {};
  const verifyResults = opts.verify_results || {};
  const refreshOpen = opts.refresh_open === true;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;

  const emitted = [];
  const skipped = [];
  const regressions = [];

  for (const card of cards) {
    if (!card?.id) continue;
    const prior = entries[card.id];
    const verifyPass = Object.prototype.hasOwnProperty.call(verifyResults, card.id)
      ? Boolean(verifyResults[card.id])
      : null;

    if (!prior) {
      emitted.push({ ...card, reconcile: "new" });
      continue;
    }

    const status = String(prior.status || "").toLowerCase();

    if (status === "wontfix") {
      skipped.push({ id: card.id, reason: "wontfix" });
      continue;
    }

    if (status === "fixed" || status === "closed") {
      if (verifyPass === true) {
        skipped.push({ id: card.id, reason: "already_fixed_verify_pass" });
        continue;
      }
      if (verifyPass === false) {
        const regression = {
          ...card,
          status: "proposed",
          reconcile: "regression",
          prior_status: status,
        };
        emitted.push(regression);
        regressions.push(card.id);
        continue;
      }
      // No verify signal: treat fixed as still fixed (idempotent quiet)
      skipped.push({ id: card.id, reason: "already_fixed_no_verify_signal" });
      continue;
    }

    if (status === "proposed" || status === "open" || status === "in_progress") {
      if (refreshOpen) {
        emitted.push({
          ...card,
          status,
          reconcile: "refresh_open",
          prior_status: status,
        });
      } else {
        skipped.push({ id: card.id, reason: `already_${status}` });
      }
      continue;
    }

    // Unknown prior status → emit cautiously
    emitted.push({ ...card, reconcile: "unknown_prior", prior_status: status });
  }

  // Dedupe by id within this batch (first wins by rank_score)
  const byId = new Map();
  for (const card of emitted) {
    const prev = byId.get(card.id);
    if (!prev || (card.rank_score || 0) > (prev.rank_score || 0)) {
      byId.set(card.id, card);
    }
  }
  const deduped = rankCards([...byId.values()], { limit });

  return {
    cards: deduped,
    skipped,
    regressions,
    stats: {
      input: cards.length,
      emitted: deduped.length,
      skipped: skipped.length,
      regressions: regressions.length,
      unique_input_ids: new Set(cards.map((c) => c.id).filter(Boolean)).size,
    },
  };
}

/**
 * Merge emitted cards into a ledger snapshot (does not mark fixed).
 */
export function updateLedger(ledger = {}, emittedCards = [], { seen_at } = {}) {
  const at = seen_at || new Date(0).toISOString();
  const cards = { ...(ledger.cards || {}) };
  for (const card of emittedCards) {
    const prior = cards[card.id] || {};
    const status = card.reconcile === "regression"
      ? "proposed"
      : (prior.status && prior.status !== "fixed" && prior.status !== "closed"
        ? prior.status
        : "proposed");
    cards[card.id] = {
      status,
      dimension: card.dimension,
      title: card.title,
      verify: card.verify,
      content_hash: card.content_hash,
      last_seen_at: at,
      demo_win: card.demo_win || prior.demo_win || null,
    };
  }
  return {
    schema: LEDGER_SCHEMA,
    policy_version: MULTI_FLYWHEEL_POLICY_VERSION,
    updated_at: at,
    cards,
  };
}

/**
 * Mark cards fixed when verify predicates pass (caller supplies results).
 */
export function applyVerifyToLedger(ledger = {}, verifyResults = {}, { seen_at } = {}) {
  const at = seen_at || new Date(0).toISOString();
  const cards = { ...(ledger.cards || {}) };
  const closed = [];
  for (const [id, pass] of Object.entries(verifyResults)) {
    if (!cards[id]) continue;
    if (pass) {
      cards[id] = { ...cards[id], status: "fixed", last_verified_at: at, verify_pass: true };
      closed.push(id);
    } else {
      cards[id] = { ...cards[id], last_verified_at: at, verify_pass: false };
    }
  }
  return {
    ledger: {
      schema: LEDGER_SCHEMA,
      policy_version: MULTI_FLYWHEEL_POLICY_VERSION,
      updated_at: at,
      cards,
    },
    closed,
  };
}

/**
 * Build the machine-readable queue document.
 */
export function buildQueueDocument({
  cards,
  dimension_metrics = {},
  skipped = [],
  regressions = [],
  generated_at,
  mode = "fixture",
  ledger_path = null,
} = {}) {
  const at = generated_at || new Date(0).toISOString();
  const byDimension = {};
  for (const card of cards) {
    const d = card.dimension || "unknown";
    byDimension[d] = (byDimension[d] || 0) + 1;
  }
  return {
    schema: QUEUE_SCHEMA,
    policy_version: MULTI_FLYWHEEL_POLICY_VERSION,
    generated_at: at,
    mode,
    ledger_path,
    stats: {
      card_count: cards.length,
      by_dimension: byDimension,
      skipped: skipped.length,
      regressions: regressions.length,
    },
    dimension_metrics,
    skipped,
    regressions,
    cards,
    content_hash: stableHash({
      schema: QUEUE_SCHEMA,
      cards: cards.map((c) => ({ id: c.id, hash: c.content_hash, rank: c.rank })),
      metrics: dimension_metrics,
    }),
  };
}

export function emptyLedger({ updated_at } = {}) {
  return {
    schema: LEDGER_SCHEMA,
    policy_version: MULTI_FLYWHEEL_POLICY_VERSION,
    updated_at: updated_at || "1970-01-01T00:00:00.000Z",
    cards: {},
  };
}
