/**
 * Validation and payload shape for the About page's feedback form, plus the
 * static content model for its optional, collapsed past-task guidance.
 *
 * The guidance itself asks about the reader's actual last attempt — the
 * task, where it broke down, and what they did instead — but it never adds
 * a field, a submission path, or a network call of its own: the reader
 * still writes in the one existing message textarea, and only the existing
 * Send button posts to the existing endpoint. See
 * docs/design-principles-contextual-ux.md, "Ask about actual attempts".
 */

export const FEEDBACK_MESSAGE_MIN_LENGTH = 10;
export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

/** The three optional guidance prompts, in display order. Fixed set — never grown by reader input. */
export const PAST_TASK_GUIDANCE_PROMPTS = Object.freeze([
  Object.freeze({ id: "task", i18nKey: "about_pasttask_task_html" }),
  Object.freeze({ id: "breakdown", i18nKey: "about_pasttask_breakdown_html" }),
  Object.freeze({ id: "workaround", i18nKey: "about_pasttask_workaround_html" }),
]);

/** The guidance disclosure never opens itself; a reader must expand it. */
export function pastTaskGuidanceDefaultOpen() {
  return false;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

/**
 * Same three checks the form has always run — short message, long message,
 * malformed optional email — unchanged by the guidance panel's presence.
 * Returns the i18n key for the error to show, or null when the input is valid.
 */
export function feedbackValidationError(message, email) {
  const trimmedMessage = String(message ?? "").trim();
  if (trimmedMessage.length < FEEDBACK_MESSAGE_MIN_LENGTH) return "about_err_short";
  if (trimmedMessage.length > FEEDBACK_MESSAGE_MAX_LENGTH) return "about_err_long";
  const trimmedEmail = String(email ?? "").trim();
  if (trimmedEmail && !looksLikeEmail(trimmedEmail)) return "about_err_bademail";
  return null;
}

/**
 * The exact payload shape posted to /feedback: category, message, email —
 * and nothing else. Guidance is never folded in as a separate field; any
 * reader who used it has already written its substance into `message`.
 */
export function feedbackPayload(category, message, email) {
  return {
    category: String(category ?? ""),
    message: String(message ?? "").trim(),
    email: String(email ?? "").trim(),
  };
}
