const root = document.querySelector("[data-following-root]");
const msg = (name) => root?.dataset[name] || "";

function canonical(value) {
  if (Array.isArray(value)) {
    const rows = value.map(canonical).filter((item) => item !== undefined);
    return rows.length ? rows : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || value === undefined || value === false || value === "") return undefined;
  return value;
}

function watchKey(lens, filter) {
  return JSON.stringify({ lens, filter: canonical(filter || {}) });
}

function currentWatch() {
  const form = root?.querySelector("[data-following-subscribe-form]");
  if (!form) return null;
  try {
    return { lens: form.elements.lens.value, filter: JSON.parse(form.elements.filter.value || "{}") };
  } catch { return null; }
}

function duplicateWarning() {
  const watch = currentWatch();
  const host = root?.querySelector("[data-following-subscribe-panel]");
  if (!watch || !host) return;
  host.querySelector("[data-duplicate-warning]")?.remove();
  const key = watchKey(watch.lens, watch.filter);
  const duplicate = [...root.querySelectorAll("[data-watch-lens][data-watch-filter]")].some((row) => {
    try { return watchKey(row.dataset.watchLens, JSON.parse(row.dataset.watchFilter || "{}")) === key; }
    catch { return false; }
  });
  if (!duplicate) return;
  const note = document.createElement("p");
  note.className = "following-warning";
  note.dataset.duplicateWarning = "true";
  note.setAttribute("role", "alert");
  note.textContent = msg("msgDuplicate");
  host.prepend(note);
}

async function loadPersonal() {
  const host = root?.querySelector("[data-personal-watch-list]");
  if (!host) return;
  try {
    const response = await fetch(root.dataset.personalUrl, { credentials: "include", headers: { Accept: "text/html" } });
    if (!response.ok) return;
    host.innerHTML = await response.text();
    duplicateWarning();
  } catch { /* public page and management link remain complete */ }
}

function adoptFollowingDocument(html) {
  const next = new DOMParser().parseFromString(html, "text/html");
  for (const selector of [
    "[data-following-scope-panel]",
    "[data-following-preview-panel]",
    "[data-following-subscribe-panel]",
  ]) {
    const current = root.querySelector(selector);
    const replacement = next.querySelector(selector);
    if (current && replacement) current.replaceWith(replacement);
  }
  wireSubscribe();
  duplicateWarning();
}

async function preview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("[data-following-preview-status]");
  if (status) status.textContent = msg("msgPreviewLoading");
  try {
    const url = new URL(form.action);
    url.search = new URLSearchParams(new FormData(form)).toString();
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error("preview");
    adoptFollowingDocument(await response.text());
    if (status) status.textContent = msg("msgPreviewReady");
  } catch {
    if (status) status.textContent = msg("msgPreviewError");
  }
}

function wireSubscribe() {
  const form = root?.querySelector("[data-following-subscribe-form]");
  if (!form || form.dataset.enhanced === "true") return;
  form.dataset.enhanced = "true";
  form.addEventListener("submit", async (event) => {
    const warning = form.closest("[data-following-subscribe-panel]")?.querySelector("[data-duplicate-warning]");
    if (warning) {
      event.preventDefault();
      warning.focus?.();
      return;
    }
    if (!form.reportValidity()) return;
    event.preventDefault();
    const status = form.querySelector("[data-following-submit-status]");
    const button = form.querySelector("button" + "[type=submit]");
    if (status) status.textContent = msg("msgSubmitLoading");
    if (button) button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      body.filter = JSON.parse(body.filter || "{}");
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.reason || "subscribe");
      if (status) status.textContent = msg("msgSubmitReady");
      form.elements.email.value = "";
    } catch {
      if (status) status.textContent = msg("msgSubmitError");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

if (root) {
  root.querySelector("[data-following-preview-form]")?.addEventListener("submit", preview);
  wireSubscribe();
  loadPersonal();
}
