import { objectCardInteractionProjection } from "./affordance_grammar.mjs";
import { meetingCanonicalHref } from "./meeting_object_contract.mjs";

function text(value) {
  return String(value ?? "").trim();
}

/**
 * Map publisher-owned meeting facts into the shared object-card contract.
 * The canonical CityScroll document owns navigation and Copy. Producers retain
 * responsibility for deciding whether participation actions and guides have
 * enough published context to appear.
 */
export function meetingsCardInteractionProjection({
  meeting_id = null,
  request_id = null,
  title,
  source_url = null,
  source_label = "Official source",
  relations = [],
  participation_actions = [],
  guide_html = "",
  guide_source_backed = false,
} = {}) {
  const meetingHref = meetingCanonicalHref(text(meeting_id));
  const requestId = text(request_id);
  const targetHref = meetingHref || (requestId ? `/notices/${encodeURIComponent(requestId)}` : null);
  const targetLabel = text(title);
  const sourceHref = text(source_url);
  const actionDestinations = new Set((Array.isArray(participation_actions) ? participation_actions : [])
    .map((action) => text(action?.href || action?.destination))
    .filter(Boolean));

  return objectCardInteractionProjection({
    target: targetHref && targetLabel ? { href: targetHref, label: targetLabel } : null,
    relations,
    external_handoffs: sourceHref && !actionDestinations.has(sourceHref)
      ? [{ label: text(source_label) || "Official source", href: sourceHref, kind: "official_source" }]
      : [],
    kinetic_actions: participation_actions,
    guide: text(guide_html) && guide_source_backed === true
      ? { html: String(guide_html), context_ready: true, source_backed: true }
      : null,
  });
}
