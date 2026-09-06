/**
 * Activation proof for the documented Legistar matter Histories endpoint.
 *
 * Live NYC Histories requests are allowed only when a retained, sanitized,
 * authenticated response proves the route and identity joins. Reconstructed
 * snapshot fixtures are not that proof.
 */

import defaultProof from "./matter_histories_source_gate.fixture.json" with { type: "json" };

export const MATTER_HISTORIES_SOURCE_GATE_SCHEMA = "cityscroll.matter_histories_source_gate.v1";
export const MATTER_HISTORIES_ADAPTER = "matter-histories";
export const MATTER_EVENT_ITEMS_ADAPTER = "event-items-by-matter";

function hasSecretLeak(proof) {
  return /token=|legistar_api_token/i.test(JSON.stringify(proof || {}));
}

function joinsAreComplete(joins) {
  if (!Array.isArray(joins) || joins.length === 0) return false;
  return joins.every((row) => (
    /^\d+$/.test(String(row?.matter_id || ""))
    && /^\d+$/.test(String(row?.event_id || ""))
    && /^\d+$/.test(String(row?.event_item_id || ""))
  ));
}

export function evaluateMatterHistoriesSourceGate(proof = defaultProof) {
  const joins = Array.isArray(proof?.identity_joins) ? proof.identity_joins : [];
  const authenticated = proof?.nyc_authenticated_histories_response === true;
  const sanitized = proof?.sanitized === true && !hasSecretLeak(proof);
  const declared = proof?.passed === true;
  const passed = Boolean(
    proof?.schema === MATTER_HISTORIES_SOURCE_GATE_SCHEMA
    && declared
    && authenticated
    && sanitized
    && joinsAreComplete(joins),
  );
  return {
    schema: MATTER_HISTORIES_SOURCE_GATE_SCHEMA,
    passed,
    adapter: passed ? MATTER_HISTORIES_ADAPTER : MATTER_EVENT_ITEMS_ADAPTER,
    reason: passed
      ? null
      : (proof?.reason || "histories-source-gate-not-passed"),
    identity_join_count: joins.length,
    nyc_authenticated_histories_response: authenticated,
  };
}

export function defaultMatterHistoriesSourceGate() {
  return evaluateMatterHistoriesSourceGate(defaultProof);
}
