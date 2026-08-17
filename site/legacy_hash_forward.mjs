import { migrateLegacyUrl } from "./route_migration.mjs";
import { EXAMS_SURFACE } from "./browse_surface_contracts.mjs";

if (globalThis.location?.search || globalThis.location?.hash?.includes("?")) {
  import("./app/place-context.mjs");
}
if (globalThis.location?.hash || globalThis.location?.pathname?.startsWith("/browse/")) import("./app/traversal.mjs");

export function legacyForwardTarget(value) {
  const mapped = migrateLegacyUrl(value);
  return mapped.migrated ? mapped.target : null;
}

export function forwardLegacyFragment(locationObject = globalThis.location) {
  if (!locationObject?.hash) return false;
  // The Exams document owns its public URL, including selected exam deep links.
  // Keep this document-local exception ahead of the legacy root shim; other paths
  // retain the historical #exam/<id> → /exams/<id>/ forwarding behavior.
  if (String(locationObject.pathname || "").replace(/\/+$/, "") === EXAMS_SURFACE.route.replace(/\/+$/, "")
      && /^#exam\/\d{4}$/.test(locationObject.hash)) return false;
  const target = legacyForwardTarget(locationObject.href);
  if (!target) return false;
  const current = `${locationObject.pathname}${locationObject.search}${locationObject.hash}`;
  if (target === current) return false;
  locationObject.replace(target);
  return true;
}

if (typeof window !== "undefined") {
  forwardLegacyFragment(window.location);
  window.addEventListener("hashchange", () => forwardLegacyFragment(window.location));
}
