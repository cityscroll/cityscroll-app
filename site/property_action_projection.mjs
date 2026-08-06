/** Scope projections for Property's action-character polyhierarchy. */

import { PROPERTY_ACTION_CHARACTERS } from "./property_action_character.mjs";

export const PROPERTY_ACTION_PROJECTION_SCHEMA_VERSION = 1;

const DESTINATIONS = Object.freeze({
  marketplace: Object.freeze({ surfaces: Object.freeze(["now", "money"]), domains: Object.freeze(["property", "money"]), context: "marketplace" }),
  participation: Object.freeze({ surfaces: Object.freeze(["meetings"]), domains: Object.freeze(["property", "meetings"]), context: "participation" }),
  relief: Object.freeze({ surfaces: Object.freeze(["owner_help"]), domains: Object.freeze(["property"]), context: "owner_help" }),
  historical_result: Object.freeze({ surfaces: Object.freeze(["property"]), domains: Object.freeze(["property"]), context: "archive" }),
});

export function propertyActionProjection(character) {
  return DESTINATIONS[character] || null;
}

export function propertyProjectionScope(character, { surface = null } = {}) {
  const destination = propertyActionProjection(character);
  if (!destination || (surface && !destination.surfaces.includes(surface))) return null;
  const domain = surface === "money" ? "money" : surface === "meetings" ? "meetings" : "property";
  return {
    schema: "cityscroll.scope",
    version: 0,
    facets: { domains: [domain], actions: [], values: { action_character: character } },
    projection: { schema_version: PROPERTY_ACTION_PROJECTION_SCHEMA_VERSION, source_domain: "property", context: destination.context },
  };
}

export function projectPropertyRecord(record = {}) {
  const character = record.action_character;
  const destination = propertyActionProjection(character);
  if (!destination) return null;
  return {
    ...record,
    source_domain: record.source_domain || "property",
    projection: {
      schema_version: PROPERTY_ACTION_PROJECTION_SCHEMA_VERSION,
      source_domain: "property",
      canonical_id: record.request_id || record.id || null,
      canonical_route: record.route || (record.request_id ? `/notices/${encodeURIComponent(record.request_id)}` : null),
      action_character: character,
      surfaces: [...destination.surfaces],
      context: destination.context,
    },
    scope_domains: [...destination.domains],
  };
}

export function projectPropertyRecords(records = []) {
  return (Array.isArray(records) ? records : []).map(projectPropertyRecord).filter(Boolean);
}

export function propertyProjectionCharacters() {
  return [...PROPERTY_ACTION_CHARACTERS];
}
