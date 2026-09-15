function status(button, message) {
  const target = button?.closest("[data-oath-observer-request]")?.querySelector("[data-oath-copy-status]");
  if (target) { target.textContent = message; target.hidden = false; }
}

export function installOathObserverRequestControls(root = document) {
  for (const button of root.querySelectorAll("[data-oath-copy-request]")) {
    button.addEventListener("click", async () => {
      const text = button.closest("[data-oath-observer-request]")?.querySelector("[data-oath-request-text]")?.value || "";
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(text);
        status(button, "Observer request copied.");
      } catch {
        const area = button.closest("[data-oath-observer-request]")?.querySelector("[data-oath-request-text]");
        area?.focus(); area?.select();
        status(button, "Copy was unavailable. Select and copy the request text below.");
      }
    });
  }
}

if (typeof document !== "undefined") installOathObserverRequestControls();
