// One fresh proof per enrollment request. The managed widget only appears when
// Cloudflare needs visitor interaction; the Worker validates every token.
const SITEKEY = "0x4AAAAAADtj-Mskk_RnVd5K";
let scriptPromise;

function loadTurnstile() {
  if (globalThis.turnstile) return Promise.resolve(globalThis.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => globalThis.turnstile ? resolve(globalThis.turnstile) : reject(new Error("bot-check-unavailable"));
      script.onerror = () => reject(new Error("bot-check-unavailable"));
      document.head.appendChild(script);
    }).catch((error) => {
      scriptPromise = null;
      throw error;
    });
  }
  return scriptPromise;
}

export async function signupTurnstileToken(anchor) {
  const turnstile = await loadTurnstile();
  const holder = document.createElement("div");
  holder.className = "signup-turnstile";
  holder.setAttribute("aria-label", "Signup security check");
  (anchor || document.body).appendChild(holder);
  return new Promise((resolve, reject) => {
    let widget;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("bot-check-timeout")), 120000);
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (widget != null) turnstile.remove(widget);
      holder.remove();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }
    try {
      widget = turnstile.render(holder, {
        sitekey: SITEKEY,
        action: "signup",
        appearance: "interaction-only",
        execution: "execute",
        callback: (token) => finish(token),
        "error-callback": () => finish(new Error("bot-check")),
        "expired-callback": () => finish(new Error("bot-check-expired")),
        "timeout-callback": () => finish(new Error("bot-check-timeout")),
      });
      turnstile.execute(widget);
    } catch {
      finish(new Error("bot-check-unavailable"));
    }
  });
}
