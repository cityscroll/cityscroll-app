import actionLinkHealth from "../../../site/data/action_link_health.json" with { type: "json" };
import registry from "../../../site/action_registry.js";

globalThis.CrolActionLinkHealth = actionLinkHealth;

export const {
  OUTCOME_ENUM,
  compileActionRail,
  solicitationHandoff,
  awardHandoff,
  hearingHandoff,
  ruleHandoff,
  zoningHandoff,
  franchiseHandoff,
  zoningStage,
  landHearingBody,
  packageUrlFromAttachments,
  packageUrlFromBody,
  validateAction,
  outcomeEvent,
} = registry;
