/**
 * Notice-detail sections owned by a lens module the Notice route does not boot.
 *
 * A public record can carry a land project, a meeting outcome, or a procurement
 * paper trail, but most carry none of them. Each helper decides from the record
 * itself whether the section exists, and only then activates the lens that
 * renders it — so the Notice route's cold boot stays the notice, and a lens
 * arrives on the notices that actually have one.
 */
import { hasRenderableMeetingOutcome, readMeetingOutcome } from "./meeting_outcome_read.mjs";

/**
 * Activate one lens module. A route that already booted the lens resolves
 * immediately; a failed activation resolves rather than rejecting, so a missing
 * optional section never breaks the rest of the notice.
 */
export function ensureNoticeLens(name) {
  return Promise.resolve(globalThis.CrolRouteModules?.ensure(name)).catch(() => null);
}

/**
 * The land-project spine, when the notice is one the spine covers. The
 * eligibility model is a small standalone read; only a covered notice pays for
 * the Land lens behind it.
 */
export async function renderNoticeLandSpine(record, element) {
  if (!element) return;
  const tools = await import("./notice_land_spine.mjs").catch(() => null);
  if (typeof tools?.isNoticeLandSpineEligible !== "function" || !tools.isNoticeLandSpineEligible(record)) {
    element.innerHTML = "";
    return;
  }
  await ensureNoticeLens("land");
  return globalThis.loadNoticeLandSpine?.(record, element);
}

/**
 * The meeting-outcome panel, when the read model has something to show. Reading
 * the record first is what makes the Meetings lens conditional: a notice with no
 * hearing and no matched meeting renders nothing, so it has no reason to boot
 * the module that would render one.
 */
export async function renderNoticeMeetingOutcomes(record, element, fetchImpl) {
  if (!element || !record?.request_id) return;
  const payload = await readMeetingOutcome(record.request_id, fetchImpl);
  if (!hasRenderableMeetingOutcome(record, payload)) return;
  await ensureNoticeLens("meetings");
  return globalThis.loadMeetingOutcomes?.(record, element, payload);
}

/**
 * One notice's procurement renewal chain. The chain reader belongs to the
 * Contracts lens, so a notice with a usable PIN activates it and a notice
 * without one never does.
 */
export async function noticeProcurementChain(record) {
  await ensureNoticeLens("money");
  return globalThis.loadChain ? globalThis.loadChain(record) : [record];
}
