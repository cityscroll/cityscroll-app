// Civic Graph grounding states — measured product depth per catalog entry.
// Distinct from catalog status (registered | unregistered):
//   status     = is this live allowlist id listed in the registry?
//   grounding  = how deeply is the type realized in product code / observations?
//
// Values: built | partial | gap
//   built   — first-class product noun with stable ids and durable backing
//   partial — exists in product paths (spine, dual-write shadow, allowlist) but incomplete
//   gap     — named type with little/no first-class grounding yet

export const GROUNDING_STATES = Object.freeze(["built", "partial", "gap"]);

export const GROUNDING_NOTE =
  "Grounding is measured product depth (built/partial/gap), not catalog membership.";

/**
 * @param {unknown} value
 * @returns {value is "built"|"partial"|"gap"}
 */
export function isGroundingState(value) {
  return GROUNDING_STATES.includes(value);
}

/**
 * Validate one catalog entry's grounding field.
 * Unregistered entries must not claim "built" (no first-class allowlist home).
 * @param {{ id?: string, status?: string, grounding?: string, reason?: string }} entry
 * @param {string} section
 */
export function validateEntryGrounding(entry, section = "entry") {
  const id = entry?.id || "(missing-id)";
  if (!isGroundingState(entry?.grounding)) {
    throw new TypeError(
      `${section} ${id}: grounding must be one of ${GROUNDING_STATES.join("|")}`,
    );
  }
  if (entry.status === "unregistered" && entry.grounding === "built") {
    throw new TypeError(
      `${section} ${id}: unregistered entries cannot have grounding=built`,
    );
  }
  if (entry.status === "unregistered" && (!entry.reason || entry.reason.length < 10)) {
    throw new TypeError(`${section} ${id}: unregistered entries require a reason`);
  }
  return true;
}

/**
 * Require grounding on every object_type and link_type (and optional sections).
 * @param {object} registry
 * @param {{ event_kinds?: boolean, kinetic?: boolean }} [opts]
 */
export function validateRegistryGrounding(registry, opts = {}) {
  const sections = [
    ["object_types", registry.object_types],
    ["link_types", registry.link_types],
  ];
  if (opts.event_kinds !== false) {
    sections.push(["event_kinds", registry.event_kinds]);
  }
  for (const [name, entries] of sections) {
    if (!Array.isArray(entries)) {
      throw new TypeError(`registry.${name} must be an array`);
    }
    for (const entry of entries) {
      validateEntryGrounding(entry, name);
    }
  }
  if (opts.kinetic !== false && registry.kinetic_action_types) {
    const kinetic = registry.kinetic_action_types;
    for (const key of ["reader_actions", "action_deliveries", "product_method_log", "outcomes"]) {
      for (const entry of kinetic[key] || []) {
        validateEntryGrounding(entry, `kinetic_action_types.${key}`);
      }
    }
  }
  return true;
}

/**
 * Summarize grounding distribution for evaluation receipts.
 * @param {object} registry
 */
export function summarizeGrounding(registry) {
  const object = countGrounding(registry.object_types);
  const link = countGrounding(registry.link_types);
  const event = countGrounding(registry.event_kinds);
  const objectTotal = object.built + object.partial + object.gap;
  const linkTotal = link.built + link.partial + link.gap;
  return {
    objects: object,
    links: link,
    event_kinds: event,
    object_built_rate: objectTotal ? object.built / objectTotal : null,
    link_built_rate: linkTotal ? link.built / linkTotal : null,
    // Gap-grounded *cataloged* nouns — the enrichment frontier (not class-b forever).
    object_gap_ids: idsWithGrounding(registry.object_types, "gap"),
    link_gap_ids: idsWithGrounding(registry.link_types, "gap"),
  };
}

function countGrounding(entries) {
  const out = { built: 0, partial: 0, gap: 0 };
  for (const entry of entries || []) {
    if (isGroundingState(entry.grounding)) out[entry.grounding] += 1;
  }
  return out;
}

function idsWithGrounding(entries, grounding) {
  return (entries || [])
    .filter((e) => e.grounding === grounding)
    .map((e) => e.id)
    .sort();
}

/**
 * Metrics block for cityscroll.intelligence_receipt.v0.
 * @param {object} registry
 */
export function groundingMetrics(registry) {
  const s = summarizeGrounding(registry);
  return {
    object_grounding_built: s.objects.built,
    object_grounding_partial: s.objects.partial,
    object_grounding_gap: s.objects.gap,
    object_grounding_built_rate: s.object_built_rate,
    link_grounding_built: s.links.built,
    link_grounding_partial: s.links.partial,
    link_grounding_gap: s.links.gap,
    link_grounding_built_rate: s.link_built_rate,
    event_kind_grounding_partial: s.event_kinds.partial,
    event_kind_grounding_built: s.event_kinds.built,
    event_kind_grounding_gap: s.event_kinds.gap,
    object_gap_count: s.object_gap_ids.length,
    link_gap_count: s.link_gap_ids.length,
  };
}
