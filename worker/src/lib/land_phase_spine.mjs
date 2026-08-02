/**
 * Re-export Land ULURP phase grouping for worker/tests.
 * Source of truth: site/land_phase_spine.mjs
 */
export {
  LAND_PHASE_SPINE_SCHEMA_VERSION,
  LAND_ULURP_PHASES,
  LAND_PHASE_META,
  mapMilestoneToPhase,
  aggregatePhaseEvents,
  isProjectPortalUrl,
  buildLandPhaseView,
  countDuplicatePortalLinks,
} from "../../../site/land_phase_spine.mjs";
