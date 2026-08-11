/* Near-you map island: adopts server-rendered SVG, area links, counts, and lists.
   It never creates or clears the page root. Every interaction retains a link/form fallback. */

import {
  defaultViewBox,
  panViewBox,
  zoomViewBox,
} from "../map_exploration.mjs";
import { resolveDistricts } from "../council_district_lookup.mjs";

const root = document.querySelector("[data-near-you-root]");
const wired = new WeakSet();
let currentViewBox = null;

function status(message) {
  const node = root?.querySelector("[data-map-status]");
  if (node) node.textContent = message;
}

function copy(name, values = {}) {
  let value = root?.dataset[name] || "";
  for (const [key, replacement] of Object.entries(values)) {
    value = value.replaceAll(`{${key}}`, replacement);
  }
  return value;
}

function linkedPair(id) {
  if (!root || !id) return [];
  return [
    ...root.querySelectorAll(`[data-map-id="${CSS.escape(id)}"], [data-map-label="${CSS.escape(id)}"], [data-map-area="${CSS.escape(id)}"]`),
  ];
}

function setLinked(id, on) {
  for (const node of linkedPair(id)) node.classList.toggle("is-linked", on);
}

async function adoptDocument(href) {
  const response = await fetch(href, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`near-you-response-${response.status}`);
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  const incoming = next.querySelector("[data-near-you-root]");
  if (!incoming) throw new Error("near-you-document-root-missing");
  for (const selector of [
    ".near-hero",
    ".near-place-guide",
    ".near-form",
    ".near-coverage",
    ".near-surface-switch",
    ".near-map-section",
    ".near-results",
    ".near-bags",
  ]) {
    const current = root.querySelector(selector);
    const replacement = incoming.querySelector(selector);
    if (current && replacement) current.replaceWith(document.importNode(replacement, true));
    else if (current && !replacement) current.remove();
    else if (!current && replacement) root.append(document.importNode(replacement, true));
  }
  root.dataset.lens = incoming.dataset.lens || root.dataset.lens;
  root.dataset.level = incoming.dataset.level || root.dataset.level;
  const title = next.querySelector("title")?.textContent;
  if (title) document.title = title;
  history.pushState({ nearYou: true }, "", href);
  wireIsland();
  root.querySelector("#near-results-heading")?.focus?.({ preventScroll: true });
}

async function followWithinIsland(event, href) {
  if (!href || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  status(copy("messageUpdating"));
  try {
    await adoptDocument(href);
    status(copy("messageUpdated"));
  } catch {
    location.assign(href);
  }
}

function wireMapAndList() {
  const svg = root.querySelector("#nearMapSvg");
  if (!svg) return;
  svg.setAttribute("role", "group");
  currentViewBox = svg.getAttribute("viewBox") || defaultViewBox();
  for (const path of root.querySelectorAll("[data-map-id]")) {
    if (wired.has(path)) continue;
    wired.add(path);
    const id = path.dataset.mapId;
    const href = path.dataset.mapHref;
    path.setAttribute("role", "link");
    path.tabIndex = 0;
    path.addEventListener("mouseenter", () => setLinked(id, true));
    path.addEventListener("mouseleave", () => setLinked(id, false));
    path.addEventListener("focus", () => setLinked(id, true));
    path.addEventListener("blur", () => setLinked(id, false));
    path.addEventListener("click", (event) => followWithinIsland(event, href));
    path.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      followWithinIsland(event, href);
    });
  }
  for (const link of root.querySelectorAll("[data-map-area]")) {
    if (wired.has(link)) continue;
    wired.add(link);
    const id = link.dataset.mapArea;
    link.addEventListener("mouseenter", () => setLinked(id, true));
    link.addEventListener("mouseleave", () => setLinked(id, false));
    link.addEventListener("focus", () => setLinked(id, true));
    link.addEventListener("blur", () => setLinked(id, false));
    link.addEventListener("click", (event) => followWithinIsland(event, link.href));
  }
}

function wirePanZoom() {
  const svg = root.querySelector("#nearMapSvg");
  if (!svg) return;
  for (const button of root.querySelectorAll("[data-map-zoom],[data-map-pan]")) {
    if (wired.has(button)) continue;
    wired.add(button);
    button.addEventListener("click", () => {
      if (button.dataset.mapZoom === "in") currentViewBox = zoomViewBox(currentViewBox, 0.7);
      else if (button.dataset.mapZoom === "out") currentViewBox = zoomViewBox(currentViewBox, 1.35);
      else if (button.dataset.mapZoom === "reset") currentViewBox = defaultViewBox();
      else if (button.dataset.mapPan === "west") currentViewBox = panViewBox(currentViewBox, -0.18, 0);
      else if (button.dataset.mapPan === "east") currentViewBox = panViewBox(currentViewBox, 0.18, 0);
      else if (button.dataset.mapPan === "north") currentViewBox = panViewBox(currentViewBox, 0, -0.18);
      else if (button.dataset.mapPan === "south") currentViewBox = panViewBox(currentViewBox, 0, 0.18);
      svg.setAttribute("viewBox", currentViewBox);
    });
  }
}

function boroughFromCommunity(id) {
  return ({ M: "Manhattan", X: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island" })[String(id || "")[0]] || null;
}

function wireGeolocation() {
  const button = root.querySelector("[data-use-location]");
  if (!button || wired.has(button)) return;
  wired.add(button);
  button.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status(copy("messageLocationUnavailable"));
      return;
    }
    button.disabled = true;
    status(copy("messageLocationFinding"));
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const response = await fetch(new URL("../data/district_boundaries.json", import.meta.url));
        const layer = response.ok ? await response.json() : null;
        const found = resolveDistricts(coords.latitude, coords.longitude, layer);
        const preferred = root.dataset.level === "council_district"
          ? found.council_district
          : found.community_district;
        const fallback = boroughFromCommunity(found.community_district);
        let link = preferred
          ? root.querySelector(`[data-map-area="${CSS.escape(preferred)}"]`)
          : null;
        if (!link && fallback) {
          const boroughLink = root.querySelector(`[data-map-area="${CSS.escape(fallback)}"]`);
          if (boroughLink && preferred) {
            await adoptDocument(boroughLink.href);
            link = root.querySelector(`[data-map-area="${CSS.escape(preferred)}"]`);
          } else {
            link = boroughLink;
          }
        }
        if (!link) throw new Error("district-missing");
        await adoptDocument(link.href);
        status(copy("messageLocationMatched", { district: preferred || fallback }));
      } catch {
        status(copy("messageLocationUnmatched"));
      } finally {
        button.disabled = false;
      }
    }, () => {
      button.disabled = false;
      status(copy("messageLocationDenied"));
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });
}

function wireForms() {
  for (const form of root.querySelectorAll("form[method='get']")) {
    if (wired.has(form)) continue;
    wired.add(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const url = new URL(form.action, location.href);
      url.search = new URLSearchParams(new FormData(form)).toString();
      try {
        await adoptDocument(url.toString());
        status(copy("messageUpdated"));
      } catch {
        location.assign(url.toString());
      }
    });
  }
}

/** Mobile list-first: Records / Map switch keeps count≡list while map stays optional. */
function wireSurfaceSwitch() {
  const nav = root.querySelector("[data-near-surface-switch]");
  if (!nav || wired.has(nav)) return;
  wired.add(nav);
  if (!root.dataset.nearMobileSurface) root.dataset.nearMobileSurface = "list";
  nav.querySelectorAll("[data-near-surface]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const surface = link.dataset.nearSurface;
      if (surface !== "list" && surface !== "map") return;
      // Only intercept on the mobile switch layout; desktop keeps dual overview.
      if (!window.matchMedia || !window.matchMedia("(max-width: 560px)").matches) return;
      event.preventDefault();
      root.dataset.nearMobileSurface = surface;
      nav.querySelectorAll("[data-near-surface]").forEach((node) => {
        node.classList.toggle("is-active", node === link);
        if (node === link) node.setAttribute("aria-current", "true");
        else node.removeAttribute("aria-current");
      });
      const target = root.querySelector(
        surface === "map" ? "#near-map-heading" : "#near-results-heading",
      );
      target?.focus?.({ preventScroll: true });
    });
  });
}

function wireIsland() {
  if (!root) return;
  root.dataset.enhanced = "true";
  for (const control of root.querySelectorAll(".js-only")) control.hidden = false;
  wireMapAndList();
  wirePanZoom();
  wireGeolocation();
  wireForms();
  wireSurfaceSwitch();
}

if (root) {
  wireIsland();
  addEventListener("popstate", () => location.reload());
}

export { wireIsland as initNearYouMapIsland };
