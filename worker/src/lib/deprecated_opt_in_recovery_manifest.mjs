// Bounded reconstruction of the four delivered, never-confirmed signups recovered from the
// Resend confirm-mail log. This is the only recovery input: callers cannot shrink the set
// to a single address. The three real people receive recovered pending-enrollment watches;
// the plus-tagged e2e address is marked test and is not enrolled.

export const VETTED_DEPRECATED_OPT_IN_RECOVERY_MANIFEST = Object.freeze([
  Object.freeze({
    email: "shelly.ronen@gmail.com",
    lens: "money",
    filter: Object.freeze({}),
    freq: "weekly",
    original_signup_at: "2026-08-16T23:22:22.092Z",
  }),
  Object.freeze({
    email: "ninodepaola@gmail.com",
    lens: "money",
    filter: Object.freeze({}),
    freq: "weekly",
    original_signup_at: "2026-08-18T15:58:35.654Z",
  }),
  Object.freeze({
    email: "devinbalkind@gmail.com",
    lens: "money",
    filter: Object.freeze({}),
    freq: "weekly",
    original_signup_at: "2026-08-18T21:45:33.701Z",
  }),
  Object.freeze({
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
  }),
]);

export const VETTED_RECOVERED_SIGNUP_EMAILS = Object.freeze([
  "shelly.ronen@gmail.com",
  "ninodepaola@gmail.com",
  "devinbalkind@gmail.com",
]);
