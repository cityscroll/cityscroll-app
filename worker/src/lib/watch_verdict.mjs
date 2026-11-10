// One closed verdict per watch per run.
// A verdict is { class, reason }. Anything the table cannot classify is FAILED/unclassified, never "other".
export const VERDICT = Object.freeze({ OFF: 'off', BLOCKED: 'blocked', HELD: 'held', QUIET: 'quiet', DELIVERED: 'delivered', FAILED: 'failed' });

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
  'weekly': [VERDICT.QUIET, 'not-due'],
  'empty': [VERDICT.QUIET, 'nothing-new'],
  'bad-job': [VERDICT.FAILED, 'bad-job'],
});
const SEND_ACTIONS = new Set(['match', 'weekly-empty', 'heartbeat', 'catch_up']);

export function classifySkip(reason) {
  const key = String(reason || '');
  if (key.startsWith('lens:')) return { class: VERDICT.BLOCKED, reason: 'unsupported-lens' };
  const hit = Object.hasOwn(SKIP_TABLE, key) ? SKIP_TABLE[key] : null;
  return hit ? { class: hit[0], reason: hit[1] } : { class: VERDICT.FAILED, reason: 'unclassified' };
}

/** Total function over today's result bag. Returns null only for the queue fan-out placeholder. */
export function verdictOf(bag) {
  if (!bag || typeof bag !== 'object') return { class: VERDICT.FAILED, reason: 'unclassified' };
  if (bag.mode === 'queue') return null;
  if (bag.error) return { class: VERDICT.FAILED, reason: 'error' };
  if (bag.skipped) return classifySkip(bag.skipped);
  if (bag.sent) return { class: VERDICT.DELIVERED, reason: SEND_ACTIONS.has(bag.action) ? bag.action : 'match' };
  if (bag.capped) return { class: VERDICT.HELD, reason: 'send-cap' };
  if (bag.dryRun) return { class: VERDICT.HELD, reason: 'rehearsal' };
  if (bag.action === 'none') return { class: VERDICT.QUIET, reason: 'nothing-new' };
  if (SEND_ACTIONS.has(bag.action)) return { class: VERDICT.FAILED, reason: 'send-wanted-no-outcome' };
  return { class: VERDICT.FAILED, reason: 'unclassified' };
}

/** What a subscriber reads. Operator diagnostics stay in the operator plane. */
export function subscriberLine(verdict) {
  if (!verdict) return null;
  switch (verdict.class) {
    case VERDICT.DELIVERED: return 'Delivered';
    case VERDICT.QUIET: return verdict.reason === 'not-due' ? 'Not due yet' : 'Nothing new';
    case VERDICT.HELD: return 'Waiting';
    case VERDICT.BLOCKED: return verdict.reason === 'recipient-unreachable' ? "Can't reach this address" : "Can't run yet";
    case VERDICT.OFF: return verdict.reason === 'paused' ? 'Paused' : null;
    default: return 'Something went wrong';
  }
}

export function tally(verdicts) {
  const out = { off: 0, blocked: 0, held: 0, quiet: 0, delivered: 0, failed: 0 };
  for (const v of verdicts) if (v) out[v.class] += 1;
  return out;
}
