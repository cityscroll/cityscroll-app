/** In-document navigation for canonical official profile routes. */

export const OFFICIAL_PROFILE_SECTION_IDS = Object.freeze([
  "official-lobby",
  "official-cfb",
  "official-skim",
]);

const SECTION_IDS = new Set(OFFICIAL_PROFILE_SECTION_IDS);

function officialId(value) {
  const id = String(value ?? "").replace(/^official:/, "").trim();
  return /^\d+$/.test(id) ? id : "";
}

export function officialProfileSectionHref(value, sectionId) {
  const id = officialId(value);
  const section = String(sectionId ?? "").replace(/^#/, "").trim();
  return id && SECTION_IDS.has(section)
    ? `/officials/${encodeURIComponent(id)}/#${section}`
    : "";
}

export function officialProfileSectionRoute(locationLike = globalThis.location) {
  const pathname = String(locationLike?.pathname || "");
  const match = pathname.match(/^\/officials\/(\d+)\/?$/);
  const sectionId = String(locationLike?.hash || "").replace(/^#/, "");
  if (!match || !SECTION_IDS.has(sectionId)) return null;
  return { officialId: match[1], sectionId };
}

/** Scroll and move the reading point without letting the SPA reinterpret the fragment. */
export function focusOfficialProfileSection(root, sectionId, {
  requestFrame = globalThis.requestAnimationFrame,
} = {}) {
  const section = String(sectionId ?? "").replace(/^#/, "").trim();
  if (!SECTION_IDS.has(section) || !root?.querySelector) return false;
  const target = root.querySelector(`#${section}`);
  if (!target) return false;
  const focus = () => {
    if (!target.isConnected) return;
    target.scrollIntoView?.({ block: "start" });
    if (target.getAttribute?.("tabindex") !== "-1") target.setAttribute?.("tabindex", "-1");
    target.focus?.({ preventScroll: true });
  };
  if (typeof requestFrame === "function") requestFrame(focus);
  else focus();
  return true;
}
