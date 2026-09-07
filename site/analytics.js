// First-party aggregate event collector. No cookies, visitor identifiers, raw search text,
// entity names, or notice ids. The Worker validates every value against the versioned taxonomy
// before writing it to Analytics Engine.
//
// The surface an event names comes from site/analytics_surface_taxonomy.mjs, which resolves a
// pathname against the registered route map. This file no longer guesses one from the last path
// segment and no longer answers "home" when it recognises nothing: a route the map does not
// register produces no event at all, because an unattributed page view is a gap and a
// misattributed one is a false measurement. The Worker builds its own allowlists from the same
// module, so the two halves cannot drift apart.
import { resolveAnalyticsSurface } from "./analytics_surface_taxonomy.mjs";

(function () {
  "use strict";

  const API = window.CROL_API_ORIGIN || "https://api.cityscroll.org";
  const API_FALLBACK = window.CROL_API_FALLBACK_ORIGIN || "https://cityscroll-worker.crol-worker.workers.dev";
  const ENDPOINT = `${API}/events`;
  const DEV_TOKEN_STORAGE_KEY = "crol_analytics_dev_token_v1";
  const DEV_TOKEN_HEADER = "X-CROL-Analytics-Dev";
  const LENSES = new Set(["money", "people", "land", "property", "rules", "meetings", "alerts"]);
  const AREAS = new Map([
    ["manhattan", "manhattan"], ["brooklyn", "brooklyn"], ["queens", "queens"],
    ["bronx", "bronx"], ["staten island", "staten-island"],
  ]);

  // The one surface this document is allowed to name, resolved once. `null` means the route
  // is not registered, and every record() call below then declines to send rather than
  // attributing the reader's activity to a page they are not on.
  const PAGE_SURFACE = resolveAnalyticsSurface(location.pathname).surface;

  // A lens is a thing the reader chose. When nothing on the page establishes one there is no
  // lens to report, and `undefined` becomes the taxonomy's `none` — never "money", which used
  // to be handed out as a default and made an untyped search on any document look like a
  // spending search on the homepage.
  function currentLens(node) {
    const tab = node && node.closest && node.closest(".tabpane");
    const fromPane = tab && tab.id.replace(/^tab-/, "");
    if (LENSES.has(fromPane)) return fromPane;
    const active = document.querySelector(".tabbtn.active");
    return LENSES.has(active?.dataset?.tab) ? active.dataset.tab : undefined;
  }

  function currentArea() {
    const selected = document.querySelector(".tabpane.active [data-borough-scope-link][aria-current=\"page\"]");
    const value = selected?.dataset?.boroughScopeLink === "all"
      ? ""
      : selected?.textContent?.trim().toLowerCase();
    return AREAS.get(value) || undefined;
  }

  function record(event, dimensions) {
    // An event with no surface is not sent. The Worker would refuse it anyway; declining here
    // keeps an unregistered route from spending a request to be rejected, and keeps the
    // rejection counter meaning "a producer sent something the taxonomy does not allow".
    if (!dimensions || !dimensions.surface) return;
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
    record("deep_link_open", { detail: kind, lens, surface: PAGE_SURFACE });
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button,a");
    if (!target) return;
    const lens = target.dataset.tab && LENSES.has(target.dataset.tab)
      ? target.dataset.tab : currentLens(target);

    if (target.matches(".tabbtn[data-tab]")) {
      record("lens_open", { lens, surface: PAGE_SURFACE });
      return;
    }
    if (target.matches("[data-scenario][data-scenario-lens]")) {
      record("scenario_open", {
        lens: target.dataset.scenarioLens,
        detail: target.dataset.scenario,
        surface: PAGE_SURFACE,
      });
      return;
    }
    if (target.matches(".trychip")) {
      record("search_run", { lens, detail: "preset", geography: currentArea(), surface: PAGE_SURFACE });
      return;
    }
    if (target.matches("#apreview,#asubscribe,#landalert,.watchbtn")) {
      record("alert_start", {
        lens,
        detail: target.id === "apreview" ? "preview" : "subscribe",
        surface: PAGE_SURFACE,
      });
      return;
    }
    if (target.matches("#invshare")) {
      record("investigation_share", { detail: "create", surface: PAGE_SURFACE });
      return;
    }

    const id = target.id || "";
    const explicitFormat = target.dataset.exportFormat;
    const format = explicitFormat
      || (/xlsx/i.test(id) ? "xlsx" : /csv|^export$/i.test(id) ? "csv"
        : /print/i.test(id) ? "print" : /ics/i.test(id) ? "ics"
          : /json/i.test(id) && /export|inv/i.test(id) ? "json" : null);
    if (format) record("export", { lens, detail: format, surface: PAGE_SURFACE });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches("input[type='text'],input[type='search']")) return;
    if (/^nlq/.test(event.target.id)) return; // successful model-backed searches are counted by the Worker.
    record("search_run", {
      lens: currentLens(event.target), detail: "filters", geography: currentArea(), surface: PAGE_SURFACE,
    });
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("[data-borough-scope-link]");
    if (!link || link.dataset.boroughScopeLink === "all") return;
    record("search_run", {
      lens: "land", detail: "filters", geography: currentArea(), surface: PAGE_SURFACE,
    });
  });

  function scheduleProductionRum() {
    try {
      const host = location.hostname;
      if (host !== "cityscroll.org" && host !== "www.cityscroll.org" && host !== "cityscroll.pages.dev") {
        return;
      }
      const start = function startRum() {
        const idle = window.requestIdleCallback || function idleFallback(callback) {
          window.setTimeout(callback, 0);
        };
        idle(function loadRum() {
          import("/rum_bootstrap.mjs").then(function boot(mod) {
            if (typeof mod.scheduleProductionRumCollector === "function") {
              return mod.scheduleProductionRumCollector();
            }
            return null;
          }).catch(function () {});
        });
      };
      if (document.readyState === "complete") start();
      else window.addEventListener("load", start, { once: true });
    } catch {
      // RUM scheduling is observational and cannot become a page error.
    }
  }

  window.crolAnalytics = Object.freeze({ record });
  scheduleProductionRum();
  record("page_view", { surface: PAGE_SURFACE });
  document.querySelectorAll("[data-story-signal-card]").forEach(() => {
    record("comparative_signal_shown", { detail: "visible", surface: "worth-a-look" });
  });
  recordDeepLink();
  window.addEventListener("hashchange", recordDeepLink);
})();
