// Microsoft Clarity loader — heatmaps and session interaction patterns.
// Dormant until a project id is configured. Never blocks page function if blocked/down.
//
// Config (either works; empty keeps Clarity off):
//   1. window.CROL_CLARITY_PROJECT_ID = "<id>"  (set before this script)
//   2. <meta name="crol-clarity-project-id" content="<id>">
//   3. Edit CONFIGURED_PROJECT_ID below after creating a project at clarity.microsoft.com
//
// Privacy posture:
//   - Skip entirely when the browser signals Do Not Track or Global Privacy Control
//   - Mask all form inputs/textareas/selects before load (email fields never plain-text)
//   - Operator must set project Masking mode to Strict in the Clarity dashboard
//   - Fail-soft: missing id, network errors, and ad-blockers leave the site fully usable
(function (root) {
  "use strict";

  // Operator: paste the Clarity project id between the quotes to enable. Leave empty for dormant.
  const CONFIGURED_PROJECT_ID = "xusuca7gsv";

  const TAG_ORIGIN = "https://www.clarity.ms/tag/";
  const META_NAME = "crol-clarity-project-id";

  function resolveProjectId(win, doc) {
    const fromWindow = win && typeof win.CROL_CLARITY_PROJECT_ID === "string"
      ? win.CROL_CLARITY_PROJECT_ID.trim()
      : "";
    if (fromWindow) return fromWindow;
    const configured = String(CONFIGURED_PROJECT_ID || "").trim();
    if (configured) return configured;
    try {
      const meta = doc && doc.querySelector && doc.querySelector(`meta[name="${META_NAME}"]`);
      return meta && meta.content ? String(meta.content).trim() : "";
    } catch {
      return "";
    }
  }

  function prefersNoTracking(nav) {
    if (!nav) return false;
    const dnt = nav.doNotTrack;
    if (dnt === "1" || dnt === "yes") return true;
    if (nav.msDoNotTrack === "1") return true;
    // Global Privacy Control (Sec-GPC / navigator.globalPrivacyControl)
    if (nav.globalPrivacyControl === true) return true;
    return false;
  }

  function shouldLoad({ projectId, navigator: nav }) {
    if (!projectId) return false;
    if (prefersNoTracking(nav)) return false;
    return true;
  }

  function applyInputMasking(doc) {
    if (!doc || !doc.querySelectorAll) return 0;
    let count = 0;
    try {
      const nodes = doc.querySelectorAll("input, textarea, select");
      for (const el of nodes) {
        if (el.getAttribute("data-clarity-mask") === "true") continue;
        el.setAttribute("data-clarity-mask", "true");
        count += 1;
      }
      // Belt-and-suspenders on known email capture fields
      for (const id of ["adest", "fbemail"]) {
        const el = doc.getElementById(id);
        if (el) el.setAttribute("data-clarity-mask", "true");
      }
    } catch {
      // Masking is best-effort; never break the page.
    }
    return count;
  }

  function injectClarityScript(doc, projectId) {
    if (!doc || !doc.createElement) return null;
    // Official Clarity bootstrap: queue calls until the tag arrives.
    const w = root;
    w.clarity = w.clarity || function () {
      (w.clarity.q = w.clarity.q || []).push(arguments);
    };
    const script = doc.createElement("script");
    script.async = true;
    script.src = TAG_ORIGIN + encodeURIComponent(projectId);
    script.setAttribute("data-crol-clarity", "1");
    // Failure-tolerant: onerror is a no-op; ad-blockers fail silently.
    script.onerror = function () { /* site remains fully functional */ };
    const anchor = doc.head || doc.documentElement || doc.body;
    if (!anchor) return null;
    anchor.appendChild(script);
    return script;
  }

  function boot(options) {
    const win = (options && options.window) || root;
    const doc = (options && options.document) || (win && win.document);
    const nav = (options && options.navigator) || (win && win.navigator);
    const projectId = resolveProjectId(win, doc);
    if (!shouldLoad({ projectId, navigator: nav })) {
      return { loaded: false, projectId: projectId || "", reason: !projectId ? "unconfigured" : "opt-out" };
    }
    applyInputMasking(doc);
    try {
      injectClarityScript(doc, projectId);
      return { loaded: true, projectId, reason: "ok" };
    } catch {
      return { loaded: false, projectId, reason: "error" };
    }
  }

  const api = Object.freeze({
    CONFIGURED_PROJECT_ID,
    META_NAME,
    TAG_ORIGIN,
    resolveProjectId,
    prefersNoTracking,
    shouldLoad,
    applyInputMasking,
    injectClarityScript,
    boot,
  });

  root.CROLClarity = api;

  // Auto-boot in the browser after the document is interactive enough for querySelector.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { boot(); }, { once: true });
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
