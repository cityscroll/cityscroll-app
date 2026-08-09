// Conservative text-to-entity referents. Exact, unique matches only.

import { resolveLeadershipReferent } from "../leaders/index.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formsFor(entity) {
  return [entity?.display_name, entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : []), ...(Array.isArray(entity?.surface_forms) ? entity.surface_forms : [])]
    .map(normalized)
    .filter(Boolean);
}

function containsForm(text, form) {
  const haystack = normalized(text);
  return haystack === form || new RegExp(`(?:^|\\s)${form.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:$|\\s)`, "i").test(haystack);
}

/** Resolve an opaque referent only when an explicit alias matches one entity. */
export function resolveOpaqueReferent(referent, { entities = [] } = {}) {
  const text = clean(referent);
  if (!text || !Array.isArray(entities)) return null;
  const matches = entities.filter((entity) => entity?.id && formsFor(entity).some((form) => containsForm(text, form)));
  const unique = [...new Map(matches.map((entity) => [String(entity.id), entity])).values()];
  if (unique.length !== 1) return null;
  const entity = unique[0];
  return {
    referent: text,
    entity,
    confidence: { status: "strong", basis: "exact_explicit_alias" },
    method: "exact_explicit_alias",
  };
}

/** Try agency leadership first, then exact opaque aliases. */
export function resolveReferent(referent, context = {}) {
  return resolveLeadershipReferent(referent, context)
    || resolveOpaqueReferent(referent, context);
}
