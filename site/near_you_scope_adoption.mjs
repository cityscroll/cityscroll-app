/**
 * Atomic Near You scope adoption.
 *
 * A topic or filter change must replace summary, map, form, result, and bag
 * regions together with deferred-request metadata. Searching only for
 * `data-near-deferred` shells fails after those shells resolve, and leaves the
 * prior topic's records beside a newer URL and count.
 */

/** Regions replaced on every successful document adoption. */
export const NEAR_YOU_SCOPE_REGION_SELECTORS = Object.freeze([
  ".near-hero",
  ".near-geo-entry",
  ".near-overview",
  ".near-place-guide",
  ".near-scope",
  ".near-explore",
  ".local-constellation",
  ".near-form",
  ".near-coverage",
  ".near-surface-switch",
  ".near-geo-workspace",
  ".near-map-section",
  ".near-records-surface",
  ".near-results",
  ".near-bags",
  ".near-place-suggestions",
]);

/** Root dataset keys owned by the server document (not client-only chrome). */
export const NEAR_YOU_SCOPE_ROOT_DATASET_KEYS = Object.freeze([
  "lens",
  "level",
  "nearSurface",
  "geographyLayer",
  "nearDataState",
  "nearMapState",
  "nearRecoveryHref",
  "nearDeferredHref",
  "nearDeferredState",
  "messageUpdating",
  "messageUpdated",
  "messageLocationUnavailable",
  "messageLocationFinding",
  "messageLocationMatched",
  "messageLocationUnmatched",
  "messageLocationUpdateFailed",
  "messageLocationDenied",
  "messageLocationTimeout",
  "messageLocationOutside",
  "messageLocationLookupFailed",
  "messageDeferredUnavailable",
  "messageBagsUnavailable",
  "translationAllBoroughs",
  "translationBoroughLabel",
  "translationContextStripLabel",
]);

const CLIENT_ONLY_ROOT_KEYS = Object.freeze([
  "enhanced",
  "nearMobileSurface",
  "nearDeferredGeneration",
]);

/**
 * Reproduce the shell-marker-only deferred adoption defect.
 * Kept as a named fixture so the focused regression can prove the root cause
 * without depending on a live browser timeline.
 */
export function adoptNearYouDeferredShellsOnly(root, incoming, { importNode } = {}) {
  const clone = importNode || ((node) => node.cloneNode(true));
  const currentDeferred = [...root.querySelectorAll("[data-near-deferred]")];
  const incomingDeferred = [...incoming.querySelectorAll("[data-near-deferred]")];
  for (const current of currentDeferred) {
    const replacement = incomingDeferred.find(
      (node) => node.dataset.nearDeferred === current.dataset.nearDeferred,
    );
    if (replacement) current.replaceWith(clone(replacement));
    else current.remove();
  }
  for (const replacement of incomingDeferred) {
    const key = replacement.dataset.nearDeferred || "";
    const present = [...root.querySelectorAll("[data-near-deferred]")]
      .some((node) => node.dataset.nearDeferred === key);
    if (!present) root.append(clone(replacement));
  }
  if (incoming.dataset.lens) root.dataset.lens = incoming.dataset.lens;
  if (incoming.dataset.level) root.dataset.level = incoming.dataset.level;
  root.dataset.nearDeferredState = "pending";
  return root;
}

/**
 * A root region that names itself is adopted by that name, whatever this
 * client's selector list says. The Worker renders Near You documents and
 * deploys ahead of the Pages-served client, so for a while a newer document
 * meets an older client: a region that document adds must still be removed
 * or replaced when the reader moves to a scope that no longer carries it.
 * The selector list above stays for regions that predate the name.
 */
export const NEAR_YOU_SCOPE_REGION_ATTRIBUTE = "data-near-scope-region";

function isNamedRegion(node) {
  return Boolean(node?.hasAttribute?.(NEAR_YOU_SCOPE_REGION_ATTRIBUTE));
}

/** Direct children of a root that name themselves, first one per name. */
function namedRegions(node) {
  const regions = new Map();
  for (const child of Array.from(node?.children || [])) {
    const name = child.getAttribute?.(NEAR_YOU_SCOPE_REGION_ATTRIBUTE);
    if (name && !regions.has(name)) regions.set(name, child);
  }
  return regions;
}

function adoptNamedRegions(root, incoming, clone) {
  const current = namedRegions(root);
  const next = namedRegions(incoming);
  for (const [name, node] of current) {
    const replacement = next.get(name);
    if (replacement) node.replaceWith(clone(replacement));
    else node.remove();
  }
  for (const [name, replacement] of next) {
    if (!current.has(name)) root.append(clone(replacement));
  }
}

function firstUnnamed(node, selector) {
  return Array.from(node.querySelectorAll(selector)).find((match) => !isNamedRegion(match)) || null;
}

function replaceRegion(root, selector, incoming, clone) {
  const current = firstUnnamed(root, selector);
  const replacement = firstUnnamed(incoming, selector);
  if (current && replacement) current.replaceWith(clone(replacement));
  else if (current && !replacement) current.remove();
  else if (!current && replacement) root.append(clone(replacement));
}

/**
 * Adopt one coherent Near You scope from an incoming document root.
 * Returns the deferred generation that must own the next deferred payload.
 */
export function adoptNearYouDocumentScope(root, incoming, { importNode } = {}) {
  if (!root || !incoming) throw new Error("near-you-scope-adoption-missing-root");
  const clone = importNode || ((node) => node.cloneNode(true));

  adoptNamedRegions(root, incoming, clone);
  for (const selector of NEAR_YOU_SCOPE_REGION_SELECTORS) {
    replaceRegion(root, selector, incoming, clone);
  }

  for (const key of NEAR_YOU_SCOPE_ROOT_DATASET_KEYS) {
    const attr = `data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    if (typeof incoming.hasAttribute === "function" && incoming.hasAttribute(attr)) {
      root.dataset[key] = incoming.getAttribute(attr) ?? "";
    } else if (incoming.dataset[key] != null) {
      root.dataset[key] = incoming.dataset[key];
    }
  }

  // Deferred contract becomes pending for the generation-owned hydrate.
  if (typeof incoming.hasAttribute === "function" && incoming.hasAttribute("data-near-deferred-href")) {
    root.dataset.nearDeferredHref = incoming.getAttribute("data-near-deferred-href") ?? "";
  } else if (incoming.dataset.nearDeferredHref != null) {
    root.dataset.nearDeferredHref = incoming.dataset.nearDeferredHref;
  }
  root.dataset.nearDeferredState = incoming.dataset.nearDeferredState || "pending";

  return beginNearYouDeferredGeneration(root);
}

/** Bump the deferred generation so obsolete responses cannot repaint. */
export function beginNearYouDeferredGeneration(root) {
  const next = Number(root.dataset.nearDeferredGeneration || 0) + 1;
  root.dataset.nearDeferredGeneration = String(next);
  return next;
}

export function isNearYouDeferredGenerationCurrent(root, generation) {
  return Number(root.dataset.nearDeferredGeneration || 0) === Number(generation);
}

/**
 * Deferred envelopes that carry section markup. A full or partial success uses
 * the deferred schema; when the requested scope failed but other sections
 * loaded, the error schema carries those sections' markup too. An error
 * envelope without markup is a whole-page failure and is never applied.
 */
export const NEAR_YOU_DEFERRED_MARKUP_SCHEMAS = Object.freeze([
  "cityscroll.near_you_deferred.v1",
  "cityscroll.near_you_deferred_error.v1",
]);

/** A section that could not be read carries this marker until a read succeeds. */
const FAILED_SECTION_SELECTOR = "[data-near-section-state]";

export function nearYouDeferredPayloadHasMarkup(payload) {
  return NEAR_YOU_DEFERRED_MARKUP_SCHEMAS.includes(payload?.schema)
    && typeof payload.results_html === "string"
    && typeof payload.bags_html === "string";
}

function assertDeferredMarkup(payload) {
  if (!nearYouDeferredPayloadHasMarkup(payload)) throw new Error("near-you-deferred-payload-invalid");
}

function settledDeferredState(root) {
  return root.querySelector(FAILED_SECTION_SELECTOR) ? "partial" : "ready";
}

/**
 * Apply a deferred payload only when it still matches the current generation.
 * `parseHtml` must return a single element root for the supplied markup.
 * A partial payload leaves each failed section explicit; the root state is then
 * "partial" rather than "ready".
 */
export function applyNearYouDeferredPayload(root, payload, {
  generation,
  parseHtml,
} = {}) {
  if (!isNearYouDeferredGenerationCurrent(root, generation)) {
    return { applied: false, reason: "stale_generation" };
  }
  assertDeferredMarkup(payload);
  const hosts = [...root.querySelectorAll("[data-near-deferred]")];
  if (!hosts.length) {
    return { applied: false, reason: "missing_hosts" };
  }
  for (const host of hosts) {
    const html = host.dataset.nearDeferred === "bags" ? payload.bags_html : payload.results_html;
    // No special collection is published for this scope: nothing to show, not a zero.
    if (host.dataset.nearDeferred === "bags" && html === "") {
      host.remove();
      continue;
    }
    const next = parseHtml(html);
    if (!next) throw new Error("near-you-deferred-html-invalid");
    host.replaceWith(next);
  }
  // Optional overview summary refreshes beside results when the payload carries it.
  if (typeof payload.overview_html === "string") {
    const currentOverview = root.querySelector(".near-overview");
    if (payload.overview_html === "") {
      currentOverview?.remove();
    } else {
      const nextOverview = parseHtml(payload.overview_html);
      if (nextOverview) {
        if (currentOverview) currentOverview.replaceWith(nextOverview);
        else {
          // Match SSR order: after the surface switch, before the geo workspace.
          const surface = root.querySelector(".near-surface-switch");
          const geo = root.querySelector(".near-geo-workspace");
          const records = root.querySelector(".near-records-surface");
          if (surface) surface.insertAdjacentElement("afterend", nextOverview);
          else if (geo) geo.insertAdjacentElement("beforebegin", nextOverview);
          else if (records) records.insertAdjacentElement("beforebegin", nextOverview);
          else root.append(nextOverview);
        }
      }
    }
  }
  if (!isNearYouDeferredGenerationCurrent(root, generation)) {
    return { applied: false, reason: "stale_generation" };
  }
  const state = settledDeferredState(root);
  root.dataset.nearDeferredState = state;
  return { applied: true, reason: state, partial: state === "partial" };
}

/**
 * Retry only the sections that failed. A section that loaded stays in place
 * (its records, focus and scroll are untouched); a failed section is replaced
 * only by a replacement that loaded, so a retry that fails again keeps the
 * explicit failure. The generation guard drops a retry that a newer place or
 * scope has overtaken.
 */
export function applyNearYouSectionRetry(root, payload, {
  generation,
  parseHtml,
} = {}) {
  if (!isNearYouDeferredGenerationCurrent(root, generation)) {
    return { applied: false, reason: "stale_generation", replaced: [] };
  }
  assertDeferredMarkup(payload);
  const incomingResults = parseHtml(payload.results_html);
  const incomingBags = parseHtml(payload.bags_html);
  if (!incomingResults || !incomingBags) throw new Error("near-you-deferred-html-invalid");
  const replaced = [];
  for (const current of [...root.querySelectorAll(FAILED_SECTION_SELECTOR)]) {
    const bag = current.dataset.bag;
    const name = bag || (current.matches(".near-results") ? "primary" : null);
    if (!name) continue;
    const replacement = bag
      ? incomingBags.querySelector(`[data-bag="${bag}"]`)
      : incomingResults;
    if (!replacement || replacement.hasAttribute("data-near-section-state")) continue;
    if (bag && current.hasAttribute("open")) replacement.setAttribute("open", "");
    current.replaceWith(replacement);
    replaced.push(name);
  }
  const state = settledDeferredState(root);
  root.dataset.nearDeferredState = state;
  return { applied: replaced.length > 0, reason: replaced.length ? state : "still_unavailable", replaced };
}

export function nearYouScopeClientOnlyDatasetKeys() {
  return CLIENT_ONLY_ROOT_KEYS;
}
