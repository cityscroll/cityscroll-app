// Side-effect binder for Land project HTTP/MCP adapters. Imported by the
// Worker composition root so worker/src/land_projects.mjs stays free of
// static presentation and mixed-module imports.

import { attachLandProjectsPresentation } from "../worker/src/land_projects.mjs";
import {
  resolveLandActionProcedures,
  buildLandDecisionPathView,
  publicLandDecisionPathView,
  landProjectUrl,
  filterLandSnapshot,
} from "./land_projects_presentation.mjs";
import { loadZapProjectsLookup } from "../worker/src/lib/zap_projects_lookup_kv.mjs";
import { readZapOutcomeRecord, outcomeCacheIsFresh } from "../worker/src/zap_outcomes.mjs";

attachLandProjectsPresentation({
  resolveLandActionProcedures,
  buildLandDecisionPathView,
  publicLandDecisionPathView,
  landProjectUrl,
  filterLandSnapshot,
  loadZapProjectsLookup,
  readZapOutcomeRecord,
  outcomeCacheIsFresh,
});
