import { migrateLegacyUrl } from "./route_migration.mjs";

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
