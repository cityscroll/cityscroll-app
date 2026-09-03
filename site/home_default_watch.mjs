// The disclosed weekly-Contracts default under the masthead. The card ships on every
// index.html route, so this enhancement has to attach whether the reader landed on the
// static-first home (site/home_entry.mjs) or on a hash route that boots the full app
// (site/app/main.mjs). It runs before core.mjs installs globalThis.workerFetch, so it
// carries its own minimal fetch with the same two-origin fallback.
const API_ORIGINS = Object.freeze([
  window.CROL_API_ORIGIN || "https://api.cityscroll.org",
  window.CROL_API_FALLBACK_ORIGIN || "https://cityscroll-worker.crol-worker.workers.dev",
]);

async function subscribeHomeDefault(email, lang) {
  const body = JSON.stringify({ email, no_topic: true, source: "top-of-site", lang });
  let lastError;
  for (const origin of API_ORIGINS) {
    try {
      const response = await fetch(`${origin.replace(/\/$/, "")}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return await response.json().catch(() => ({}));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("subscribe failed");
}

// Homepage default-watch reason → the same i18n keys the Following/Alerts subscribe
// surfaces already use for these worker reasons (see subscribeErrorWhy in site/app/alerts.mjs);
// anything else, including a failed save, falls through to the generic retry copy.
const HOME_CTA_ERROR_KEYS = Object.freeze({
  "rate-limited": "rate_limited",
  "bad-email": "bad_email",
  "channel-unsupported": "channel_unsupported",
  "not-configured": "not_configured",
  "send-failed": "send_failed",
});

function homeCtaErrorMessage(reason) {
  const key = HOME_CTA_ERROR_KEYS[reason] || "generic_error";
  return window.t?.(key) || "Something went wrong — please try again.";
}

/**
 * Progressive enhancement for the disclosed weekly-Contracts default: the form works as a
 * plain POST to /subscribe without JS (see the no-JS branch of worker/src/subscribe.mjs's
 * reply()); here we intercept submit to enroll via the ordinary /subscribe transaction and
 * report status inline instead of navigating away.
 */
export function initHomeDefaultSubscription() {
  const form = document.getElementById("homeCtaForm");
  const emailInput = document.getElementById("homeCtaEmail");
  const message = document.getElementById("homeCtaMsg");
  const button = document.getElementById("homeCtaSubmit");
  const langField = document.getElementById("homeCtaLang");
  if (!form || !emailInput || !message || !button) return;
  if (form.dataset.defaultWatchEnhanced === "true") return;
  form.dataset.defaultWatchEnhanced = "true";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      message.textContent = window.t?.("enter_valid_email") || "Enter a valid email address.";
      emailInput.setAttribute("aria-invalid", "true");
      emailInput.focus();
      return;
    }
    emailInput.removeAttribute("aria-invalid");
    button.disabled = true;
    message.textContent = window.t?.("subscribing_now") || "Subscribing…";
    const lang = window.LANG || "en";
    if (langField) langField.value = lang;
    try {
      const result = await subscribeHomeDefault(email, lang);
      if (result?.ok) {
        message.textContent = result.created === false
          ? (window.t?.("home_cta_active_now") || "You're already getting these.")
          : `${window.t?.("subscribed_now") || "You're subscribed — we'll email you."} ${window.t?.("welcome_sent_to", { email }) || ""}`.trim();
        emailInput.value = "";
      } else if (result?.subscribed === true) {
        message.textContent = `${window.t?.("subscribed_now") || "You're subscribed — we'll email you."} ${homeCtaErrorMessage(result?.reason)}`.trim();
      } else {
        message.textContent = homeCtaErrorMessage(result?.reason);
      }
    } catch {
      message.textContent = window.t?.("cant_reach_server") || "Couldn't reach the server — try again.";
    } finally {
      button.disabled = false;
    }
  });
}
