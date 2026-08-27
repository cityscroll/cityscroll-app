import {
  homeEntryReady,
  runtimeRumSemanticMilestones,
} from "./rum_static_record_instrumentation.mjs";
import { renderInterpretPreview } from "./interpret_preview.mjs";

const API_ORIGINS = Object.freeze([
  window.CROL_API_ORIGIN || "https://api.cityscroll.org",
  window.CROL_API_FALLBACK_ORIGIN || "https://crol-worker.crol-worker.workers.dev",
]);

function homeSubscribeUrl(origin) {
  return `${origin.replace(/\/$/, "")}/subscribe`;
}

async function subscribe(email) {
  let lastError;
  for (const origin of API_ORIGINS) {
    try {
      const response = await fetch(homeSubscribeUrl(origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, no_topic: true, source: "top-of-site", lang: window.LANG || "en" }),
      });
      if (response.ok) return response.json().catch(() => ({}));
      lastError = new Error(`subscribe failed: ${response.status}`);
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

function initSubscription() {
  const form = document.getElementById("homeCtaForm");
  const emailInput = document.getElementById("homeCtaEmail");
  const message = document.getElementById("homeCtaMsg");
  const button = document.getElementById("homeCtaSubmit");
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
    try {
      const result = await subscribe(email);
      if (result?.ok) {
        message.textContent = `${window.t?.("subscribed_now") || "You're subscribed — we'll email you."} ${window.t?.("welcome_sent_to", { email }) || ""}`.trim();
        emailInput.value = "";
      } else {
        message.textContent = window.t?.("cant_reach_server") || "We could not reach the subscription service.";
      }
    } catch {
      message.textContent = window.t?.("cant_reach_server") || "We could not reach the subscription service.";
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
initSubscription();
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
