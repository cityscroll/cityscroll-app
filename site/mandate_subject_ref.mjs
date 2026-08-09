/** Canonical graph identity for one enacted-law obligation. */
export function mandateSubjectRef(obligationId) {
  const id = String(obligationId ?? "").trim();
  if (!id || /\s/.test(id)) return null;
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
