/**
 * The exact identity key the procurement identity gate derives from a
 * publisher identifier.
 *
 * It lives on its own so a reader that only needs to name a contract — a
 * projection pointing at a detail record, for instance — can apply the same
 * rule without pulling in the whole identity gate. One normalization, one
 * owner: a caller that reimplements it will eventually disagree with the
 * records it is trying to address.
 */
export function procurementContractIdentityKey(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
}
