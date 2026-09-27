import { migrateLegacyUrl } from "./route_migration.mjs";
import { matchSpaHashRoute } from "./spa_hash_routes.mjs";

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
  // Legacy fragments are translated once at the root ingress. Canonical
  // documents own their own fragments and never re-enter the compatibility
  // runtime.
  const pathname = String(locationObject.pathname || "").replace(/\/+$/, "") || "/";
  if (pathname !== "/" && pathname !== "/index.html") return false;
  const target = legacyForwardTarget(locationObject.href);
  const current = `${locationObject.pathname}${locationObject.search}${locationObject.hash}`;
  if (target && target !== current) {
    locationObject.replace(target);
    return true;
  }
  // The Near You document is now served at `/`, but retained item and workspace
  // hashes still belong to the topic SPA. Send only registered hashes to its
  // explicit document; an unknown fragment remains on Near You.
  if (globalThis.CROL_DISABLE_ROOT_HASH_BOOT || !matchSpaHashRoute(locationObject.hash)) return false;
  const spaTarget = `/index.html${locationObject.search || ""}${locationObject.hash}`;
  if (spaTarget === current) return false;
  locationObject.replace(spaTarget);
  return true;
}

if (typeof window !== "undefined") {
  forwardLegacyFragment(window.location);
  window.addEventListener("hashchange", () => forwardLegacyFragment(window.location));
}
