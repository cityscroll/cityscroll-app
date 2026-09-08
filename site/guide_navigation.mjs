/** Preserve the selected product language on ordinary guide navigation. */
import { SELECTABLE_LANGS } from "./route_migration.mjs";

export function guidePathLocale(pathname) {
  const candidate = String(pathname).split("/")[2];
  return SELECTABLE_LANGS.includes(candidate) ? candidate : null;
}

/** Locale is part of the static guide route; product scope stays in its query. */
export function guideDocumentHref(href, language = "en") {
  if (!SELECTABLE_LANGS.includes(language)) throw new TypeError("Unsupported guide language");
  const target = new URL(href, "https://cityscroll.org");
  if (target.origin !== "https://cityscroll.org" || !target.pathname.startsWith("/guide/")) return href;
  const current = guidePathLocale(target.pathname);
  const rest = current ? target.pathname.slice(`/guide/${current}/`.length) : target.pathname.slice(7);
  target.pathname = language === "en" ? `/guide/${rest}` : `/guide/${language}/${rest}`;
  target.searchParams.delete("lang");
  return `${target.pathname}${target.search}${target.hash}`;
}

/** Resolve URL locale before storage; usable by Pages without browser state. */
export function guideLocaleRedirect(current, savedLanguage = "en") {
  const url = new URL(current);
  if (!url.pathname.startsWith("/guide/")) return null;
  const explicit = url.searchParams.get("lang");
  const pathLanguage = guidePathLocale(url.pathname);
  const selected = SELECTABLE_LANGS.includes(explicit) ? explicit : pathLanguage || savedLanguage;
  if (!SELECTABLE_LANGS.includes(selected)) return null;
  const next = new URL(guideDocumentHref(url.pathname + url.search + url.hash, selected), url);
  // An explicit English choice must override the saved preference after navigation.
  if (selected === "en" && explicit === "en") next.searchParams.set("lang", "en");
  return next.pathname === url.pathname && next.search === url.search ? null : next.pathname + next.search + next.hash;
}

export function guideNavigationHref(href, current, savedLanguage = "en") {
  const base = new URL(current);
  const explicit = base.searchParams.get("lang");
  const language = SELECTABLE_LANGS.includes(explicit) ? explicit
    : guidePathLocale(base.pathname) || (SELECTABLE_LANGS.includes(savedLanguage) ? savedLanguage : "en");
  const target = new URL(href, base);
  if (target.origin !== base.origin || !href.startsWith("/") || href.startsWith("//")
      || target.pathname.startsWith("/media/")) return href;
  if (target.pathname.startsWith("/guide/")) {
    const translated = guideDocumentHref(href, language);
    if (language === "en" && explicit === "en") {
      const english = new URL(translated, base);
      english.searchParams.set("lang", "en");
      return english.pathname + english.search + english.hash;
    }
    return translated;
  }
  if (language === "en" && explicit !== "en") return href;
  // Carry only language. Authored query, date, evidence and trail scope stays intact;
  // unknown parameters and credentials on the guide URL never reach product links.
  target.searchParams.set("lang", language);
  return `${target.pathname}${target.search}${target.hash}`;
}

if (typeof document !== "undefined") {
  let savedLanguage = "en";
  try { savedLanguage = localStorage.getItem("crol_lang") || "en"; } catch {}
  const redirect = guideLocaleRedirect(location.href, savedLanguage);
  if (redirect) location.replace(redirect);
  document.addEventListener("click", event => {
    const choice = event.target.closest?.("a[data-guide-language]");
    if (choice) { try { localStorage.setItem("crol_lang", choice.dataset.guideLanguage); } catch {} }
  });
  const authored = new WeakMap();
  const update = () => {
    let saved = "en";
    try { saved = localStorage.getItem("crol_lang") || "en"; } catch { /* Private browsing. */ }
    for (const link of document.querySelectorAll('a[href^="/"]:not([data-guide-language])')) {
      if (!authored.has(link)) authored.set(link, link.getAttribute("href"));
      link.setAttribute("href", guideNavigationHref(authored.get(link), location.href, saved));
    }
  };
  update();
  // Let the browser own navigation, modified clicks and Back/scroll restoration.
  addEventListener("pageshow", update);
}
