/**
 * Lightweight homepage email-updates markup.
 *
 * Kept free of Following document imports so the Near You shell can expose the
 * handoff without pulling the watch-builder graph onto the cold homepage load.
 */

export const HOME_FOLLOWING_ONBOARDING_HREF = "/following/?onboarding=1";

/** Plain homepage label for the email-updates handoff. */
export const HOME_EMAIL_ENTRY_LABEL = "Get email updates";

/**
 * Explains the Following watch journey before the person clicks.
 * Navigation alone never enrolls or collects an email.
 */
export const HOME_EMAIL_ENTRY_EXPLAIN =
  "Choose a topic and place, preview matches, then enter your email. Opening this link does not enroll you.";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Above-the-fold homepage email-updates action into Following onboarding.
 * Never includes an email field or posts /subscribe.
 * @param {object} [options]
 * @param {string} [options.href]
 * @param {(value: string) => string} [options.escape]
 * @returns {string}
 */
export function renderHomeEmailEntryHtml({
  href = HOME_FOLLOWING_ONBOARDING_HREF,
  escape = esc,
} = {}) {
  const destination = String(href || HOME_FOLLOWING_ONBOARDING_HREF);
  const safeHref = /[?&]email=/i.test(destination)
    ? HOME_FOLLOWING_ONBOARDING_HREF
    : destination || HOME_FOLLOWING_ONBOARDING_HREF;
  return `<p class="near-home-email-entry" data-home-email-entry>
    <a class="near-home-email-entry-link" href="${escape(safeHref)}" data-home-email-entry-link>${escape(HOME_EMAIL_ENTRY_LABEL)}</a>
    <span class="near-home-email-entry-explain">${escape(HOME_EMAIL_ENTRY_EXPLAIN)}</span>
  </p>`;
}

export function isHomeFollowingOnboardingHref(href) {
  try {
    const url = new URL(String(href || ""), "https://cityscroll.org");
    if (!/^\/following\/?$/.test(url.pathname)) return false;
    return url.searchParams.get("onboarding") === "1";
  } catch {
    return false;
  }
}
