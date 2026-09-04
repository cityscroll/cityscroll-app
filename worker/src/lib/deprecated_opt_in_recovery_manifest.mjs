// Bounded reconstruction of the four delivered, never-confirmed signups recovered from the
// Resend confirm-mail log. This is the only recovery input: callers cannot shrink the set
// to a single address. The three real subscribers receive recovered pending-enrollment
// watches; the plus-tagged e2e account below is marked test and is not enrolled.
//
// The three real rows are not committed to source: they live in the private
// DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON secret (`wrangler secret put
// DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON`, a JSON array of exactly three
// `{ email, lens, filter, freq, original_signup_at }` rows — see worker/README.md).
// loadDeprecatedOptInRecoveryManifest merges that secret with the committed developer/test
// row so the bounded four-row, all-or-nothing recovery contract survives the move.

const DEVELOPER_TEST_ROW = Object.freeze({
  email: "jamesca2ro+scope-watch-e2e-20260806@gmail.com",
  lens: "money",
  filter: Object.freeze({
    agency: "Housing Preservation and Development",
    noticeType: "award",
    entity_refs_all: Object.freeze(["agency:id:housing-preservation-and-development"]),
    connection_relation: "published_by_agency",
  }),
  freq: "daily",
  original_signup_at: "2026-08-06T01:48:49.718Z",
});

export const RECOVERED_SUBSCRIBER_COUNT = 3;
export const RECOVERY_MANIFEST_SIZE = RECOVERED_SUBSCRIBER_COUNT + 1;

/**
 * Loads the bounded recovery manifest: the private three-row subscriber secret plus the
 * committed developer/test row. Throws if the secret is absent, malformed, or is not
 * exactly three rows — the all-or-nothing contract must survive relocating subscriber PII
 * out of source.
 */
export function loadDeprecatedOptInRecoveryManifest(env) {
  const raw = env?.DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON;
  if (!raw) throw new TypeError("DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON is required");
  let subscriberRows;
  try {
    subscriberRows = JSON.parse(raw);
  } catch {
    throw new TypeError("DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON is not valid JSON");
  }
  if (!Array.isArray(subscriberRows) || subscriberRows.length !== RECOVERED_SUBSCRIBER_COUNT) {
    throw new TypeError(`DEPRECATED_OPT_IN_RECOVERY_MANIFEST_JSON must contain exactly ${RECOVERED_SUBSCRIBER_COUNT} rows`);
  }
  const rows = Object.freeze([
    ...subscriberRows.map((row) => Object.freeze({ ...row, filter: Object.freeze({ ...(row?.filter || {}) }) })),
    DEVELOPER_TEST_ROW,
  ]);
  if (rows.length !== RECOVERY_MANIFEST_SIZE) {
    throw new TypeError(`recovery manifest must contain exactly ${RECOVERY_MANIFEST_SIZE} rows`);
  }
  return rows;
}
