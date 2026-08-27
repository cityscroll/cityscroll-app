import {
  homeEntryReady,
  runtimeRumSemanticMilestones,
} from "./rum_static_record_instrumentation.mjs";
import { renderInterpretPreview } from "./interpret_preview.mjs";

function initLanguageSwitcher() {
  const select = document.getElementById("langSelect");
  if (!select) return;
  if ([...select.options].some((option) => option.value === window.LANG)) select.value = window.LANG;
  window.applyStrings?.();
  select.addEventListener("change", () => {
    window.setLang?.(select.value);
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
