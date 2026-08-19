import { createContractsRumInstrumentation } from "../contracts_rum.mjs";

const contractsRum = createContractsRumInstrumentation({
  rum: globalThis.CROL_RUM_SEMANTIC_MILESTONES,
});

function beginContractsRumInteraction(options) {
  return contractsRum.beginInteraction(options);
}

function claimContractsRumInteraction() {
  return contractsRum.claimInteraction();
}

function reportContractsRumResults(action, resultState) {
  return contractsRum.resultsRendered(action, resultState);
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.beginContractsRumInteraction = beginContractsRumInteraction;
globalThis.claimContractsRumInteraction = claimContractsRumInteraction;
globalThis.reportContractsRumResults = reportContractsRumResults;
