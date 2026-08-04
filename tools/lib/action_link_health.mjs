const DEFAULT_ESCALATION_AFTER = 2;

function isFailureVerdict(verdict) {
  return verdict !== "OK";
}

/**
 * Fold one machine-readable action-link audit into the persisted public health state.
 * Degradation begins on the first failed verdict; issue escalation waits for a
 * configurable number of consecutive failures. A passing verdict clears both.
 */
export function applyAuditVerdicts(report, previous = {}, options = {}) {
  const escalationAfter = Number(options.escalationAfter || DEFAULT_ESCALATION_AFTER);
  if (!Number.isInteger(escalationAfter) || escalationAfter < 1) {
    throw new TypeError("escalationAfter must be a positive integer");
  }
  const generatedAt = String(report?.generated_at || new Date().toISOString());
  const previousPatterns = previous?.patterns && typeof previous.patterns === "object"
    ? previous.patterns
    : {};
  const patterns = {};
  const degradedPatterns = [];
  const persistentlyBrokenPatterns = [];
  const newlyEscalatedPatterns = [];
  const recoveredPatterns = [];

  for (const result of report?.patterns || []) {
    if (!result?.id) continue;
    const prior = previousPatterns[result.id] || {};
    const failed = isFailureVerdict(result.verdict);
    const consecutiveFailures = failed ? Number(prior.consecutive_failures || 0) + 1 : 0;
    const degraded = failed;
    if (degraded) degradedPatterns.push(result.id);
    if (consecutiveFailures >= escalationAfter) persistentlyBrokenPatterns.push(result.id);
    if (consecutiveFailures === escalationAfter) newlyEscalatedPatterns.push(result.id);
    if (!failed && prior.degraded) recoveredPatterns.push(result.id);

    patterns[result.id] = {
      verdict: result.verdict,
      degraded,
      consecutive_failures: consecutiveFailures,
      first_failed_at: failed ? (prior.first_failed_at || generatedAt) : null,
      last_checked_at: generatedAt,
      recovered_at: !failed && prior.degraded ? generatedAt : (prior.recovered_at || null),
      upstream_fallback: result.upstream_fallback || prior.upstream_fallback || null,
      public_note_key: degraded ? "next_action_unavailable_handoff" : null,
    };
  }

  return {
    schema: "cityscroll.action_link_health.v1",
    generated_at: generatedAt,
    escalation_after: escalationAfter,
    patterns,
    summary: {
      degraded_patterns: degradedPatterns,
      persistently_broken_patterns: persistentlyBrokenPatterns,
      newly_escalated_patterns: newlyEscalatedPatterns,
      recovered_patterns: recoveredPatterns,
    },
  };
}

export function renderBrowserHealthState(state) {
  return `(function(root){root.CrolActionLinkHealth=Object.freeze(${JSON.stringify(state)});})(typeof globalThis!=="undefined"?globalThis:this);\n`;
}
