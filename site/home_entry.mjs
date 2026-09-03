import {
  homeEntryReady,
  runtimeRumSemanticMilestones,
} from "./rum_static_record_instrumentation.mjs";
import { renderInterpretPreview } from "./interpret_preview.mjs";

// The static-first homepage defers the full app graph (core.mjs, and with it
// globalThis.workerFetch) behind a hash route or interaction — see the
// isNeutralHome branch in site/app/main.mjs. home_entry.mjs runs before any of
// that loads, so the disclosed default-watch submit needs its own minimal
// fetch with the same two-origin fallback workerFetch normally provides.
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

function initLanguageSwitcher() {
  const select = document.getElementById("langSelect");
  if (!select) return;
  if ([...select.options].some((option) => option.value === window.LANG)) select.value = window.LANG;
  window.applyStrings?.();
  select.addEventListener("change", () => {
    window.setLang?.(select.value);
  });
}

// Homepage default-watch reason → the same generic-error i18n keys the Following/Alerts
// subscribe surfaces already use for these worker reasons (see site/app/alerts.mjs).
const HOME_CTA_ERROR_KEYS = Object.freeze({
  "rate-limited": "rate_limited",
  "bad-email": "bad_email",
  "channel-unsupported": "channel_unsupported",
  "not-configured": "not_configured",
  "save-failed": "not_configured",
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
function initHomeDefaultSubscription() {
  const form = document.getElementById("homeCtaForm");
  const emailInput = document.getElementById("homeCtaEmail");
  const message = document.getElementById("homeCtaMsg");
  const button = document.getElementById("homeCtaSubmit");
  const langField = document.getElementById("homeCtaLang");
  if (!form || !emailInput || !message || !button) return;
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

let applicationPromise;
function ensureApplicationForHash(force = false) {
  if (!force && !location.hash) return Promise.resolve();
  document.body?.setAttribute("data-app-route", "true");
  if (!applicationPromise) {
    const load = globalThis.CROLLoadApplication;
    applicationPromise = typeof load === "function"
      ? Promise.resolve().then(() => load())
      : Promise.reject(new Error("application loader unavailable"));
    applicationPromise.catch(() => { applicationPromise = null; });
  }
  return applicationPromise;
}

function previewFailureHTML() {
  return renderInterpretPreview({
    state: "error",
    error: window.t?.("topic_search_coverage_provider_unavailable", {
      source: window.t?.("tab_money") || "Contracts",
    }) || "This topic could not be previewed right now. Try again.",
  });
}

function activateMoneyPreviewPane() {
  const pane = document.getElementById("tab-money");
  if (!pane) return;
  document.querySelectorAll(".tabpane").forEach((candidate) => {
    candidate.classList.toggle("active", candidate === pane);
  });
  document.querySelectorAll(".tabbtn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === "money");
  });
}

async function bootstrapTopicPreview(event) {
  if (event.type === "keydown" && event.key !== "Enter") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const output = document.getElementById("nltrans");
  try {
    await ensureApplicationForHash(true);
    if (typeof globalThis.nlTranslate !== "function") throw new Error("preview handler unavailable");
    activateMoneyPreviewPane();
    document.getElementById("nlgo")?.removeEventListener("click", bootstrapTopicPreview);
    document.getElementById("nlq")?.removeEventListener("keydown", bootstrapTopicPreview);
    await globalThis.nlTranslate();
  } catch {
    if (output) output.innerHTML = previewFailureHTML();
  }
}

function initTopicPreviewBootstrap() {
  const button = document.getElementById("nlgo");
  const input = document.getElementById("nlq");
  if (!button || !input) return;
  button.addEventListener("click", bootstrapTopicPreview);
  input.addEventListener("keydown", bootstrapTopicPreview);
}

initLanguageSwitcher();
initHomeDefaultSubscription();
initTopicPreviewBootstrap();
homeEntryReady(runtimeRumSemanticMilestones(), {
  primaryContext: document.body?.dataset.primaryContext,
  homeReady: document.body?.dataset.homeReady,
  primaryCtaVisible: Boolean(document.getElementById("homeCta")),
  topicInputVisible: Boolean(document.getElementById("home-topic-query")),
});
window.addEventListener("hashchange", () => {
  ensureApplicationForHash().catch(() => {});
});
