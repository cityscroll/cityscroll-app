// Pure validation for an inbound /feedback submission — no I/O, fully unit-testable.
//
// Mirrors the /subscribe posture: never trust the client. We reject rather than coerce, except
// for the safe normalizations (trim category/message, lowercase+trim an optional email). Email
// is OPTIONAL — a blank/missing address is valid (the sender just doesn't want a reply).

import { isValidEmail, normalizeEmail } from "./subscriptions.mjs";

export const FEEDBACK_CATEGORIES = ["bug", "feature", "general"];
export const MSG_MIN = 10;
export const MSG_MAX = 2000;

// Returns { ok: true, value: { category, message, email } } or { ok: false, reason }.
// reason ∈ { "bad-category", "bad-message", "bad-email" }.
export function validateFeedback(body) {
  const b = body || {};

  const category = String(b.category == null ? "" : b.category).trim().toLowerCase();
  if (!FEEDBACK_CATEGORIES.includes(category)) return { ok: false, reason: "bad-category" };

  const message = String(b.message == null ? "" : b.message).trim();
  if (message.length < MSG_MIN || message.length > MSG_MAX) return { ok: false, reason: "bad-message" };

  const rawEmail = String(b.email == null ? "" : b.email).trim();
  let email = "";
  if (rawEmail) {
    if (!isValidEmail(rawEmail)) return { ok: false, reason: "bad-email" };
    email = normalizeEmail(rawEmail);
  }

  return { ok: true, value: { category, message, email } };
}
