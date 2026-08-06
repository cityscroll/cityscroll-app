import { normalizeScope } from "./scope_v0.mjs";

// A pivot is only valid when the destination can contain the record type that
// produced it. Money has two disjoint City Record populations: solicitations
// (open/all RFPs) and awards. Keep this contract next to the shared scope
// adapter so new generators can use the same guard.
const DESTINATION_TYPES = Object.freeze({
  money: ({ mode } = {}) => mode === "award" ? ["award"] : ["solicitation"],
  land: () => ["land"],
  property: () => ["property"],
  rules: () => ["rule"],
  meetings: () => ["meeting"],
  people: () => ["person"],
});

export function destinationRecordTypes(surface, values = {}) {
  const resolver = DESTINATION_TYPES[String(surface || "")];
  return resolver ? resolver(values) : [];
}

export function pivotDestinationCompatibility({
  destinationSurface,
  destinationScope,
  originRecordType,
} = {}) {
  const scope = normalizeScope(destinationScope || {});
  const accepted = destinationRecordTypes(destinationSurface, scope.facets.values);
  const origin = String(originRecordType || "").trim();
  return {
    compatible: Boolean(origin) && accepted.includes(origin),
    destination_surface: String(destinationSurface || ""),
    destination_record_types: accepted,
    origin_record_type: origin,
  };
}

