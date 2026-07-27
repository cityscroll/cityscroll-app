// First-party aggregate event collector. No cookies, visitor identifiers, raw search text,
// entity names, or notice ids. The Worker validates every value against the versioned taxonomy
// before writing it to Analytics Engine.
(function () {
  "use strict";

  const ENDPOINT = "https://api.crol-list.org/events";
  const DEV_TOKEN_STORAGE_KEY = "crol_analytics_dev_token_v1";
  const DEV_TOKEN_HEADER = "X-CROL-Analytics-Dev";
  const LENSES = new Set(["money", "people", "land", "property", "rules", "meetings", "alerts"]);
  const AREAS = new Map([
    ["manhattan", "manhattan"], ["brooklyn", "brooklyn"], ["queens", "queens"],
    ["bronx", "bronx"], ["staten island", "staten-island"],
  ]);

  function surface() {
    const page = location.pathname.split("/").pop() || "index.html";
    return ({
      "index.html": "home", "stats.html": "stats", "about.html": "about",
      "data.html": "data", "api.html": "api", "changelog.html": "changelog",
      "standards.html": "standards",
    })[page] || "home";
  }

  function currentLens(node) {
    const tab = node && node.closest && node.closest(".tabpane");
    const fromPane = tab && tab.id.replace(/^tab-/, "");
    if (LENSES.has(fromPane)) return fromPane;
    const active = document.querySelector(".tabbtn.active");
    return LENSES.has(active?.dataset?.tab) ? active.dataset.tab : "money";
  }

  function currentArea() {
    const value = document.querySelector("#lboro")?.value?.trim().toLowerCase();
    return AREAS.get(value) || undefined;
  }

  function record(event, dimensions) {
    const payload = JSON.stringify({ event, ...dimensions });
    try {
      // The browser treats an optional short-lived developer token as opaque. Only the Worker
      // can validate it; absent, expired, or forged values follow the normal counting path.
      let developerToken = "";
      try {
        developerToken = localStorage.getItem(DEV_TOKEN_STORAGE_KEY) || "";
      } catch {
        // Storage can be unavailable; analytics still follows the normal counting path.
      }
      if (!developerToken && navigator.sendBeacon) {
        const body = new Blob([payload], { type: "text/plain;charset=UTF-8" });
        if (navigator.sendBeacon(ENDPOINT, body)) return;
      }
      const headers = { "Content-Type": "text/plain;charset=UTF-8" };
      if (developerToken) headers[DEV_TOKEN_HEADER] = developerToken;
      void fetch(ENDPOINT, {
        method: "POST",
        body: payload,
        keepalive: true,
        headers,
      }).catch(() => {});
    } catch {
      // Analytics is always fail-soft.
    }
  }

  function recordDeepLink() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const first = hash.split(/[/?]/, 1)[0];
    const lensSearch = LENSES.has(first) && hash.includes("?");
    const kind = lensSearch ? "search"
      : ["notice", "agency", "vendor", "search", "investigation"].includes(first) ? first : null;
    if (!kind) return;
    const lens = lensSearch ? first : currentLens(document.body);
    record("deep_link_open", { detail: kind, lens, surface: "home" });
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button,a");
    if (!target) return;
    const lens = target.dataset.tab && LENSES.has(target.dataset.tab)
      ? target.dataset.tab : currentLens(target);

    if (target.matches(".tabbtn[data-tab]")) {
      record("lens_open", { lens, surface: "home" });
      return;
    }
    if (target.matches(".trychip")) {
      record("search_run", { lens, detail: "preset", geography: currentArea(), surface: "home" });
      return;
    }
    if (target.matches("#apreview,#asubscribe,#landalert,.watchbtn")) {
      record("alert_start", {
        lens,
        detail: target.id === "apreview" ? "preview" : "subscribe",
        surface: "home",
      });
      return;
    }
    if (target.matches("#invshare")) {
      record("investigation_share", { detail: "create", surface: "home" });
      return;
    }

    const id = target.id || "";
    const explicitFormat = target.dataset.exportFormat;
    const format = explicitFormat
      || (/xlsx/i.test(id) ? "xlsx" : /csv|^export$/i.test(id) ? "csv"
        : /print/i.test(id) ? "print" : /ics/i.test(id) ? "ics"
          : /json/i.test(id) && /export|inv/i.test(id) ? "json" : null);
    if (format) record("export", { lens, detail: format, surface: "home" });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches("input[type='text'],input[type='search']")) return;
    if (/^nlq/.test(event.target.id)) return; // successful model-backed searches are counted by the Worker.
    record("search_run", {
      lens: currentLens(event.target), detail: "filters", geography: currentArea(), surface: "home",
    });
  });

  document.addEventListener("change", (event) => {
    if (event.target.id !== "lboro" || !event.target.value) return;
    record("search_run", {
      lens: "land", detail: "filters", geography: currentArea(), surface: "home",
    });
  });

  window.crolAnalytics = Object.freeze({ record });
  record("page_view", { surface: surface() });
  recordDeepLink();
  window.addEventListener("hashchange", recordDeepLink);
})();
