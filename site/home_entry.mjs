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
        body: JSON.stringify({ email, lens: "money", filter: {}, freq: "weekly", lang: window.LANG || "en" }),
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
    message.textContent = window.t?.("sending_confirm_link") || "Sending a confirmation link…";
    try {
      const result = await subscribe(email);
      if (result?.ok) {
        message.textContent = `${window.t?.("check_inbox") || "Check your inbox."} ${window.t?.("sent_confirm_to", { email }) || ""}`.trim();
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
function ensureApplicationForHash() {
  if (!location.hash) return Promise.resolve();
  document.body?.setAttribute("data-app-route", "true");
  applicationPromise ||= globalThis.CROLLoadApplication?.() || Promise.resolve();
  return applicationPromise;
}

initLanguageSwitcher();
initSubscription();
window.addEventListener("hashchange", () => {
  ensureApplicationForHash().catch(() => {});
});
