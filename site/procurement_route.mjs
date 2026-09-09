// Canonical procurement navigation without importing object construction.
export function procurementCanonicalHref(recordOrId) {
  const id = typeof recordOrId === "object" ? recordOrId?.procurement_id : recordOrId;
  return id ? `/procurements/${encodeURIComponent(String(id))}` : null;
}
