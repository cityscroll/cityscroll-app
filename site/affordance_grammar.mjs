/** Shared CityScroll link/control grammar. Keep these primitives presentation-neutral. */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dataAttributes(attributes, escape) {
  return Object.entries(attributes || {}).map(([name, value]) => {
    if (!/^data-[a-z0-9-]+$/.test(name) || value == null) return "";
    return ` ${name}="${escape(value)}"`;
  }).join("");
}

const AFFORDANCE_CANONICAL_ORIGIN = "https://cityscroll.org";
const AFFORDANCE_OWNED_HOSTS = new Set([
  "cityscroll.org",
  "www.cityscroll.org",
  "api.cityscroll.org",
  "crol-list.org",
  "www.crol-list.org",
  "api.crol-list.org",
]);
const AFFORDANCE_NAVIGATION_ONLY_ACTION_KINDS = new Set([
  "calendar",
  "copy",
  "export",
  "navigation",
  "open",
  "print",
  "qr",
  "watch",
]);

function affordanceText(value) {
  return String(value ?? "").trim();
}

function affordanceDestinationKind(href, canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN) {
  const value = affordanceText(href);
  if (!value) return "missing";
  if (/^(?:mailto|tel):/i.test(value)) return "protocol_handoff";
  if (/^(?:#|\/|\.|\?)/.test(value)) return "internal";
  let url;
  try { url = new URL(value, canonicalOrigin); }
  catch { return "missing"; }
  if (!/^https?:$/.test(url.protocol)) return "protocol_handoff";
  return AFFORDANCE_OWNED_HOSTS.has(url.hostname.toLowerCase()) ? "internal" : "external";
}

function affordanceCanonicalTargetUrl(href, canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN) {
  if (affordanceDestinationKind(href, canonicalOrigin) !== "internal") return null;
  try { return new URL(affordanceText(href), canonicalOrigin).href; }
  catch { return null; }
}

function normalizeAffordanceTarget(target, canonicalOrigin) {
  const href = affordanceText(target?.href);
  const label = affordanceText(target?.label);
  if (!href || !label || affordanceDestinationKind(href, canonicalOrigin) !== "internal") return null;
  return Object.freeze({ href, label, current: target?.current === true });
}

function normalizeAffordanceRelation(relation, canonicalOrigin) {
  const label = affordanceText(relation?.label);
  if (!label) return null;
  const href = affordanceText(relation?.href);
  const verified = relation?.verified === true && affordanceDestinationKind(href, canonicalOrigin) === "internal";
  return Object.freeze({
    label,
    href: verified ? href : null,
    verified,
  });
}

function normalizeAffordanceHandoff(handoff, canonicalOrigin) {
  const label = affordanceText(handoff?.label);
  const href = affordanceText(handoff?.href);
  const kind = affordanceDestinationKind(href, canonicalOrigin);
  if (!label || !href || !["external", "protocol_handoff"].includes(kind)) return null;
  return Object.freeze({
    label,
    href,
    kind: affordanceText(handoff?.kind) || "handoff",
    primary: handoff?.primary === true,
  });
}

function normalizeAffordanceKineticAction(action, canonicalOrigin) {
  const label = affordanceText(action?.label);
  const href = affordanceText(action?.href || action?.destination);
  const kind = affordanceText(action?.kind || action?.type).toLowerCase();
  if (!label || !href || !kind || action?.context_ready !== true || AFFORDANCE_NAVIGATION_ONLY_ACTION_KINDS.has(kind)) return null;
  if (affordanceDestinationKind(href, canonicalOrigin) === "missing") return null;
  return Object.freeze({
    label,
    href,
    kind: kind || "kinetic",
    primary: action?.primary !== false,
    attributes: action?.attributes && typeof action.attributes === "object"
      ? Object.freeze({ ...action.attributes })
      : Object.freeze({}),
  });
}

/**
 * Normalize producer-owned evidence into the shared object-card interaction grammar.
 * Producers decide whether a relation is verified and whether an action/guide is ready;
 * this projection owns the stable presentation boundary used by card renderers.
 */
export function objectCardInteractionProjection({
  target,
  relations = [],
  external_handoffs = [],
  kinetic_actions = [],
  guide = null,
  canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN,
} = {}) {
  const normalized = normalizeAffordanceTarget(target, canonicalOrigin);
  const projectedGuide = guide?.context_ready === true && guide?.source_backed === true && affordanceText(guide?.html)
    ? Object.freeze({ html: String(guide.html) })
    : null;
  return Object.freeze({
    target: normalized,
    relations: Object.freeze((Array.isArray(relations) ? relations : []).map((relation) => normalizeAffordanceRelation(relation, canonicalOrigin)).filter(Boolean)),
    external_handoffs: Object.freeze((Array.isArray(external_handoffs) ? external_handoffs : []).map((handoff) => normalizeAffordanceHandoff(handoff, canonicalOrigin)).filter(Boolean)),
    copy_target: normalized ? affordanceCanonicalTargetUrl(normalized.href, canonicalOrigin) : null,
    kinetic_actions: Object.freeze(normalized
      ? (Array.isArray(kinetic_actions) ? kinetic_actions : []).map((action) => normalizeAffordanceKineticAction(action, canonicalOrigin)).filter(Boolean)
      : []),
    guide: projectedGuide,
  });
}

/** Internal graph travel: same-tab, blue, solid underline, leading node glyph. */
export function constellationLink({ href, label, labelMarkup = null, count = null, className = "", current = false, attributes = {}, escape = esc } = {}) {
  const countMarkup = count == null ? "" : `<span class="ct">${escape(count)}</span>`;
  const renderedLabel = labelMarkup == null ? escape(label) : String(labelMarkup);
  return `<a class="ui-constellation-link${className ? ` ${escape(className)}` : ""}" href="${escape(href)}"${current ? ' aria-current="page"' : ""}${dataAttributes(attributes, escape)}><span aria-hidden="true">◆</span>${renderedLabel}${countMarkup}</a>`;
}

/** Authoritative external record: new tab, neutral dotted underline, trailing arrow. */
export function officialSourceLink({
  href,
  label,
  className = "",
  attributes = {},
  escape = esc,
  newTabLabel = "",
} = {}) {
  const announcement = newTabLabel ? `<span class="sr-only"> ${escape(newTabLabel)}</span>` : "";
  return `<a class="ui-official-source-link${className ? ` ${escape(className)}` : ""}" href="${escape(href)}" target="_blank" rel="noopener noreferrer"${dataAttributes(attributes, escape)}>${escape(label)}<span aria-hidden="true">↗</span>${announcement}</a>`;
}

/** Kinetic off-site handoff: visible arrow plus accessible new-tab disclosure. */
export function externalActionLink({
  href,
  label,
  primary = false,
  className = "",
  attributes = {},
  escape = esc,
  canonicalOrigin = AFFORDANCE_CANONICAL_ORIGIN,
  newTabLabel = "(opens in new tab)",
} = {}) {
  const kind = affordanceDestinationKind(href, canonicalOrigin);
  if (kind === "missing") return "";
  const classes = [kind === "internal" ? "ui-action-link" : "ui-external-action", primary ? "primary" : "", className]
    .filter(Boolean).map((value) => escape(value)).join(" ");
  const external = kind === "external";
  const handoff = external || kind === "protocol_handoff";
  const tabAttrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
  const glyph = handoff ? '<span aria-hidden="true">↗</span>' : "";
  const announcement = external ? `<span class="sr-only"> ${escape(newTabLabel)}</span>` : "";
  return `<a class="${classes}" href="${escape(href)}"${tabAttrs}${dataAttributes(attributes, escape)}>${escape(label)}${glyph}${announcement}</a>`;
}

export function renderObjectCardTitle(projection, { className = "ui-object-card-title", labelMarkup = null, escape = esc } = {}) {
  if (!projection?.target) return "";
  return constellationLink({
    href: projection.target.href,
    label: projection.target.label,
    labelMarkup,
    current: projection.target.current,
    className,
    escape,
  });
}

export function renderObjectCardCopy(projection, {
  className = "ui-object-card-copy",
  label = "Copy link",
  attributes = {},
  escape = esc,
} = {}) {
  if (!projection?.copy_target) return "";
  return `<button type="button" class="${escape(className)}" data-object-card-copy="${escape(projection.copy_target)}" aria-live="polite"${dataAttributes(attributes, escape)}>${escape(label)}</button>`;
}

export function renderObjectCardRelations(projection, { escape = esc } = {}) {
  const relations = (projection?.relations || []).map((relation) => relation.verified
    ? constellationLink({ href: relation.href, label: relation.label, className: "ui-object-card-relation", escape })
    : staticFact({ label: relation.label, className: "ui-object-card-relation-unresolved", escape }));
  return relations.length ? `<div class="ui-object-card-relations">${relations.join("")}</div>` : "";
}

export function renderObjectCardActionRail(projection, {
  heading = "What can I do now?",
  escape = esc,
  newTabLabel = "(opens in new tab)",
} = {}) {
  const actions = (projection?.kinetic_actions || []).map((action) => externalActionLink({
    href: action.href,
    label: action.label,
    primary: action.primary,
    attributes: action.attributes,
    escape,
    newTabLabel,
  }));
  if (!actions.length && !projection?.guide) return "";
  return `<section class="ui-object-card-action-rail"><h3>${escape(heading)}</h3>${actions.length ? `<div class="ui-object-card-action-list">${actions.join("")}</div>` : ""}${projection?.guide?.html || ""}</section>`;
}

/** Render the shared primitives as a fragment; the owning row remains a non-anchor selector. */
export function renderObjectCardPrimitives(projection, {
  escape = esc,
  titleMarkup = null,
  titleClassName = "ui-object-card-title",
  copyLabel = "Copy link",
  actionHeading = "What can I do now?",
  newTabLabel = "(opens in new tab)",
} = {}) {
  if (!projection?.target) return "";
  const handoffs = (projection.external_handoffs || []).map((handoff) => handoff.kind === "official_source"
    ? officialSourceLink({ href: handoff.href, label: handoff.label, escape })
    : externalActionLink({ href: handoff.href, label: handoff.label, primary: handoff.primary, escape }));
  return `<div class="ui-object-card-interactions"><div class="ui-object-card-primary">${renderObjectCardTitle(projection, { escape, labelMarkup: titleMarkup, className: titleClassName })}${renderObjectCardCopy(projection, { escape, label: copyLabel })}</div>${renderObjectCardRelations(projection, { escape })}${handoffs.length ? `<div class="ui-object-card-handoffs">${handoffs.join("")}</div>` : ""}${renderObjectCardActionRail(projection, { escape, heading: actionHeading, newTabLabel })}</div>`;
}

/** Copy one projected canonical URL and expose the result through the focused button. */
export async function copyObjectCardCanonicalUrl(button, {
  writeText = null,
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
  successLabel = "Copied ✓",
  failureLabel = "Copy failed",
} = {}) {
  const value = affordanceText(button?.dataset?.objectCardCopy);
  if (!button || !value) return false;
  button.setAttribute?.("aria-live", "polite");
  let copied = false;
  try {
    if (writeText) await writeText(value);
    else if (navigatorRef?.clipboard?.writeText) await navigatorRef.clipboard.writeText(value);
    else {
      const textarea = documentRef?.createElement?.("textarea");
      if (!textarea) throw new Error("clipboard unavailable");
      textarea.value = value;
      documentRef.body.appendChild(textarea);
      textarea.select();
      copied = documentRef.execCommand?.("copy") === true;
      textarea.remove();
      if (!copied) throw new Error("copy command failed");
    }
    copied = true;
  } catch {
    copied = false;
  }
  const resultLabel = copied ? successLabel : failureLabel;
  button.textContent = typeof resultLabel === "function" ? resultLabel() : resultLabel;
  return copied;
}

const copyRoots = new WeakSet();

/** Delegated binding covers both static first paint and later hydrated cards. */
export function installObjectCardCopyLinks(root = globalThis.document, options = {}) {
  if (!root?.addEventListener || copyRoots.has(root)) return;
  copyRoots.add(root);
  root.addEventListener("click", (event) => {
    const button = event?.target?.closest?.("[data-object-card-copy]");
    if (!button || (root !== globalThis.document && !root.contains?.(button))) return;
    copyObjectCardCanonicalUrl(button, options);
  });
}

/** Keep repeated official links available without making them the object's visual rhythm. */
export function officialSourceDisclosure({ items = [], label = "Open official sources", className = "", escape = esc } = {}) {
  const seen = new Set();
  const links = (Array.isArray(items) ? items : []).map((item) => {
    const href = String(item?.href || "").trim();
    const text = String(item?.label || "").trim();
    if (!href || !text || seen.has(href)) return "";
    seen.add(href);
    return `<li>${officialSourceLink({ href, label: text, className: "node-source-link", escape })}</li>`;
  }).filter(Boolean);
  if (!links.length) return "";
  return `<details class="node-source-disclosure${className ? ` ${escape(className)}` : ""}"><summary class="node-action">${escape(label)}</summary><ul>${links.join("")}</ul></details>`;
}

/** View-changing control: pill button with aria-pressed; deliberately not a link. */
export function filterChip({ label, count = null, pressed = false, className = "", attributes = {}, escape = esc } = {}) {
  const countMarkup = count == null ? "" : `<span class="ct">${escape(count)}</span>`;
  return `<button type="button" class="ui-filter-chip${className ? ` ${escape(className)}` : ""}" aria-pressed="${pressed ? "true" : "false"}"${dataAttributes(attributes, escape)}>${escape(label)}${countMarkup}</button>`;
}

/** Non-interactive information: plain semantic text with no link affordance. */
export function staticFact({ label, count = null, className = "", escape = esc } = {}) {
  const countMarkup = count == null ? "" : `<span class="ct">${escape(count)}</span>`;
  return `<span class="ui-static-fact${className ? ` ${escape(className)}` : ""}">${escape(label)}${countMarkup}</span>`;
}

/** Install navigation behavior for filter buttons carrying their shareable destination. */
export function installFilterChipNavigation(root = globalThis.document, locationRef = globalThis.location) {
  if (!root?.querySelectorAll || !locationRef) return;
  root.querySelectorAll(".ui-filter-chip[data-filter-href]").forEach((button) => {
    if (button.dataset.filterNavigationInstalled === "true") return;
    button.dataset.filterNavigationInstalled = "true";
    button.addEventListener("click", () => {
      const href = button.getAttribute("data-filter-href");
      if (href) locationRef.assign(href);
    });
  });
}
