// The public /search adapter carries both its presentation lanes and the
// transport-neutral federated envelope. Search owns card/lane presentation;
// civic coverage meaning comes from the registered capability whenever the
// envelope is available. Older or degraded adapters may still return the
// presentation coverage, so absence of the envelope remains non-fatal.
let validatorPromise;

export async function canonicalSearchCoverage(payload) {
  if (payload?.federated) {
    try {
      validatorPromise ||= import("../capabilities/federated_search.mjs");
      const { validateFederatedSearchOutput } = await validatorPromise;
      return validateFederatedSearchOutput(payload.federated).coverage;
    } catch {
      // Preserve the existing unavailable/legacy rendering for a malformed
      // or partially deployed adapter rather than turning a search result into
      // a blank page.
    }
  }
  return payload?.coverage || null;
}
