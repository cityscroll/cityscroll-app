/**
 * Strict bare mandate id for filters, backlinks, and digests.
 *
 * Accepts a bare id or legacy subject-ref forms `mandate:<id>` / bare
 * `obligation:<id>` (not compound storage keys like `obligation:<id>:<date>`).
 * No free-text duty matching — exact id only.
 */
export function canonicalMandateId(value) {
  let s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  const legacy = s.match(/^(?:mandate|obligation):([^:\s]+)$/i);
  if (legacy) s = legacy[1];
  if (!s || /\s/.test(s) || s.includes(":")) return null;
  // Matter-index ids (66056-006) and fixture-style slugs (cross-bridge-obligation-001).
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s)) return null;
  return s;
}

/** Canonical graph identity for one enacted-law obligation. */
export function mandateSubjectRef(obligationId) {
  const id = canonicalMandateId(obligationId);
  if (!id) return null;
  return `mandate:${id}`;
}

/**
 * Migrate the former bare graph alias without touching compound watch/storage ids.
 *
 * `obligation:<id>:<deadline>` and other unrelated identities remain unchanged;
 * they are storage keys, not graph subjects.
 */
export function migrateLegacyMandateSubjectRef(ref) {
  if (typeof ref !== "string") return ref;
  const value = ref;
  const match = value.match(/^obligation:([^:\s]+)$/);
  return match ? mandateSubjectRef(match[1]) : value;
}
