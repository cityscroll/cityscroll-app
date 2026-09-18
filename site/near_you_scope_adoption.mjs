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
  ".near-form",
  ".near-coverage",
  ".near-surface-switch",
  ".near-geo-workspace",
  ".near-map-section",
  ".near-records-surface",
  ".near-results",
  ".near-bags",
]);

/** Root dataset keys owned by the server document (not client-only chrome). */
export const NEAR_YOU_SCOPE_ROOT_DATASET_KEYS = Object.freeze([
  "lens",
  "level",
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

function replaceRegion(root, selector, incoming, clone) {
  const current = root.querySelector(selector);
  const replacement = incoming.querySelector(selector);
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
 * Apply a deferred payload only when it still matches the current generation.
 * `parseHtml` must return a single element root for the supplied markup.
 */
export function applyNearYouDeferredPayload(root, payload, {
  generation,
  parseHtml,
} = {}) {
  if (!isNearYouDeferredGenerationCurrent(root, generation)) {
    return { applied: false, reason: "stale_generation" };
  }
  if (
    payload?.schema !== "cityscroll.near_you_deferred.v1"
    || typeof payload.results_html !== "string"
    || typeof payload.bags_html !== "string"
  ) {
    throw new Error("near-you-deferred-payload-invalid");
  }
  const hosts = [...root.querySelectorAll("[data-near-deferred]")];
  if (!hosts.length) {
    return { applied: false, reason: "missing_hosts" };
  }
  for (const host of hosts) {
    const html = host.dataset.nearDeferred === "bags" ? payload.bags_html : payload.results_html;
    const next = parseHtml(html);
    if (!next) throw new Error("near-you-deferred-html-invalid");
    host.replaceWith(next);
  }
  if (!isNearYouDeferredGenerationCurrent(root, generation)) {
    return { applied: false, reason: "stale_generation" };
  }
  root.dataset.nearDeferredState = "ready";
  return { applied: true, reason: "ready" };
}

export function nearYouScopeClientOnlyDatasetKeys() {
  return CLIENT_ONLY_ROOT_KEYS;
}
