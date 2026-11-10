// One closed verdict per watch per run.
// A verdict is { class, reason }. Anything the table cannot classify is FAILED/unclassified, never "other".
//
// Idle means the watch ran and had nothing to send. The operator dashboard already uses "quiet"
// only when the search returned nothing; already-seen (query still hits, nothing new) stays a
// distinct idle reason. deskCauseOf() maps each verdict onto that dashboard cause vocabulary.
export const VERDICT = Object.freeze({ OFF: 'off', BLOCKED: 'blocked', HELD: 'held', IDLE: 'idle', DELIVERED: 'delivered', FAILED: 'failed' });

// Today's free-text `skipped:` strings -> verdict. `lens:*` is a prefix family.
export const SKIP_TABLE = Object.freeze({
  'paused': [VERDICT.OFF, 'paused'],
  'all-paused': [VERDICT.OFF, 'paused'],
  'developer-test': [VERDICT.OFF, 'test-account'],
  'gone': [VERDICT.OFF, 'ended'],
  'deleted': [VERDICT.OFF, 'ended'],
  'unsupported-scope': [VERDICT.BLOCKED, 'unsupported-scope'],
  'feature-gated': [VERDICT.BLOCKED, 'not-live-yet'],
  'malformed-award-watch': [VERDICT.BLOCKED, 'malformed-watch'],
  'recipient-suppressed': [VERDICT.BLOCKED, 'recipient-unreachable'],
  'shadow-hold': [VERDICT.HELD, 'safety-hold'],
  'text-query-unavailable': [VERDICT.HELD, 'source-unavailable'],
  'text-query-incomplete': [VERDICT.HELD, 'source-incomplete'],
  'land-geography-artifact-unavailable': [VERDICT.HELD, 'source-unavailable'],
  'award-lookup-failed': [VERDICT.HELD, 'source-unavailable'],
  'weekly': [VERDICT.IDLE, 'not-due'],
  'empty': [VERDICT.IDLE, 'empty-section'],
  'bad-job': [VERDICT.FAILED, 'bad-job'],
});
const SEND_ACTIONS = new Set(['match', 'weekly-empty', 'heartbeat', 'catch_up']);

export function classifySkip(reason) {
  const key = String(reason || '');
  if (key.startsWith('lens:')) return { class: VERDICT.BLOCKED, reason: 'unsupported-lens' };
  const hit = Object.hasOwn(SKIP_TABLE, key) ? SKIP_TABLE[key] : null;
  return hit ? { class: hit[0], reason: hit[1] } : { class: VERDICT.FAILED, reason: 'unclassified-skip' };
}

/** Why a run that matched nothing new had nothing to send: the query still hits, hit nothing, or did not say. */
function idleReason(bag) {
  const found = Number.isFinite(bag.found) ? Number(bag.found) : null;
  if (found !== null && found > 0) return 'already-seen';
  if (found === 0 || bag.zeroMatch === true) return 'no-matches';
  return 'nothing-new';
}

/** Total function over today's result bag. Returns null only for the queue fan-out placeholder. */
export function verdictOf(bag) {
  if (!bag || typeof bag !== 'object') return { class: VERDICT.FAILED, reason: 'unclassified' };
  if (bag.mode === 'queue') return null;
  if (bag.error) return { class: VERDICT.FAILED, reason: 'error' };
  if (bag.skipped) return classifySkip(bag.skipped);
  // Cap and rehearsal are checked before sent, as the dashboard does. The runner sets at most one of the three.
  if (bag.capped) return { class: VERDICT.HELD, reason: 'send-cap' };
  if (bag.dryRun) return { class: VERDICT.HELD, reason: 'rehearsal' };
  if (bag.sent) return { class: VERDICT.DELIVERED, reason: SEND_ACTIONS.has(bag.action) ? bag.action : 'match' };
  if (bag.action === 'none') return { class: VERDICT.IDLE, reason: idleReason(bag) };
  if (SEND_ACTIONS.has(bag.action)) return { class: VERDICT.FAILED, reason: 'send-wanted-no-outcome' };
  return { class: VERDICT.FAILED, reason: 'unclassified' };
}

/** What a subscriber reads. Operator diagnostics stay in the operator plane. */
export function subscriberLine(verdict) {
  if (!verdict) return null;
  switch (verdict.class) {
    case VERDICT.DELIVERED: return 'Delivered';
    case VERDICT.IDLE: return verdict.reason === 'not-due' ? 'Not due yet' : 'Nothing new';
    case VERDICT.HELD: return 'Waiting';
    case VERDICT.BLOCKED: return verdict.reason === 'recipient-unreachable' ? "Can't reach this address" : "Can't run yet";
    case VERDICT.OFF: return verdict.reason === 'paused' ? 'Paused' : null;
    default: return 'Something went wrong';
  }
}

export function tally(verdicts) {
  const out = { off: 0, blocked: 0, held: 0, idle: 0, delivered: 0, failed: 0 };
  for (const v of verdicts) if (v) out[v.class] += 1;
  return out;
}

/**
 * The operator dashboard's cause for the same outcome, derived from the verdict alone. This is the
 * contract that lets the dashboard read a stored verdict instead of re-deriving it from strings.
 */
export function deskCauseOf(stored) {
  const verdict = normalizeVerdict(stored);
  if (!verdict) return null;
  const key = `${verdict.class}/${verdict.reason}`;
  if (key === 'failed/error') return 'error';
  if (key === 'off/ended') return 'unsub';
  if (key === 'held/send-cap') return 'capped';
  if (key === 'held/rehearsal') return 'dry_run';
  if (verdict.class === VERDICT.DELIVERED) return 'sent';
  if (key === 'idle/already-seen') return 'already_seen';
  if (key === 'idle/no-matches' || key === 'idle/nothing-new') return 'quiet';
  if (key === 'failed/send-wanted-no-outcome' || key === 'failed/unclassified') return 'other';
  return 'skipped'; // every remaining verdict comes from a skip the runner named
}

/**
 * Earlier day-log entries and receipts may carry the idle class under its old name. Stored history
 * is read through these two functions and never rewritten.
 */
export function normalizeVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  return verdict.class === 'quiet' ? { ...verdict, class: VERDICT.IDLE } : verdict;
}

export function normalizeTally(counts = {}) {
  const { quiet = 0, ...rest } = counts;
  return { off: 0, blocked: 0, held: 0, delivered: 0, failed: 0, ...rest, idle: (rest.idle || 0) + quiet };
}
