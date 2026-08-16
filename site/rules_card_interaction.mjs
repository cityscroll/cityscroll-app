import { objectCardInteractionProjection } from "./affordance_grammar.mjs";

function text(value) {
  return String(value ?? "").trim();
}

/**
 * Map Rules producer fields into the shared object-card interaction contract.
 * A rule card always has one canonical notice target. Only dated, destination-
 * backed comment and hearing transitions qualify as kinetic actions.
 */
export function rulesCardInteractionProjection({
  request_id,
  title,
  fine_stage = null,
  rule_url = null,
  comment_url = null,
  comment_by_date = null,
  hearing_date = null,
  comment_label = "Comment",
  hearing_label = "Follow hearing",
  official_source_label = "Official rule",
  relations = [],
} = {}) {
  const requestId = text(request_id);
  const ruleHref = text(rule_url);
  const commentHref = text(comment_url) || ruleHref;
  const commentDate = text(comment_by_date);
  const hearingDate = text(hearing_date);
  let action = null;

  if (fine_stage === "comment-open" && commentHref && commentDate) {
    action = {
      label: text(comment_label),
      href: commentHref,
      kind: "comment",
      primary: true,
      context_ready: true,
      attributes: { "data-card-fact": `comment-deadline:${commentDate}` },
    };
  } else if (fine_stage === "hearing" && ruleHref && hearingDate) {
    action = {
      label: text(hearing_label),
      href: ruleHref,
      kind: "attend",
      primary: true,
      context_ready: true,
      attributes: { "data-card-fact": `hearing-date:${hearingDate}` },
    };
  }

  const officialHandoffs = ruleHref && ruleHref !== action?.href
    ? [{ label: text(official_source_label), href: ruleHref, kind: "official_source" }]
    : [];

  return objectCardInteractionProjection({
    target: requestId && text(title)
      ? { href: `/notices/${encodeURIComponent(requestId)}`, label: text(title) }
      : null,
    relations,
    external_handoffs: officialHandoffs,
    kinetic_actions: action ? [action] : [],
  });
}
