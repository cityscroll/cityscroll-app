import { migrateLegacyUrl } from "./route_migration.mjs";
import { browseRouteAlias } from "./browse_route_aliases.mjs";

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
  // Keep this alias-local exception ahead of the legacy root shim; other paths
  // retain the historical #exam/<id> → /exams/<id>/ forwarding behavior.
  if (browseRouteAlias(locationObject.pathname)
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
