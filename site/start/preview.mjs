const preference = "cityscroll_start_preview=";
const startPage = document.body.hasAttribute("data-start-page");
const toggle = document.querySelector("#start-toggle");
const toggleHelp = document.querySelector("#start-toggle-help");

function previewPreference() {
  return document.cookie.split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(preference))
    ?.slice(preference.length);
}

function setPreview(enabled) {
  const security = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${preference}${enabled ? "1" : "0"}; Path=/; SameSite=Lax${security}`;
}

function loadPreviewStyles() {
  if (document.querySelector('link[href="/start/preview.css"]')) return;
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/start/preview.css";
  document.head.append(styles);
}

function renderNavigation() {
  document.querySelector("#cityscroll-start-nav")?.remove();
  if (previewPreference() !== "1") return;
  loadPreviewStyles();
  const nav = document.createElement("nav");
  nav.id = "cityscroll-start-nav";
  nav.setAttribute("aria-label", "CityScroll preview");
  const current = location.pathname.replace(/\/$/, "");
  for (const [href, label] of [
    ["/start/", "CityScroll preview"], ["/wincitywork/", "WinCityWork"], ["/browse/", "Browse records"],
    ["/about", "About"], ["/start/#feedback", "Give feedback"],
  ]) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (current === href.replace(/\/$/, "")) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  const exit = document.createElement("button");
  exit.type = "button";
  exit.textContent = "Exit preview";
  exit.addEventListener("click", () => {
    setPreview(false);
    if (startPage) location.assign("/");
    else location.reload();
  });
  nav.append(exit);
  document.body.prepend(nav);
}

function syncPreview() {
  renderNavigation();
  if (toggle) {
    const choice = previewPreference();
    toggle.checked = choice === "1";
    toggleHelp.textContent = choice === undefined
      ? "Allow browser cookies to keep the preview navigation as you move between pages."
      : `Preview navigation is ${toggle.checked ? "on" : "off"} in this browser.`;
  }
}

if (startPage && previewPreference() === undefined) setPreview(true);

if (startPage || previewPreference() === "1") {
  syncPreview();
  window.addEventListener("pageshow", event => {
    if (event.persisted) syncPreview();
  });
}

if (toggle) {
  toggle.addEventListener("change", () => {
    setPreview(toggle.checked);
    syncPreview();
  });
}

const form = document.querySelector("#start-feedback");
if (form) {
  const topic = document.querySelector("#start-topic");
  const prompt = document.querySelector("#start-prompt");
  const message = document.querySelector("#start-message");
  const email = document.querySelector("#start-email");
  const status = document.querySelector("#start-feedback-status");
  const send = form.querySelector("button");
  const prompts = {
    "Civil service exams": "Tell us about the last exam you tried to find or prepare for.",
    "Community boards": "Tell us about a recent request you tried to route or follow up on.",
    "Homepage preview": "What were you trying to do, and where did you get stuck?",
  };
  topic.addEventListener("change", () => { prompt.textContent = prompts[topic.value]; });
  for (const link of document.querySelectorAll("[data-start-topic]")) {
    link.addEventListener("click", () => {
      topic.value = link.dataset.startTopic;
      prompt.textContent = prompts[topic.value];
      requestAnimationFrame(() => message.focus({ preventScroll: true }));
    });
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const note = message.value.trim();
    if (!note) {
      status.textContent = "Write a short message first.";
      message.focus();
      return;
    }
    topic.disabled = message.disabled = email.disabled = send.disabled = true;
    status.textContent = "Sending feedback…";
    try {
      const response = await fetch("https://api.cityscroll.org/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "general", message: `[${topic.value}] ${note}`, email: email.value.trim() }),
      });
      if (!response.ok || !(await response.json()).ok) throw new Error("Feedback delivery failed");
      message.value = "";
      email.value = "";
      status.textContent = "Thanks. Your feedback was sent to CityScroll.";
    } catch {
      status.textContent = "We couldn’t confirm delivery. Your message is still here. Try again or use the feedback options on About.";
    } finally {
      topic.disabled = message.disabled = email.disabled = send.disabled = false;
    }
  });
  send.disabled = false;
}
