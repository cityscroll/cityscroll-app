// Notification is separate from recording and repair. Monitor failures are
// operational evidence; only a freshly verified emergency interrupts an owner.
export const OPS_NOTIFICATION_POLICY = Object.freeze({
  mode: "emergency-only",
  version: 1,
  routine_destination: "desk",
  emergency_guard: "production-emergency",
  emergency_impacts: ["service-unavailable", "active-data-loss", "active-security-incident"],
  verification_max_age_ms: 15 * 60 * 1000,
});

export function opsNotificationDecision(input = {}, now = new Date()) {
  const e = input.emergency;
  const age = now.getTime() - Date.parse(e?.verified_at);
  let proof = false;
  try {
    const url = new URL(e?.evidence_url);
    proof = url.protocol === "https:" && !url.username && !url.password && !url.search;
  } catch {}
  const eligible = input.guard === OPS_NOTIFICATION_POLICY.emergency_guard
    && OPS_NOTIFICATION_POLICY.emergency_impacts.includes(e?.impact)
    && e?.confirmed === true && e?.human_action_required === true
    && ["exhausted", "unavailable"].includes(e?.automatic_remedy)
    && typeof e?.action === "string" && e.action.trim().length >= 10 && e.action.length <= 500
    && Number.isFinite(age) && age >= 0 && age <= OPS_NOTIFICATION_POLICY.verification_max_age_ms
    && proof;
  return {
    policy: OPS_NOTIFICATION_POLICY.mode,
    email: eligible,
    reason: eligible ? "confirmed-emergency" : "desk-only",
    ...(eligible ? { impact: e.impact, action: e.action.trim(), evidence_url: e.evidence_url, verified_at: e.verified_at } : {}),
  };
}
