import {
  renderWalkEntry,
  walkEntryHref,
} from "../walk_entry.mjs";

function placeFromParams(params) {
  return {
    borough: params.get("boro") || "",
    community_district: params.get("cd") || "",
    council_district: params.get("council") || "",
    neighborhood: params.get("neighborhood") || "",
    location_scope: params.get("scope") || "",
  };
}

function placeLabel(params) {
  const place = placeFromParams(params);
  return [
    place.borough,
    place.community_district && `CD ${place.community_district}`,
    place.council_district && `Council ${place.council_district}`,
    place.neighborhood,
    place.location_scope,
  ].filter(Boolean).join(" · ");
}

function hydrate() {
  const root = document.querySelector("[data-walk-entry]");
  if (!root) return;
  const params = new URLSearchParams(location.search);
  const source = params.get("walk_source");
  if (!["search", "near_you", "object"].includes(source)) return;
  const query = params.get("walk_query") || "";
  const place = placeFromParams(params);
  const families = [...root.querySelectorAll("[data-walk-family]")].map((link) => {
    const lane = link.closest("[data-walk-family-state]");
    return {
      id: link.dataset.walkFamily,
      label: link.textContent,
      href: walkEntryHref(link.getAttribute("href"), { source, query, place }),
      status: lane?.dataset.walkFamilyState || "unknown",
      description: lane?.querySelector("h3 + p")?.textContent || "",
      count: null,
    };
  });
  const actionHref = source === "near_you" ? walkEntryHref(location.href, { source, query, place }) : "/browse/";
  const title = root.querySelector("#walk-entry-heading")?.textContent || undefined;
  const description = root.querySelector("#walk-entry-heading + p")?.textContent || undefined;
  const actionLabel = root.querySelector("button")?.textContent || undefined;
  root.outerHTML = renderWalkEntry({
    source,
    query,
    placeLabel: placeLabel(params),
    families,
    actionHref,
    actionLabel,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(actionLabel ? { actionLabel } : {}),
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate, { once: true });
else hydrate();
