import {
  appendTraversalHop,
  renderTraversalPath,
  scopeFromTraversalHref,
  stripTraversalPath,
  traversalFromHref,
} from "../traversal_path.mjs";

function clean(value, max = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function currentHref() {
  return stripTraversalPath(location.hash ? location.hash : `${location.pathname}${location.search}`);
}

function ensureStyles() {
  if ([...document.querySelectorAll("link")].some((link) => link.dataset.traversalStyle === "1")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/traversal.css";
  link.dataset.traversalStyle = "1";
  document.head.appendChild(link);
}

function currentNode() {
  const civic = document.querySelector("[data-civic-object-kind]");
  if (civic) {
    const ref = civic.dataset.subjectRef || "";
    const split = ref.indexOf(":");
    return {
      kind: civic.dataset.civicObjectKind || (split > 0 ? ref.slice(0, split) : "record"),
      id: split > 0 ? ref.slice(split + 1) : ref || null,
      name: civic.querySelector("h1")?.textContent || "record",
      href: currentHref(),
    };
  }
  const official = document.querySelector("[data-official-id]");
  if (official) return { kind: "official", id: official.dataset.officialId, name: official.querySelector(".rolename")?.textContent, href: currentHref() };
  const agency = document.querySelector("[data-agency-id]");
  if (agency) return { kind: "agency", id: agency.dataset.agencyId, name: agency.dataset.agencyName || agency.querySelector(".rolename")?.textContent, href: currentHref() };
  const vendor = document.querySelector("[data-vendor-stem]");
  if (vendor) return { kind: "vendor", id: vendor.dataset.vendorStem, name: vendor.querySelector(".rolename")?.textContent, href: currentHref() };
  const browse = document.querySelector("[data-browse-facet]");
  if (browse) return { kind: "browse", id: browse.dataset.browseFacet, name: browse.querySelector(".browse-static-summary")?.textContent || browse.dataset.browseFacet, href: currentHref() };
  const near = document.querySelector("[data-near-you-root]");
  if (near) return { kind: "place", id: near.dataset.level || "near-you", name: near.querySelector("h1")?.textContent || "Place", href: currentHref() };
  return { kind: "record", id: null, name: document.querySelector(["main", "h1"].join(" "))?.textContent || "record", href: currentHref() };
}

function destinationFromLink(link) {
  const target = link.querySelector(".edge-summary-target")?.textContent || link.dataset.pivotTargetName || link.textContent;
  return {
    kind: link.dataset.pivotTargetKind || "record",
    id: link.dataset.pivotTargetId || null,
    name: clean(target || link.dataset.pivotTargetKind || "record"),
    href: link.getAttribute("href") || "",
  };
}

function render() {
  const state = traversalFromHref(location.href);
  const markup = renderTraversalPath(state, { currentHref: currentHref() });
  if (!markup) return;
  const existing = document.querySelector(".traversal-path");
  if (existing) {
    if (existing.outerHTML !== markup) existing.outerHTML = markup;
    return;
  }
  const host = document.querySelector(["[data-near-you-root]", ".near-head"].join(" "))
    || document.querySelector(["#entityview", ">", "div"].join(" "))
    || document.querySelector("#browseview")
    || document.querySelector("main");
  if (!host) return;
  host.insertAdjacentHTML(host.matches("main") ? "afterbegin" : "afterbegin", markup);
}

function install() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.(["a", "[data-pivot-schema]"].join("")) || event.target.closest?.(["a", ".edge-summary-link"].join(""));
    if (!link || link.dataset.pivotStatus === "held" || event.defaultPrevented
      || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      || link.target === "_blank") return;
    const href = link.getAttribute("href");
    if (!href || /^(?:https?:|mailto:)/i.test(href)) return;
    const source = currentNode();
    const destination = destinationFromLink(link);
    const hop = {
      source,
      relation: link.dataset.pivotRelationLabel || link.dataset.relation || "related records",
      destination,
      scope: scopeFromTraversalHref(source.href, window.LANG || "en"),
    };
    const result = appendTraversalHop(href, hop, traversalFromHref(location.href));
    if (!result.href) return;
    event.preventDefault();
    location.assign(result.href);
  });
  addEventListener("hashchange", render);
  addEventListener("popstate", render);
  if (typeof MutationObserver === "function") {
    const target = document.querySelector("#entityview");
    if (target) new MutationObserver(render).observe(target, { childList: true });
  }
  render();
}

globalThis.CrolTraversal = Object.freeze({ render });
if (document.body) { ensureStyles(); install(); }
