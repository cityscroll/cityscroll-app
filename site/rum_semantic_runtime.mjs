import { createRumSemanticMilestones } from "./rum_semantic_milestones.mjs";

const disabledReporter = createRumSemanticMilestones();
let activeReporter = disabledReporter;

/**
 * Return the page-local semantic reporter used by component owners.
 *
 * Production remains a disabled, clock-free no-op until the pilot installs a
 * collector. Tests may install the RUM-05 reporter explicitly; arbitrary
 * metadata never crosses this seam.
 */
export function currentRumSemanticMilestones() {
  return activeReporter;
}

export function installTestOnlyRumSemanticMilestones(reporter, { testOnly = false } = {}) {
  if (testOnly !== true || !reporter || typeof reporter.componentReady !== "function") {
    return { state: "disabled" };
  }
  activeReporter = reporter;
  return { state: "installed" };
}

export function resetTestOnlyRumSemanticMilestones() {
  activeReporter = disabledReporter;
}
