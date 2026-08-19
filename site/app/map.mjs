/* Near-you map island: adopts server-rendered SVG, area links, counts, and lists.
   It never creates or clears the page root. Every interaction retains a link/form fallback. */

import {
  MAP_LENSES,
  defaultViewBox,
  panViewBox,
  zoomViewBox,
} from "../map_exploration.mjs";
import { resolveDistricts } from "../council_district_lookup.mjs";
import { nearYouUrlFromMapHash } from "../near_you_scope_runtime.mjs";
import { runtimeRumSemanticMilestones } from "../rum_static_record_instrumentation.mjs";
import {
  nearYouFrameReady,
  nearYouMapReady,
} from "../rum_maps_entities_async_instrumentation.mjs";

const root = document.querySelector("[data-near-you-root]");
const NEAR_YOU_STRING_DATASETS = Object.freeze({
  all_boroughs: "translationAllBoroughs",
  borough_label: "translationBoroughLabel",
  context_strip_lbl: "translationContextStripLabel",
});

function installNearYouLocalization() {
  if (typeof globalThis.t !== "function") {
    globalThis.t = (key, values = {}) => {
      let value = root?.dataset[NEAR_YOU_STRING_DATASETS[key]] || key;
      for (const [name, replacement] of Object.entries(values)) {
        value = value.replaceAll(`{${name}}`, replacement);
      }
      return value;
    };
  }
  if (typeof globalThis.applyStrings !== "function") {
    globalThis.applyStrings = () => {
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        if (node.children.length === 0) node.textContent = globalThis.t(node.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
        node.setAttribute("aria-label", globalThis.t(node.dataset.i18nAria));
      });
    };
  }
}

installNearYouLocalization();

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

async function fetchNearYouDocument(href) {
  const response = await fetch(href, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`near-you-response-${response.status}`);
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  const incoming = next.querySelector("[data-near-you-root]");
  if (!incoming) throw new Error("near-you-document-root-missing");
  return { href: response.url || href, incoming, next };
}

async function adoptDocument(href, { replaceHistory = false } = {}) {
  const prepared = await fetchNearYouDocument(href);
  const { incoming, next } = prepared;
  // Resolve optional synchronization dependencies before committing any page state.
  const placeContext = await import("./place-context.mjs");
  const currentMast = document.querySelector(".document-mast");
  const incomingMast = next.querySelector(".document-mast");
  if (currentMast && incomingMast) currentMast.replaceWith(document.importNode(incomingMast, true));
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
  const updateHistory = replaceHistory ? history.replaceState : history.pushState;
  updateHistory.call(history, { nearYou: true }, "", href);
  placeContext.sync();
  wireIsland();
  root.querySelector("#near-results-heading")?.focus?.({ preventScroll: true });
}

async function adoptMapHashRoute() {
  const hash = location.hash;
  const href = nearYouUrlFromMapHash(hash, { base: `${location.origin}/near-you/` });
  if (!href) return;
  const target = new URL(href, location.href);
  const targetRoute = `${target.pathname}${target.search}`;
  if (`${location.pathname}${location.search}` === targetRoute) {
    history.replaceState(history.state, "", targetRoute);
    return;
  }
  try {
    await adoptDocument(target.toString(), { replaceHistory: true });
  } catch {
    location.assign(target.toString());
  }
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

function areaHref(container, id, baseHref) {
  if (!container || !id) return null;
  const link = container.querySelector(`[data-map-area="${CSS.escape(id)}"]`);
  const href = link?.getAttribute("href");
  return href ? new URL(href, baseHref).toString() : null;
}

async function locationTargetHref(preferred, fallback) {
  const direct = areaHref(root, preferred, location.href);
  if (direct) return direct;
  const boroughHref = areaHref(root, fallback, location.href);
  if (!boroughHref || !preferred) return boroughHref;
  const boroughDocument = await fetchNearYouDocument(boroughHref);
  return areaHref(boroughDocument.incoming, preferred, boroughDocument.href);
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
      let preferred = null;
      let fallback = null;
      let href = null;
      try {
        const response = await fetch(new URL("../data/district_boundaries.json", import.meta.url));
        const layer = response.ok ? await response.json() : null;
        const found = resolveDistricts(coords.latitude, coords.longitude, layer);
        preferred = root.dataset.level === "council_district"
          ? found.council_district
          : found.community_district;
        fallback = boroughFromCommunity(found.community_district);
        href = await locationTargetHref(preferred, fallback);
      } catch {
        status(copy("messageLocationUnmatched"));
        button.disabled = false;
        return;
      }
      if (!href) {
        status(copy("messageLocationUnmatched"));
        button.disabled = false;
        return;
      }
      const district = preferred || fallback;
      try {
        await adoptDocument(href);
        status(copy("messageLocationMatched", { district }));
      } catch {
        status(copy("messageLocationUpdateFailed", { district }));
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

/** Records / Map switch keeps count≡list while map stays optional. */
function wireSurfaceSwitch() {
  const nav = root.querySelector("[data-near-surface-switch]");
  if (!nav || wired.has(nav)) return;
  wired.add(nav);
  if (
    !root.dataset.nearMobileSurface
    && window.matchMedia?.("(max-width: 560px)").matches
  ) root.dataset.nearMobileSurface = "list";
  nav.querySelectorAll("[data-near-surface]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const surface = link.dataset.nearSurface;
      if (surface !== "list" && surface !== "map") return;
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

function nearYouMapStateFromRoot(node) {
  const mapped = MAP_LENSES.includes(node.dataset.lens) && node.dataset.lens !== "all";
  const count = Number(node.querySelector("[data-results-count]")?.dataset.resultsCount);
  const placeDataMissing = [...node.querySelectorAll(".near-coverage")].some((el) =>
    /place data is not available/i.test(el.textContent || "")
  );
  if (!mapped || placeDataMissing) return "unavailable";
  if (Number.isFinite(count) && count > 0) return "content";
  if (Number.isFinite(count)) return "empty";
  return "error";
}

function reportNearYouReadiness() {
  if (!root) return;
  const rum = runtimeRumSemanticMilestones();
  nearYouFrameReady(rum, {
    hasRoot: true,
    hasMapSvg: Boolean(root.querySelector("#nearMapSvg")),
    hasPlaceControls: Boolean(root.querySelector("#near-place-fields")),
  });
  nearYouMapReady(rum, {
    resultState: nearYouMapStateFromRoot(root),
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
  reportNearYouReadiness();
}

if (root) {
  wireIsland();
  addEventListener("hashchange", () => {
    if (location.hash.startsWith("#map")) void adoptMapHashRoute();
  });
  void adoptMapHashRoute();
  addEventListener("popstate", () => location.reload());
}

export { wireIsland as initNearYouMapIsland };
