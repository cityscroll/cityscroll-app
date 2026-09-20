/** Build a matter permalink without carrying unrelated route state. */
export function matterPermalink(pin, locationValue = globalThis.location, languageURL = globalThis.currentLanguageURL) {
  const origin = String(locationValue?.origin || "").replace(/\/$/, "");
  const pathname = String(locationValue?.pathname || "/");
  const searchParams = new URLSearchParams(String(locationValue?.search || ""));
  const language = searchParams.get("lang");
  const search = language ? `?lang=${encodeURIComponent(language)}` : "";
  const raw = `${origin}${pathname}${search}#matter/${encodeURIComponent(pin)}`;
  return typeof languageURL === "function" ? languageURL(raw) : raw;
}
