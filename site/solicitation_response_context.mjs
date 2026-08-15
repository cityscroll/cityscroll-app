function hasText(value) {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== null && value !== undefined;
}

/**
 * A response affordance is meaningful only when it is attached to a named
 * solicitation and at least one concrete response fact.
 */
export function solicitationResponseContextReady(row) {
  const r = row || {};
  const identityReady = r.type_of_notice_description === "Solicitation"
    && hasText(r.short_title || r.title)
    && hasText(r.agency_name);
  if (!identityReady) return false;

  return [
    r.due_date,
    r.email,
    r.contact_phone,
    r.contact_name,
    r.address_to_request,
    r.street_address_1,
  ].some(hasText);
}
