// Worker re-export of the shared digest awareness module (email + site preview).
// Source of truth: site/digest_item_awareness.mjs
export {
  shortDate,
  isRollingDeadline,
  daysUntilEvent,
  deadlineState,
  digestMatterKind,
  matterFromDigestRow,
  primaryNextAction,
  digestItemAwareness,
  itemAwarenessHtml,
  temporalActionHtml,
  adoptionLagAwarenessLine,
} from "../../../site/digest_item_awareness.mjs";
