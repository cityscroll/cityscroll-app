import { renderCivicDocumentMast } from "./civic_document_chrome.mjs";

export const NOTICE_ROUTE_CLASS = "notice-route";

/**
 * The notice route is a composed document: compact document chrome owns the
 * entry, while the legacy homepage shell remains available to its bindings.
 */
export function renderNoticeRouteChrome({ siteBase = "" } = {}) {
  return `${renderCivicDocumentMast({ current: "browse", siteBase, surfaceClass: "notice-document-mast" })}
    <div class="notice-language-slot" data-notice-language-slot="1"></div>`;
}

export function applyNoticeRouteState(active) {
  if (typeof document === "undefined") return;
  const isActive = Boolean(active);
  document.body?.classList.toggle(NOTICE_ROUTE_CLASS, isActive);
  const chrome = document.querySelector("#notice-route-chrome");
  if (!chrome) return;
  if (!chrome.dataset.noticeChromeReady) {
    chrome.innerHTML = renderNoticeRouteChrome();
    chrome.dataset.noticeChromeReady = "true";
  }
  chrome.hidden = !isActive;
  const slot = chrome.querySelector("[data-notice-language-slot]");
  const language = document.querySelector("#langSwitcher");
  if (slot && language && isActive && language.parentElement !== slot) slot.append(language);
  if (slot && language && !isActive && language.parentElement === slot) {
    document.querySelector(".masthead .wrap")?.append(language);
  }
}
