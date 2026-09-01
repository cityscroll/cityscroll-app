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
  // The rendered document decides whether its control is record search or a
  // walk; hydration keeps whichever contract the static document already states.
  const recordSearch = root.querySelector("[data-walk-search-form]")?.dataset.walkRecordSearch === "true";
  const title = root.querySelector("#walk-entry-heading")?.textContent || undefined;
  const description = root.querySelector("#walk-entry-heading + p")?.textContent || undefined;
  const actionLabel = root.querySelector("button")?.textContent || undefined;
  // On the Browse landing the walk lives inside a secondary disclosure, because
  // choosing a record family is the primary task. An arrival that already names
  // its traversal context is here for the walk, so its context opens with it.
  const disclosure = root.closest("details");
  root.outerHTML = renderWalkEntry({
    source,
    query,
    place,
    placeLabel: placeLabel(params),
    families,
    actionHref,
    actionLabel,
    recordSearch,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(actionLabel ? { actionLabel } : {}),
  });
  if (disclosure) disclosure.open = true;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate, { once: true });
else hydrate();
