// Lightweight, public feature flags for small and expiring UI experiments.
// This is a presentation switch, not an authorization or access-control layer.
(function (root) {
  "use strict";

  const STORAGE_KEY = "crol_beta_flag_v1";

  function activeFlag(flags, slug, today) {
    return (flags || []).find((flag) =>
      flag.slug === slug
      && flag.default_off === true
      && flag.removal_date >= today
    ) || null;
  }

  function resolveFlag({ search = "", stored = "", flags = [], today }) {
    const params = new URLSearchParams(search);
    if (params.has("beta")) {
      const requested = params.get("beta") || "";
      if (requested === "0") return { slug: null, storage: "clear" };
      const flag = activeFlag(flags, requested, today);
      return flag
        ? { slug: flag.slug, storage: "persist" }
        : { slug: null, storage: "clear" };
    }
    const flag = activeFlag(flags, stored, today);
    return flag
      ? { slug: flag.slug, storage: "keep" }
      : { slug: null, storage: stored ? "clear" : "keep" };
  }

  function syncStorage(storage, resolution) {
    try {
      if (resolution.storage === "persist") storage.setItem(STORAGE_KEY, resolution.slug);
      if (resolution.storage === "clear") storage.removeItem(STORAGE_KEY);
    } catch {
      // Private or restricted storage leaves the experiment session-only.
    }
  }

  function clearUrl(location) {
    const url = new URL(location.href);
    url.searchParams.set("beta", "0");
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function showBanner(document, location, slug) {
    if (document.querySelector("[data-beta-flag-banner]")) return;
    const banner = document.createElement("aside");
    banner.dataset.betaFlagBanner = slug;
    banner.setAttribute("role", "status");
    banner.setAttribute("lang", "en");
    banner.style.cssText = [
      "background:#6b4e16",
      "color:#fff",
      "padding:8px 18px",
      "text-align:center",
      "font:600 14px/1.45 ui-sans-serif,system-ui,sans-serif",
    ].join(";");
    const label = document.createElement("strong");
    label.textContent = `Experimental view: ${slug}`;
    const separator = document.createTextNode(" · ");
    const clear = document.createElement("a");
    clear.href = clearUrl(location);
    clear.textContent = "Return to the standard view";
    clear.style.cssText = "color:inherit;text-decoration:underline;text-underline-offset:2px";
    banner.append(label, separator, clear);
    document.body.prepend(banner);
  }

  async function boot() {
    let registry;
    try {
      const response = await fetch("beta-flags.json", { cache: "no-store" });
      if (!response.ok) return;
      registry = await response.json();
    } catch {
      return;
    }

    let stored = "";
    try {
      stored = localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      // Storage is optional.
    }
    const today = new Date().toISOString().slice(0, 10);
    const resolution = resolveFlag({
      search: location.search,
      stored,
      flags: registry.flags,
      today,
    });
    syncStorage(localStorage, resolution);
    root.CROL_BETA_FLAG = resolution.slug;
    if (resolution.slug) {
      document.documentElement.dataset.betaFlag = resolution.slug;
      showBanner(document, location, resolution.slug);
    }
    document.dispatchEvent(new CustomEvent("crol:beta-flag-ready", {
      detail: { slug: resolution.slug },
    }));
  }

  root.CROLBetaFlags = {
    STORAGE_KEY,
    activeFlag,
    resolveFlag,
    syncStorage,
    clearUrl,
    showBanner,
  };

  if (
    typeof window !== "undefined"
    && root === window
    && typeof document !== "undefined"
    && document.defaultView === root
  ) {
    void boot();
  }
})(globalThis);
