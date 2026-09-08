/** Preserve the selected product language on ordinary guide navigation. */
import { SELECTABLE_LANGS } from "./route_migration.mjs";

export function guideNavigationHref(href, current, savedLanguage = "en") {
  const base = new URL(current);
  const explicit = base.searchParams.get("lang");
  const language = SELECTABLE_LANGS.includes(explicit) ? explicit
    : SELECTABLE_LANGS.includes(savedLanguage) ? savedLanguage : "en";
  const target = new URL(href, base);
  if (target.origin !== base.origin || !href.startsWith("/") || href.startsWith("//")
      || target.pathname.startsWith("/media/")) return href;
  if (language === "en" && explicit !== "en") return href;
  // Carry only language. Authored query, date, evidence and trail scope stays intact;
  // unknown parameters and credentials on the guide URL never reach product links.
  target.searchParams.set("lang", language);
  return `${target.pathname}${target.search}${target.hash}`;
}

if (typeof document !== "undefined") {
  let saved = "en";
  try { saved = localStorage.getItem("crol_lang") || "en"; } catch { /* Private browsing. */ }
  const update = () => {
    for (const link of document.querySelectorAll('a[href^="/"]')) {
      link.setAttribute("href", guideNavigationHref(link.getAttribute("href"), location.href, saved));
    }
  };
  update();
  // Let the browser own navigation, modified clicks and Back/scroll restoration.
  addEventListener("pageshow", update);
}
